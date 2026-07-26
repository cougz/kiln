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
const MAX_DOC_BYTES = 250_000;
const MAX_PARAMS_BYTES = 50_000;
export const PARAMS_PATH = "params.json";
const DOC_KINDS = ["specification", "instructions", "bom", "page"] as const;
type DocKind = (typeof DOC_KINDS)[number];

// D1's datetime('now') stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone
// marker; clients (and the frontend) misread it as local time. Make it
// explicit ISO 8601 UTC before it leaves the API.
function isoUtc<T extends Record<string, unknown>>(row: T): T {
  for (const k of ["created_at", "finished_at", "updated_at"]) {
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
  const docs = await env.DB.prepare(
    "SELECT kind, build_id, updated_at FROM doc WHERE project_id = ? ORDER BY kind",
  )
    .bind(project.id)
    .all();
  return {
    ...project,
    sources: sources.results,
    recent_builds: builds.results.map(isoUtc),
    docs: docs.results.map(isoUtc),
  };
}

function requireDocKind(kind: string): asserts kind is DocKind {
  if (!(DOC_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError(400, `unknown doc kind '${kind}'; use ${DOC_KINDS.join(", ")}`);
  }
}

export async function listDocs(env: Env, slug: string) {
  const project = await getProject(env, slug);
  const docs = await env.DB.prepare(
    "SELECT kind, build_id, updated_at FROM doc WHERE project_id = ? ORDER BY kind",
  )
    .bind(project.id)
    .all();
  return docs.results.map(isoUtc);
}

export async function getDoc(env: Env, slug: string, kind: string) {
  requireDocKind(kind);
  const project = await getProject(env, slug);
  const doc = await env.DB.prepare(
    "SELECT kind, build_id, markdown, updated_at FROM doc WHERE project_id = ? AND kind = ?",
  )
    .bind(project.id, kind)
    .first();
  if (!doc) throw new ApiError(404, `no ${kind} document for '${slug}'`);
  return isoUtc(doc);
}

export async function putDoc(
  env: Env,
  slug: string,
  kind: string,
  markdown: string,
  buildId?: string,
) {
  requireDocKind(kind);
  if (new TextEncoder().encode(markdown).byteLength > MAX_DOC_BYTES) {
    throw new ApiError(400, `document too large (max ${MAX_DOC_BYTES} bytes)`);
  }
  const project = await getProject(env, slug);
  if (buildId) await getBuild(env, slug, buildId);
  await env.DB.prepare(
    `INSERT INTO doc (project_id, kind, build_id, markdown, html)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(project_id, kind) DO UPDATE SET
       build_id = excluded.build_id,
       markdown = excluded.markdown,
       html = NULL,
       updated_at = datetime('now')`,
  )
    .bind(project.id, kind, buildId ?? null, markdown)
    .run();
  return getDoc(env, slug, kind);
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

function normalizeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "params must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parseParams(content: string): Record<string, unknown> {
  try {
    return normalizeParams(JSON.parse(content));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(409, "stored params.json is not a JSON object; update it with set_params");
  }
}

export async function getParams(env: Env, slug: string) {
  try {
    const source = await getSource(env, slug, PARAMS_PATH);
    return { params: parseParams(source.content), version: source.version };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { params: {}, version: 0 };
    throw err;
  }
}

export async function setParams(env: Env, slug: string, params: unknown) {
  const normalized = normalizeParams(params);
  const content = JSON.stringify(normalized, null, 2) + "\n";
  if (new TextEncoder().encode(content).byteLength > MAX_PARAMS_BYTES) {
    throw new ApiError(400, `params too large (max ${MAX_PARAMS_BYTES} bytes)`);
  }
  const source = await putSource(env, slug, PARAMS_PATH, content);
  return { params: normalized, version: source.version };
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
  return isoUtc({
    ...build,
    params: JSON.parse(build.params_json ?? "{}") as unknown,
    report_json: JSON.parse(build.report_json ?? "null") as unknown,
  });
}

export async function getArtifact(env: Env, slug: string, buildId: string, path: string) {
  const build = await getBuild(env, slug, buildId);
  if (!build.r2_prefix) throw new ApiError(409, "build has no artifact archive");
  const obj = await env.ARTIFACTS.get(`${build.r2_prefix}${path}`);
  if (!obj) throw new ApiError(404, `no artifact '${path}'`);
  return obj;
}

export async function listArtifacts(env: Env, slug: string, buildId: string, cursor?: string) {
  const build = await getBuild(env, slug, buildId);
  if (!build.r2_prefix) throw new ApiError(409, "build has no artifact archive");
  const result = await env.ARTIFACTS.list({ prefix: build.r2_prefix, cursor });
  return {
    artifacts: result.objects.map((object) => ({
      path: object.key.slice(build.r2_prefix!.length),
      size: object.size,
      uploaded: object.uploaded.toISOString(),
      etag: object.etag,
    })),
    cursor: result.truncated ? result.cursor : undefined,
  };
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
  const paramsSource = sources.results.find((source) => source.path === PARAMS_PATH);
  let params: Record<string, unknown> = {};
  let paramsContent = "{}\n";
  if (paramsSource) {
    const row = await env.DB.prepare(
      "SELECT content FROM source WHERE project_id = ? AND path = ? AND version = ?",
    )
      .bind(project.id, PARAMS_PATH, paramsSource.v)
      .first<{ content: string }>();
    if (!row) throw new ApiError(409, "pinned params.json source is missing");
    params = parseParams(row.content);
    paramsContent = row.content;
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
    "INSERT INTO build (id, project_id, source_version, params_json, status, r2_prefix) VALUES (?, ?, ?, ?, 'queued', ?)",
  )
    .bind(buildId, project.id, sourceVersion, JSON.stringify(params), r2Prefix)
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
      params,
      params_content: paramsContent,
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
  if (!res.ok) {
    const detail = `measure failed: ${await res.text()}`;
    throw new ApiError(res.status < 500 ? 422 : 502, detail);
  }
  return res.json();
}

export async function verifyTarget(
  env: Env,
  slug: string,
  buildId: string,
  path: string,
  axis: "x" | "y" | "z",
  expected: number,
  tolerance: number,
) {
  if (!Number.isFinite(expected) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new ApiError(400, "expected and non-negative tolerance must be finite numbers");
  }
  if (!path.startsWith("stl/") || !path.endsWith(".stl")) {
    throw new ApiError(400, "verify_target requires a print-oriented stl/*.stl artifact");
  }
  const measurement = (await measureArtifact(env, slug, buildId, path)) as { extents?: unknown };
  const index = { x: 0, y: 1, z: 2 }[axis];
  const actual = Array.isArray(measurement.extents) ? measurement.extents[index] : undefined;
  if (typeof actual !== "number") throw new ApiError(502, "measure response missing extents");
  const delta = Math.abs(actual - expected);
  return {
    axis,
    expected,
    tolerance,
    actual,
    delta,
    passed: delta <= tolerance,
    measurement,
  };
}

export async function finishBuild(env: Env, buildId: string, status: string, report: unknown) {
  await env.DB.prepare(
    "UPDATE build SET status = ?, report_json = ?, finished_at = datetime('now') WHERE id = ?",
  )
    .bind(status, JSON.stringify(report), buildId)
    .run();
}
