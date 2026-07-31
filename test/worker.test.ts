import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/index";
import type { Env } from "../src/index";
import { ensureDatabaseSchema } from "../src/schema";

interface TestEnv extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestEnv;
const LEGACY_PROJECT = "legacy-project";
const LEGACY_BUILD = "legacy-build";
const ACCESS_ISSUER = "https://kiln-team.cloudflareaccess.com";
const ACCESS_AUDIENCE = "test-access-audience";
const ACCESS_BINDINGS: Partial<Env> = {
  CF_ACCESS_TEAM_DOMAIN: ACCESS_ISSUER,
  CF_ACCESS_AUD: ACCESS_AUDIENCE,
  KILN_API_KEY: undefined,
};
let accessAssertion = "";

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "kiln-test-key";
  publicJwk.alg = "RS256";
  accessAssertion = await new SignJWT({ type: "app", email: "maker@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject("access-user-id")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [publicJwk] });
    }
    return originalFetch(input, init);
  }));

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

afterAll(() => {
  vi.unstubAllGlobals();
});

async function fetchWorker(
  path: string,
  init?: RequestInit,
  bindings?: Partial<Env>,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://kiln.example${path}`, init),
    bindings ? Object.assign({}, testEnv, bindings) : testEnv,
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
        "Cf-Access-Jwt-Assertion": accessAssertion,
        "MCP-Session-Id": session!,
      },
      body: toolCall,
    }, ACCESS_BINDINGS);
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
  it("uses a validated Cloudflare Access identity for browser sessions and writes", async () => {
    const accessHeaders = { "Cf-Access-Jwt-Assertion": accessAssertion };
    const session = await fetchWorker("/api/session", { headers: accessHeaders }, ACCESS_BINDINGS);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({
      authenticated: true,
      identity: { method: "access", email: "maker@example.com" },
      permissions: { mutate: true, compute: true },
    });

    const slug = `access-${crypto.randomUUID().slice(0, 12)}`;
    const created = await fetchWorker("/api/projects", {
      method: "POST",
      headers: {
        ...accessHeaders,
        "Content-Type": "application/json",
        Origin: "https://kiln.example",
      },
      body: JSON.stringify({ slug }),
    }, ACCESS_BINDINGS);
    expect(created.status).toBe(201);

    const crossOrigin = await fetchWorker("/api/projects", {
      method: "POST",
      headers: {
        ...accessHeaders,
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ slug: `${slug}-blocked` }),
    }, ACCESS_BINDINGS);
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json<{ code: string }>()).code).toBe("CROSS_ORIGIN_WRITE_FORBIDDEN");
  });

  it("rejects an Access assertion with the wrong application audience", async () => {
    const response = await fetchWorker("/api/session", {
      headers: { "Cf-Access-Jwt-Assertion": accessAssertion },
    }, {
      CF_ACCESS_TEAM_DOMAIN: ACCESS_ISSUER,
      CF_ACCESS_AUD: "another-application",
      KILN_API_KEY: undefined,
    });
    expect(response.status).toBe(200);
    expect((await response.json<{ authenticated: boolean }>()).authenticated).toBe(false);
  });

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
