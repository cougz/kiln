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

export interface QueuedBuild {
  build_id: string;
  status: "queued";
  note: string;
}

const MAX_SOURCE_BYTES = 500_000; // per file; sources are CAD scripts, not assets
const MAX_PATH_LEN = 160;
const MAX_ACTIVE_BUILDS = 3; // queued+running per project

// D1's datetime('now') stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone
// marker; clients (and the frontend) misread it as local time. Make it
// explicit ISO 8601 UTC before it leaves the API.
function isoUtc<T extends Record<string, unknown>>(row: T): T {
  for (const k of ["created_at", "finished_at"]) {
    const v = row[k];
    if (typeof v === "string" && v.includes(" ")) {
      (row as Record<string, unknown>)[k] = v.replace(" ", "T") + "Z";
    }
  }
  return row;
}

export async function listProjects(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT slug, name, description, created_at FROM project ORDER BY created_at DESC",
  ).all();
  return rows.results.map(isoUtc);
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
  return { ...project, sources: sources.results, recent_builds: builds.results.map(isoUtc) };
}

export async function putSource(env: Env, slug: string, path: string, content: string) {
  const project = await getProject(env, slug);
  if (!path || path.includes("..") || path.startsWith("/") || path.length > MAX_PATH_LEN) {
    throw new ApiError(400, "unsafe, missing, or overlong path");
  }
  if (content.length > MAX_SOURCE_BYTES) {
    throw new ApiError(400, `source too large (${content.length} > ${MAX_SOURCE_BYTES} bytes)`);
  }
  // (project_id, path, version) is the primary key, so two concurrent PUTs
  // reading the same MAX(version) can't both insert — retry the loser.
  for (let attempt = 0; ; attempt++) {
    const prev = await env.DB.prepare(
      "SELECT MAX(version) AS v FROM source WHERE project_id = ? AND path = ?",
    )
      .bind(project.id, path)
      .first<{ v: number | null }>();
    const version = (prev?.v ?? 0) + 1;
    try {
      await env.DB.prepare(
        "INSERT INTO source (project_id, path, version, content) VALUES (?, ?, ?, ?)",
      )
        .bind(project.id, path, version, content)
        .run();
      return { path, version };
    } catch (err) {
      if (attempt >= 2) throw new ApiError(409, `source version conflict on '${path}'`);
    }
  }
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
  return rows.results.map(isoUtc);
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
  return isoUtc({ ...build, report_json: JSON.parse(build.report_json ?? "null") as unknown });
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
  bed = 180,
): Promise<QueuedBuild> {
  const project = await getProject(env, slug);
  const sources = await env.DB.prepare(
    "SELECT path, MAX(version) AS v FROM source WHERE project_id = ? GROUP BY path",
  )
    .bind(project.id)
    .all<{ path: string; v: number }>();
  if (!sources.results.length) {
    throw new ApiError(400, "project has no sources — put_source first");
  }
  if (!sources.results.some((s) => s.path === entry)) {
    throw new ApiError(400, `entry '${entry}' is not among the project's sources`);
  }
  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM build WHERE project_id = ? AND status IN ('queued','running')",
  )
    .bind(project.id)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_BUILDS) {
    throw new ApiError(
      429,
      `project already has ${MAX_ACTIVE_BUILDS} builds queued/running — poll get_build first`,
    );
  }

  const sourceVersion = Math.max(...sources.results.map((s) => s.v));
  const buildId = crypto.randomUUID().slice(0, 12);
  const r2Prefix = `projects/${project.id}/builds/${buildId}/`;
  await env.DB.prepare(
    "INSERT INTO build (id, project_id, source_version, status, r2_prefix) VALUES (?, ?, ?, 'queued', ?)",
  )
    .bind(buildId, project.id, sourceVersion, r2Prefix)
    .run();

  await env.BUILD_WORKFLOW.create({
    id: buildId,
    params: {
      build_id: buildId,
      project_id: project.id,
      entry,
      timeout_s: Math.min(Math.max(timeoutS, 30), 900),
      bed: Math.min(Math.max(bed, 100), 1000),
      r2_prefix: r2Prefix,
      files: Object.fromEntries(sources.results.map((s) => [s.path, s.v])),
    },
  });

  return {
    build_id: buildId,
    status: "queued",
    note: "build runs in the background (typically 1-5 min) — poll get_build until status is 'verified' or 'failed'",
  };
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

export async function finishBuild(env: Env, buildId: string, status: string, report: unknown) {
  await env.DB.prepare(
    "UPDATE build SET status = ?, report_json = ?, finished_at = datetime('now') WHERE id = ?",
  )
    .bind(status, JSON.stringify(report), buildId)
    .run();
}
