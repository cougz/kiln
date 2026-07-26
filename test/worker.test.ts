import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import worker from "../src/index";
import type { Env } from "../src/index";
import { ensureDatabaseSchema } from "../src/schema";

interface TestEnv extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const LEGACY_PROJECT = "legacy-project";
const LEGACY_BUILD = "legacy-build";

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.slice(0, 2));
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO project (id, slug, name) VALUES ('legacy-project-id', ?, 'Legacy project')",
    ).bind(LEGACY_PROJECT),
    testEnv.DB.prepare(
      `INSERT INTO build
         (id, project_id, source_version, params_json, status, r2_prefix, finished_at)
       VALUES (?, 'legacy-project-id', 1, '{}', 'verified', 'legacy/archive/', datetime('now'))`,
    ).bind(LEGACY_BUILD),
  ]);
  await ensureDatabaseSchema(testEnv);
});

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://kiln.example${path}`, init),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function mcpJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  const data = text.startsWith("event:")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
    : text;
  return JSON.parse(data) as Record<string, any>;
}

describe("runtime schema gate", () => {
  it("applies and records the provenance migration", async () => {
    const migration = await testEnv.DB.prepare(
      "SELECT name FROM d1_migrations WHERE name = '0003_build_provenance.sql'",
    ).first<{ name: string }>();
    expect(migration?.name).toBe("0003_build_provenance.sql");
    const columns = await testEnv.DB.prepare("PRAGMA table_info(build)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("archive_status");

    const response = await fetchWorker(`/api/projects/${LEGACY_PROJECT}/builds/${LEGACY_BUILD}`);
    expect(response.status).toBe(200);
    const build = await response.json<Record<string, unknown>>();
    expect(build.archive_status).toBe("legacy");
    expect(build.provenance_status).toBe("legacy_unavailable");
    expect(build.entry).toBeNull();
  });
});

describe("discovery", () => {
  it("serves valid registry metadata", async () => {
    const response = await fetchWorker("/server.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.json<Record<string, unknown>>();
    expect(body.name).toBe("io.github.cougz/kiln");
    expect(body.version).toBe("0.3.0");
  });

  it("negotiates homepage Markdown before static assets", async () => {
    const response = await fetchWorker("/", { headers: { Accept: "text/markdown" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("link")).toContain("/.well-known/api-catalog");
    expect(await response.text()).toContain("# kiln");
  });

  it("marks old server-card paths as compatibility aliases", async () => {
    const response = await fetchWorker("/.well-known/mcp/server-card.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("deprecation")).toBe("true");
    expect(response.headers.get("content-location")).toBe("/server.json");
  });
});

describe("MCP transport guardrails", () => {
  it("rejects an untrusted browser Origin", async () => {
    const response = await fetchWorker("/mcp", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects an explicit unsupported protocol version", async () => {
    const response = await fetchWorker("/mcp", {
      method: "POST",
      headers: {
        Origin: "https://kiln.example",
        "MCP-Protocol-Version": "not-a-version",
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unsupported MCP-Protocol-Version");
  });

  it("answers an allowed CORS preflight", async () => {
    const response = await fetchWorker("/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://kiln.example" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://kiln.example");
  });

  it("rejects JSON-RPC batches", async () => {
    const response = await fetchWorker("/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("one JSON-RPC message");
  });

  it("checks authorization on every protected tool request", async () => {
    const commonHeaders = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    const initialized = await fetchWorker("/mcp", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "kiln-auth-test", version: "1.0.0" },
        },
      }),
    });
    const session = initialized.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    await fetchWorker("/mcp", {
      method: "POST",
      headers: { ...commonHeaders, "MCP-Session-Id": session! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const slug = `mcp-${crypto.randomUUID().slice(0, 12)}`;
    const toolCall = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_project", arguments: { slug } },
    });
    const denied = await fetchWorker("/mcp", {
      method: "POST",
      headers: { ...commonHeaders, "MCP-Session-Id": session! },
      body: toolCall,
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");

    const allowed = await fetchWorker("/mcp", {
      method: "POST",
      headers: {
        ...commonHeaders,
        Authorization: "Bearer test-api-key",
        "MCP-Session-Id": session!,
      },
      body: toolCall,
    });
    expect(allowed.status).toBe(200);
    expect((await mcpJson(allowed)).result.structuredContent.ok).toBe(true);

    const revoked = await fetchWorker("/mcp", {
      method: "POST",
      headers: { ...commonHeaders, "MCP-Session-Id": session! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "update_project", arguments: { slug, description: "must not change" } },
      }),
    });
    expect(revoked.status).toBe(401);
  });

  it("advertises typed tools, resources, and prompts", async () => {
    const commonHeaders = {
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    };
    const initialized = await fetchWorker("/mcp", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "kiln-test", version: "1.0.0" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    const session = initialized.headers.get("mcp-session-id");
    expect(session).toBeTruthy();

    const initializedNotification = await fetchWorker("/mcp", {
      method: "POST",
      headers: { ...commonHeaders, "MCP-Session-Id": session! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initializedNotification.status).toBe(202);

    const list = async (id: number, method: string) => {
      const response = await fetchWorker("/mcp", {
        method: "POST",
        headers: { ...commonHeaders, "MCP-Session-Id": session! },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
      });
      expect(response.status).toBe(200);
      return mcpJson(response);
    };
    const tools = await list(2, "tools/list");
    expect(tools.result.tools).toHaveLength(20);
    expect(tools.result.tools.every((tool: Record<string, unknown>) => tool.outputSchema && tool.annotations)).toBe(true);

    const resources = await list(3, "resources/templates/list");
    expect(resources.result.resourceTemplates).toHaveLength(5);
    const prompts = await list(4, "prompts/list");
    expect(prompts.result.prompts).toHaveLength(1);

    const closed = await fetchWorker("/mcp", {
      method: "DELETE",
      headers: { ...commonHeaders, "MCP-Session-Id": session! },
    });
    expect(closed.status).toBe(204);
  });
});

describe("REST authorization and validation", () => {
  it("keeps reads public and writes protected", async () => {
    const list = await fetchWorker("/api/projects");
    expect(list.status).toBe(200);

    const denied = await fetchWorker("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "unauthorized-project" }),
    });
    expect(denied.status).toBe(401);
    expect((await denied.json<{ code: string }>()).code).toBe("AUTH_REQUIRED");
  });

  it("creates, updates, versions, and reads source history", async () => {
    const slug = `test-${crypto.randomUUID().slice(0, 12)}`;
    const authHeaders = {
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    };
    const created = await fetchWorker("/api/projects", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug, name: "Worker test" }),
    });
    expect(created.status).toBe(201);

    const updated = await fetchWorker(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ description: "Public test project" }),
    });
    expect(updated.status).toBe(200);

    const source = { path: "build.py", content: "print('bounded')\n" };
    const first = await fetchWorker(`/api/projects/${slug}/source`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(source),
    });
    expect(first.status).toBe(200);
    expect((await first.json<{ deduplicated: boolean }>()).deduplicated).toBe(false);

    const duplicate = await fetchWorker(`/api/projects/${slug}/source`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(source),
    });
    expect((await duplicate.json<{ deduplicated: boolean }>()).deduplicated).toBe(true);

    const history = await fetchWorker(`/api/projects/${slug}/source/build.py?history=1&limit=10`);
    expect(history.status).toBe(200);
    const historyBody = await history.json<{ versions: unknown[] }>();
    expect(historyBody.versions).toHaveLength(1);

    const reservedPath = { path: "lib/history", content: "VALUE = 1\n" };
    await fetchWorker(`/api/projects/${slug}/source`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(reservedPath),
    });
    const reserved = await fetchWorker(`/api/projects/${slug}/source/lib/history`);
    expect(reserved.status).toBe(200);
    expect((await reserved.json<{ content: string }>()).content).toBe(reservedPath.content);
  });

  it("rejects invalid params.json through the general source endpoint", async () => {
    const slug = `params-${crypto.randomUUID().slice(0, 12)}`;
    const authHeaders = {
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    };
    await fetchWorker("/api/projects", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug }),
    });
    const invalid = await fetchWorker(`/api/projects/${slug}/source`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ path: "params.json", content: "[]\n" }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json<{ code: string }>()).code).toBe("INVALID_PARAMS");
  });

  it("enforces the source-file quota atomically", async () => {
    const slug = `quota-${crypto.randomUUID().slice(0, 12)}`;
    const authHeaders = {
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    };
    const created = await fetchWorker("/api/projects", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug }),
    });
    const projectId = (await created.json<{ id: string }>()).id;
    await testEnv.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 127
       )
       INSERT INTO source (project_id, path, version, content, sha256, byte_size)
       SELECT ?, printf('file-%03d.py', n), 1, 'x', NULL, 1 FROM numbers`,
    ).bind(projectId).run();

    const responses = await Promise.all(["one.py", "two.py"].map((path) => fetchWorker(
      `/api/projects/${slug}/source`,
      {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ path, content: "x\n" }),
      },
    )));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const count = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM source s
       WHERE project_id = ? AND version = (
         SELECT MAX(version) FROM source WHERE project_id = s.project_id AND path = s.path
       )`,
    ).bind(projectId).first<{ count: number }>();
    expect(count?.count).toBe(128);
  });

  it("returns 405 and an Allow header for unsupported methods", async () => {
    const response = await fetchWorker("/api/projects", { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});
