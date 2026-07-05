import { getContainer } from "@cloudflare/containers";
import type { Env } from "./index";

/** REST core (P1). MCP tools (P2) will wrap these same operations.
 *
 *  POST /api/projects                        {slug, name, description?}
 *  GET  /api/projects
 *  GET  /api/projects/:slug
 *  PUT  /api/projects/:slug/source           {path, content}
 *  GET  /api/projects/:slug/source/:path     latest version
 *  POST /api/projects/:slug/builds           {entry?, timeout_s?} → runs now
 *  GET  /api/projects/:slug/builds
 *  GET  /api/projects/:slug/builds/:n
 *  GET  /api/projects/:slug/builds/:n/artifacts/<path>
 */

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (detail: string, status = 400) => json({ error: detail }, status);

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
}

async function getProject(env: Env, slug: string): Promise<ProjectRow | null> {
  return env.DB.prepare("SELECT id, slug, name, description FROM project WHERE slug = ?")
    .bind(slug)
    .first<ProjectRow>();
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const seg = url.pathname.split("/").filter(Boolean); // ["api","projects",...]

  if (seg[1] !== "projects") return bad("not found", 404);

  // /api/projects
  if (seg.length === 2) {
    if (req.method === "POST") {
      const body = await req.json<{ slug?: string; name?: string; description?: string }>();
      if (!body.slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(body.slug)) {
        return bad("slug required: lowercase alphanumeric + dashes");
      }
      const id = crypto.randomUUID().slice(0, 12);
      try {
        await env.DB.prepare(
          "INSERT INTO project (id, slug, name, description) VALUES (?, ?, ?, ?)",
        )
          .bind(id, body.slug, body.name ?? body.slug, body.description ?? "")
          .run();
      } catch {
        return bad(`slug '${body.slug}' already exists`, 409);
      }
      return json({ id, slug: body.slug }, 201);
    }
    const rows = await env.DB.prepare(
      "SELECT slug, name, description, created_at FROM project ORDER BY created_at DESC",
    ).all();
    return json(rows.results);
  }

  const project = await getProject(env, seg[2]);
  if (!project) return bad(`no project '${seg[2]}'`, 404);

  // /api/projects/:slug
  if (seg.length === 3) {
    const builds = await env.DB.prepare(
      "SELECT id, status, created_at FROM build WHERE project_id = ? ORDER BY created_at DESC LIMIT 10",
    )
      .bind(project.id)
      .all();
    const sources = await env.DB.prepare(
      "SELECT path, MAX(version) AS version FROM source WHERE project_id = ? GROUP BY path",
    )
      .bind(project.id)
      .all();
    return json({ ...project, sources: sources.results, recent_builds: builds.results });
  }

  // /api/projects/:slug/source[/:path]
  if (seg[3] === "source") {
    if (req.method === "PUT") {
      const body = await req.json<{ path?: string; content?: string }>();
      if (!body.path || body.content === undefined) return bad("path and content required");
      if (body.path.includes("..") || body.path.startsWith("/")) return bad("unsafe path");
      const prev = await env.DB.prepare(
        "SELECT MAX(version) AS v FROM source WHERE project_id = ? AND path = ?",
      )
        .bind(project.id, body.path)
        .first<{ v: number | null }>();
      const version = (prev?.v ?? 0) + 1;
      await env.DB.prepare(
        "INSERT INTO source (project_id, path, version, content) VALUES (?, ?, ?, ?)",
      )
        .bind(project.id, body.path, version, body.content)
        .run();
      return json({ path: body.path, version });
    }
    const path = seg.slice(4).join("/");
    if (!path) return bad("source path required");
    const row = await env.DB.prepare(
      "SELECT content, version FROM source WHERE project_id = ? AND path = ? ORDER BY version DESC LIMIT 1",
    )
      .bind(project.id, path)
      .first<{ content: string; version: number }>();
    if (!row) return bad("no such source", 404);
    return json(row);
  }

  // /api/projects/:slug/builds...
  if (seg[3] === "builds") {
    if (seg.length === 4 && req.method === "POST") return runBuild(req, env, project);
    if (seg.length === 4) {
      const rows = await env.DB.prepare(
        "SELECT id, source_version, status, created_at, finished_at FROM build WHERE project_id = ? ORDER BY created_at DESC",
      )
        .bind(project.id)
        .all();
      return json(rows.results);
    }
    const build = await env.DB.prepare(
      "SELECT * FROM build WHERE project_id = ? AND id = ?",
    )
      .bind(project.id, seg[4])
      .first<Record<string, unknown>>();
    if (!build) return bad("no such build", 404);

    if (seg.length === 5) {
      return json({ ...build, report_json: JSON.parse((build.report_json as string) ?? "null") });
    }
    if (seg[5] === "artifacts") {
      const key = `${build.r2_prefix}${seg.slice(6).join("/")}`;
      const obj = await env.ARTIFACTS.get(key);
      if (!obj) return bad("no such artifact", 404);
      return new Response(obj.body, {
        headers: { "content-type": contentType(key) },
      });
    }
  }

  return bad("not found", 404);
}

function contentType(key: string): string {
  if (key.endsWith(".stl")) return "model/stl";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function runBuild(req: Request, env: Env, project: ProjectRow): Promise<Response> {
  const body = await req
    .json<{ entry?: string; timeout_s?: number }>()
    .catch(() => ({}) as { entry?: string; timeout_s?: number });
  const entry = body.entry ?? "build.py";

  // latest version of every source file
  const sources = await env.DB.prepare(
    `SELECT s.path, s.content, s.version FROM source s
     JOIN (SELECT path, MAX(version) AS v FROM source WHERE project_id = ? GROUP BY path) m
       ON s.path = m.path AND s.version = m.v
     WHERE s.project_id = ?`,
  )
    .bind(project.id, project.id)
    .all<{ path: string; content: string; version: number }>();
  if (!sources.results.length) return bad("project has no sources — PUT source first");

  const sourceVersion = Math.max(...sources.results.map((s) => s.version));
  const buildId = crypto.randomUUID().slice(0, 12);
  const r2Prefix = `projects/${project.id}/builds/${buildId}/`;
  await env.DB.prepare(
    "INSERT INTO build (id, project_id, source_version, status, r2_prefix) VALUES (?, ?, ?, 'running', ?)",
  )
    .bind(buildId, project.id, sourceVersion, r2Prefix)
    .run();

  const engine = getContainer(env.ENGINE);
  const files = Object.fromEntries(sources.results.map((s) => [s.path, s.content]));
  const res = await engine.fetch(
    new Request("http://engine/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files, entry, timeout_s: body.timeout_s ?? 600 }),
    }),
  );
  if (!res.ok) {
    await finishBuild(env, buildId, "failed", { engine_error: await res.text() });
    return bad("engine rejected build", 502);
  }
  const result = await res.json<{
    build_id: string;
    ok: boolean;
    artifacts: string[];
    [k: string]: unknown;
  }>();

  // archive artifacts to R2 (immutable per-build prefix), then free the engine disk
  for (const rel of result.artifacts) {
    const file = await engine.fetch(
      new Request(`http://engine/artifact/${result.build_id}/${rel}`),
    );
    if (file.ok) await env.ARTIFACTS.put(r2Prefix + rel, await file.arrayBuffer());
  }
  await engine.fetch(
    new Request(`http://engine/build/${result.build_id}`, { method: "DELETE" }),
  );

  const status = result.ok ? "verified" : "failed";
  await finishBuild(env, buildId, status, result);
  return json({ build_id: buildId, status, report: result });
}

async function finishBuild(
  env: Env,
  buildId: string,
  status: string,
  report: unknown,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE build SET status = ?, report_json = ?, finished_at = datetime('now') WHERE id = ?",
  )
    .bind(status, JSON.stringify(report), buildId)
    .run();
}
