import { getContainer } from "@cloudflare/containers";
import type { Env } from "./index";

/** Shared operations behind both the REST API and the MCP tools. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface BuildResult {
  build_id: string;
  status: string;
  report: {
    ok: boolean;
    artifacts: string[];
    [k: string]: unknown;
  };
}

export async function listProjects(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT slug, name, description, created_at FROM project ORDER BY created_at DESC",
  ).all();
  return rows.results;
}

export async function createProject(
  env: Env,
  slug: string,
  name?: string,
  description?: string,
) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw new ApiError(400, "slug required: lowercase alphanumeric + dashes");
  }
  const id = crypto.randomUUID().slice(0, 12);
  try {
    await env.DB.prepare(
      "INSERT INTO project (id, slug, name, description) VALUES (?, ?, ?, ?)",
    )
      .bind(id, slug, name ?? slug, description ?? "")
      .run();
  } catch {
    throw new ApiError(409, `slug '${slug}' already exists`);
  }
  return { id, slug };
}

export async function getProject(env: Env, slug: string): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    "SELECT id, slug, name, description FROM project WHERE slug = ?",
  )
    .bind(slug)
    .first<ProjectRow>();
  if (!row) throw new ApiError(404, `no project '${slug}'`);
  return row;
}

export async function getProjectDetail(env: Env, slug: string) {
  const project = await getProject(env, slug);
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
  return { ...project, sources: sources.results, recent_builds: builds.results };
}

export async function putSource(env: Env, slug: string, path: string, content: string) {
  const project = await getProject(env, slug);
  if (!path || path.includes("..") || path.startsWith("/")) {
    throw new ApiError(400, "unsafe or missing path");
  }
  const prev = await env.DB.prepare(
    "SELECT MAX(version) AS v FROM source WHERE project_id = ? AND path = ?",
  )
    .bind(project.id, path)
    .first<{ v: number | null }>();
  const version = (prev?.v ?? 0) + 1;
  await env.DB.prepare(
    "INSERT INTO source (project_id, path, version, content) VALUES (?, ?, ?, ?)",
  )
    .bind(project.id, path, version, content)
    .run();
  return { path, version };
}

export async function getSource(env: Env, slug: string, path: string) {
  const project = await getProject(env, slug);
  const row = await env.DB.prepare(
    "SELECT content, version FROM source WHERE project_id = ? AND path = ? ORDER BY version DESC LIMIT 1",
  )
    .bind(project.id, path)
    .first<{ content: string; version: number }>();
  if (!row) throw new ApiError(404, `no source '${path}'`);
  return row;
}

export async function listBuilds(env: Env, slug: string) {
  const project = await getProject(env, slug);
  const rows = await env.DB.prepare(
    "SELECT id, source_version, status, created_at, finished_at FROM build WHERE project_id = ? ORDER BY created_at DESC",
  )
    .bind(project.id)
    .all();
  return rows.results;
}

interface BuildRow {
  id: string;
  project_id: string;
  source_version: number;
  params_json: string;
  status: string;
  report_json: string | null;
  r2_prefix: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function getBuild(env: Env, slug: string, buildId: string) {
  const project = await getProject(env, slug);
  const build = await env.DB.prepare(
    "SELECT * FROM build WHERE project_id = ? AND id = ?",
  )
    .bind(project.id, buildId)
    .first<BuildRow>();
  if (!build) throw new ApiError(404, `no build '${buildId}'`);
  return { ...build, report_json: JSON.parse(build.report_json ?? "null") as unknown };
}

export async function getArtifact(env: Env, slug: string, buildId: string, path: string) {
  const build = await getBuild(env, slug, buildId);
  const obj = await env.ARTIFACTS.get(`${build.r2_prefix}${path}`);
  if (!obj) throw new ApiError(404, `no artifact '${path}'`);
  return obj;
}

export async function runBuild(
  env: Env,
  slug: string,
  entry = "build.py",
  timeoutS = 600,
): Promise<BuildResult> {
  const project = await getProject(env, slug);
  const sources = await env.DB.prepare(
    `SELECT s.path, s.content, s.version FROM source s
     JOIN (SELECT path, MAX(version) AS v FROM source WHERE project_id = ? GROUP BY path) m
       ON s.path = m.path AND s.version = m.v
     WHERE s.project_id = ?`,
  )
    .bind(project.id, project.id)
    .all<{ path: string; content: string; version: number }>();
  if (!sources.results.length) {
    throw new ApiError(400, "project has no sources — put_source first");
  }

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
      body: JSON.stringify({ files, entry, timeout_s: timeoutS }),
    }),
  );
  if (!res.ok) {
    const detail = { engine_error: await res.text() };
    await finishBuild(env, buildId, "failed", detail);
    throw new ApiError(502, `engine rejected build: ${JSON.stringify(detail)}`);
  }
  const result = (await res.json()) as BuildResult["report"] & { build_id: string };

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
  return { build_id: buildId, status, report: result };
}

export async function measureArtifact(env: Env, slug: string, buildId: string, path: string) {
  const obj = await getArtifact(env, slug, buildId, path);
  const engine = getContainer(env.ENGINE);
  const res = await engine.fetch(
    new Request("http://engine/measure", { method: "POST", body: await obj.arrayBuffer() }),
  );
  if (!res.ok) throw new ApiError(502, `measure failed: ${await res.text()}`);
  return res.json();
}

async function finishBuild(env: Env, buildId: string, status: string, report: unknown) {
  await env.DB.prepare(
    "UPDATE build SET status = ?, report_json = ?, finished_at = datetime('now') WHERE id = ?",
  )
    .bind(status, JSON.stringify(report), buildId)
    .run();
}
