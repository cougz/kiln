import { getContainer } from "@cloudflare/containers";
import { buildContainerName } from "./engine";
import type { Env } from "./index";

/** Shared operations behind both the REST API and the MCP tools. */

function defaultErrorCode(status: number): string {
  if (status === 400) return "INVALID_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 409) return "CONFLICT";
  if (status === 415) return "UNSUPPORTED_MEDIA_TYPE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL_ERROR";
  return "REQUEST_FAILED";
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = defaultErrorCode(status),
    public headers?: HeadersInit,
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
  status: string;
  note: string;
  idempotent_replay?: boolean;
}

export interface PrinterProfile {
  x: number;
  y: number;
  z: number;
}

export interface PaginationOptions {
  cursor?: string;
  limit?: number;
}

export interface SourceManifestEntry {
  path: string;
  version: number;
  sha256: string;
  size: number;
}

interface BuildInput extends SourceManifestEntry {
  content: string;
}

interface QueueSettings {
  entry: string;
  timeoutS: number;
  printerProfile: PrinterProfile;
  params: Record<string, unknown>;
  paramsContent: string;
  retryOf?: string;
}

interface BuildRow {
  id: string;
  project_id: string;
  source_version: number;
  params_json: string;
  params_content: string;
  source_manifest_json: string;
  entry: string;
  timeout_s: number;
  printer_profile_json: string;
  status: string;
  report_json: string | null;
  r2_prefix: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  attempt: number;
  archive_status: string;
  archived_at: string | null;
  failure_code: string | null;
  retry_of: string | null;
  cancelled_at: string | null;
}

const MAX_SOURCE_BYTES = 500_000;
const MAX_SOURCE_FILES = 128;
const MAX_AGGREGATE_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_PATH_LEN = 160;
const MAX_ARTIFACT_PATH_LEN = 512;
const MAX_ACTIVE_BUILDS = 2;
const MAX_GLOBAL_ACTIVE_BUILDS = 2;
const MAX_DOC_BYTES = 250_000;
const MAX_PARAMS_BYTES = 50_000;
const MAX_PARAM_PROPERTIES = 1_000;
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
export const PARAMS_PATH = "params.json";
const DOC_KINDS = ["specification", "instructions", "bom", "page"] as const;
type DocKind = (typeof DOC_KINDS)[number];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// D1's datetime('now') lacks a zone marker. Make all returned timestamps UTC.
function isoUtc<T extends Record<string, unknown>>(row: T): T {
  for (const key of [
    "created_at",
    "started_at",
    "heartbeat_at",
    "finished_at",
    "archived_at",
    "cancelled_at",
    "updated_at",
  ]) {
    const value = row[key];
    if (typeof value === "string" && value.includes(" ")) {
      (row as Record<string, unknown>)[key] = value.replace(" ", "T") + "Z";
    }
  }
  return row;
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function requireSafePath(path: string, label = "path"): void {
  if (
    !path ||
    path.length > MAX_PATH_LEN ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ApiError(400, `unsafe, missing, or overlong ${label}`, "INVALID_PATH");
  }
}

function requireSafeArtifactPath(path: string): void {
  if (
    !path ||
    path.length > MAX_ARTIFACT_PATH_LEN ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ApiError(400, "unsafe, missing, or overlong artifact path", "INVALID_PATH");
  }
}

function pageLimit(options: PaginationOptions): number {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ApiError(400, `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`, "INVALID_PAGINATION");
  }
  return limit;
}

function encodeCursor(parts: unknown[]): string {
  const bytes = encoder.encode(JSON.stringify(parts));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeCursor(cursor: string | undefined, expected: number): unknown[] | undefined {
  if (!cursor) return undefined;
  try {
    const binary = atob(cursor);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== expected) throw new Error("shape");
    return parsed;
  } catch {
    throw new ApiError(400, "invalid pagination cursor", "INVALID_CURSOR");
  }
}

export async function listProjects(env: Env, pagination?: PaginationOptions) {
  if (!pagination) {
    const rows = await env.DB.prepare(
      "SELECT slug, name, description, created_at FROM project ORDER BY created_at DESC, id DESC LIMIT 100",
    ).all();
    return rows.results.map(isoUtc);
  }

  const limit = pageLimit(pagination);
  const cursor = decodeCursor(pagination.cursor, 2);
  if (cursor && (typeof cursor[0] !== "string" || typeof cursor[1] !== "string")) {
    throw new ApiError(400, "invalid pagination cursor", "INVALID_CURSOR");
  }
  const rows = cursor
    ? await env.DB.prepare(
        `SELECT id, slug, name, description, created_at FROM project
         WHERE created_at < ? OR (created_at = ? AND id < ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
        .bind(cursor[0], cursor[0], cursor[1], limit + 1)
        .all<Record<string, unknown>>()
    : await env.DB.prepare(
        "SELECT id, slug, name, description, created_at FROM project ORDER BY created_at DESC, id DESC LIMIT ?",
      )
        .bind(limit + 1)
        .all<Record<string, unknown>>();
  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const last = selected.at(-1);
  return {
    projects: selected.map(({ id: _id, ...row }) => isoUtc(row)),
    cursor:
      hasMore && last ? encodeCursor([last.created_at as string, last.id as string]) : undefined,
  };
}

export async function createProject(
  env: Env,
  slug: string,
  name?: string,
  description?: string,
  createdBy = "",
) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw new ApiError(400, "slug required: lowercase alphanumeric + dashes", "INVALID_SLUG");
  }
  const id = crypto.randomUUID().slice(0, 12);
  try {
    await env.DB.prepare(
      "INSERT INTO project (id, slug, name, description, created_by) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, slug, name ?? slug, description ?? "", createdBy)
      .run();
  } catch {
    throw new ApiError(409, `slug '${slug}' already exists`, "SLUG_EXISTS");
  }
  return { id, slug };
}

export async function updateProject(
  env: Env,
  slug: string,
  values: { name?: string; description?: string },
) {
  const project = await getProject(env, slug);
  const name = values.name ?? project.name;
  const description = values.description ?? project.description;
  if (!name || name.length > 160 || description.length > 2_000) {
    throw new ApiError(400, "project name or description is invalid", "INVALID_PROJECT");
  }
  await env.DB.prepare("UPDATE project SET name = ?, description = ? WHERE id = ?")
    .bind(name, description, project.id)
    .run();
  return getProject(env, slug);
}

export async function getProject(env: Env, slug: string): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    "SELECT id, slug, name, description FROM project WHERE slug = ?",
  )
    .bind(slug)
    .first<ProjectRow>();
  if (!row) throw new ApiError(404, `no project '${slug}'`, "PROJECT_NOT_FOUND");
  return row;
}

export async function getProjectDetail(env: Env, slug: string) {
  const project = await getProject(env, slug);
  const [builds, sources, docs] = await Promise.all([
    env.DB.prepare(
      "SELECT id, status, cancelled_at, created_at FROM build WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 10",
    )
      .bind(project.id)
      .all(),
    env.DB.prepare(
      "SELECT path, MAX(version) AS version FROM source WHERE project_id = ? GROUP BY path ORDER BY path",
    )
      .bind(project.id)
      .all(),
    env.DB.prepare(
      "SELECT kind, build_id, updated_at FROM doc WHERE project_id = ? ORDER BY kind",
    )
      .bind(project.id)
      .all(),
  ]);
  return {
    ...project,
    sources: sources.results,
    recent_builds: builds.results.map((row) => {
      const result = isoUtc(row);
      if (result.cancelled_at) result.status = "cancelled";
      return result;
    }),
    docs: docs.results.map(isoUtc),
  };
}

function requireDocKind(kind: string): asserts kind is DocKind {
  if (!(DOC_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError(400, `unknown doc kind '${kind}'; use ${DOC_KINDS.join(", ")}`, "INVALID_DOC_KIND");
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
  if (!doc) throw new ApiError(404, `no ${kind} document for '${slug}'`, "DOC_NOT_FOUND");
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
  if (byteLength(markdown) > MAX_DOC_BYTES) {
    throw new ApiError(400, `document too large (max ${MAX_DOC_BYTES} bytes)`, "DOCUMENT_TOO_LARGE");
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
  requireSafePath(path, "source path");
  const size = byteLength(content);
  if (size > MAX_SOURCE_BYTES) {
    throw new ApiError(400, `source too large (${size} > ${MAX_SOURCE_BYTES} bytes)`, "SOURCE_TOO_LARGE");
  }
  if (path === PARAMS_PATH) {
    parseParamsContent(content, false);
    if (size > MAX_PARAMS_BYTES) {
      throw new ApiError(400, `params too large (max ${MAX_PARAMS_BYTES} bytes)`, "PARAMS_TOO_LARGE");
    }
  }

  const current = await env.DB.prepare(
    `SELECT s.path, s.content FROM source s
     WHERE s.project_id = ? AND s.version = (
       SELECT MAX(version) FROM source WHERE project_id = s.project_id AND path = s.path
     )`,
  )
    .bind(project.id)
    .all<{ path: string; content: string }>();
  const existing = current.results.find((row) => row.path === path);
  if (existing?.content === content) {
    const latest = await getSource(env, slug, path);
    return { path, version: latest.version, sha256: latest.sha256, size: latest.size, deduplicated: true };
  }
  const count = current.results.length + (existing ? 0 : 1);
  const aggregate = current.results.reduce(
    (total, row) => total + (row.path === path ? 0 : byteLength(row.content)),
    size,
  );
  if (count > MAX_SOURCE_FILES) {
    throw new ApiError(400, `too many source files (max ${MAX_SOURCE_FILES})`, "TOO_MANY_SOURCES");
  }
  if (aggregate > MAX_AGGREGATE_SOURCE_BYTES) {
    throw new ApiError(
      400,
      `aggregate source content too large (max ${MAX_AGGREGATE_SOURCE_BYTES} bytes)`,
      "SOURCES_TOO_LARGE",
    );
  }

  const sha256 = await sha256Hex(content);
  // The primary key resolves concurrent version writers. The loser retries and
  // also rechecks content so identical racing writes do not create two versions.
  for (let attempt = 0; attempt < 3; attempt++) {
    const prev = await env.DB.prepare(
      "SELECT version, content FROM source WHERE project_id = ? AND path = ? ORDER BY version DESC LIMIT 1",
    )
      .bind(project.id, path)
      .first<{ version: number; content: string }>();
    if (prev?.content === content) {
      return { path, version: prev.version, sha256, size, deduplicated: true };
    }
    const version = (prev?.version ?? 0) + 1;
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO source (project_id, path, version, content, sha256, byte_size)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM source s
           WHERE s.project_id = ? AND s.version = (
             SELECT MAX(s2.version) FROM source s2
             WHERE s2.project_id = s.project_id AND s2.path = s.path
           )
         ) + CASE WHEN EXISTS (
           SELECT 1 FROM source WHERE project_id = ? AND path = ?
         ) THEN 0 ELSE 1 END <= ?
         AND COALESCE((
           SELECT SUM(length(CAST(s.content AS BLOB))) FROM source s
           WHERE s.project_id = ? AND s.path <> ? AND s.version = (
             SELECT MAX(s2.version) FROM source s2
             WHERE s2.project_id = s.project_id AND s2.path = s.path
           )
         ), 0) + ? <= ?`,
      )
        .bind(
          project.id,
          path,
          version,
          content,
          sha256,
          size,
          project.id,
          project.id,
          path,
          MAX_SOURCE_FILES,
          project.id,
          path,
          size,
          MAX_AGGREGATE_SOURCE_BYTES,
        )
        .run();
      if ((inserted.meta.changes ?? 0) !== 1) {
        const latest = await env.DB.prepare(
          `SELECT s.path, s.content FROM source s
           WHERE s.project_id = ? AND s.version = (
             SELECT MAX(version) FROM source WHERE project_id = s.project_id AND path = s.path
           )`,
        )
          .bind(project.id)
          .all<{ path: string; content: string }>();
        const currentPath = latest.results.some((row) => row.path === path);
        if (latest.results.length + (currentPath ? 0 : 1) > MAX_SOURCE_FILES) {
          throw new ApiError(400, `too many source files (max ${MAX_SOURCE_FILES})`, "TOO_MANY_SOURCES");
        }
        const currentBytes = latest.results.reduce(
          (total, row) => total + (row.path === path ? 0 : byteLength(row.content)),
          size,
        );
        if (currentBytes > MAX_AGGREGATE_SOURCE_BYTES) {
          throw new ApiError(400, `aggregate source content too large (max ${MAX_AGGREGATE_SOURCE_BYTES} bytes)`, "SOURCES_TOO_LARGE");
        }
        throw new ApiError(409, `source version conflict on '${path}'`, "SOURCE_CONFLICT");
      }
      return { path, version, sha256, size, deduplicated: false };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (attempt === 2) throw new ApiError(409, `source version conflict on '${path}'`, "SOURCE_CONFLICT");
    }
  }
  throw new ApiError(409, `source version conflict on '${path}'`, "SOURCE_CONFLICT");
}

export async function getSource(env: Env, slug: string, path: string, version?: number) {
  requireSafePath(path, "source path");
  const project = await getProject(env, slug);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw new ApiError(400, "source version must be a positive integer", "INVALID_SOURCE_VERSION");
  }
  const row = version === undefined
    ? await env.DB.prepare(
        `SELECT content, version, sha256, byte_size, created_at FROM source
         WHERE project_id = ? AND path = ? ORDER BY version DESC LIMIT 1`,
      )
        .bind(project.id, path)
        .first<{ content: string; version: number; sha256: string | null; byte_size: number | null; created_at: string }>()
    : await env.DB.prepare(
        `SELECT content, version, sha256, byte_size, created_at FROM source
         WHERE project_id = ? AND path = ? AND version = ?`,
      )
        .bind(project.id, path, version)
        .first<{ content: string; version: number; sha256: string | null; byte_size: number | null; created_at: string }>();
  if (!row) throw new ApiError(404, `no source '${path}'${version ? ` version ${version}` : ""}`, "SOURCE_NOT_FOUND");
  return isoUtc({
    content: row.content,
    version: row.version,
    sha256: row.sha256 ?? await sha256Hex(row.content),
    size: row.byte_size ?? byteLength(row.content),
    created_at: row.created_at,
  });
}

export async function listSourceHistory(
  env: Env,
  slug: string,
  path: string,
  pagination: PaginationOptions = {},
) {
  requireSafePath(path, "source path");
  const project = await getProject(env, slug);
  const limit = pageLimit(pagination);
  const cursor = decodeCursor(pagination.cursor, 1);
  if (cursor && (!Number.isInteger(cursor[0]) || (cursor[0] as number) < 1)) {
    throw new ApiError(400, "invalid pagination cursor", "INVALID_CURSOR");
  }
  const rows = cursor
    ? await env.DB.prepare(
        `SELECT version, sha256, byte_size, created_at FROM source
         WHERE project_id = ? AND path = ? AND version < ? ORDER BY version DESC LIMIT ?`,
      )
        .bind(project.id, path, cursor[0], limit + 1)
        .all<{ version: number; sha256: string | null; byte_size: number | null; created_at: string }>()
    : await env.DB.prepare(
        `SELECT version, sha256, byte_size, created_at FROM source
         WHERE project_id = ? AND path = ? ORDER BY version DESC LIMIT ?`,
      )
        .bind(project.id, path, limit + 1)
        .all<{ version: number; sha256: string | null; byte_size: number | null; created_at: string }>();
  if (!rows.results.length) throw new ApiError(404, `no source '${path}'`, "SOURCE_NOT_FOUND");
  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const versions = [];
  for (const row of selected) {
    let sha256 = row.sha256;
    let size = row.byte_size;
    if (sha256 === null || size === null) {
      const source = await env.DB.prepare(
        "SELECT content FROM source WHERE project_id = ? AND path = ? AND version = ?",
      )
        .bind(project.id, path, row.version)
        .first<{ content: string }>();
      if (!source) throw new ApiError(409, "source history changed during metadata enrichment", "SOURCE_CONFLICT");
      sha256 = await sha256Hex(source.content);
      size = byteLength(source.content);
      await env.DB.prepare(
        `UPDATE source SET sha256 = ?, byte_size = ?
         WHERE project_id = ? AND path = ? AND version = ? AND (sha256 IS NULL OR byte_size IS NULL)`,
      ).bind(sha256, size, project.id, path, row.version).run();
    }
    versions.push(isoUtc({ version: row.version, sha256, size, created_at: row.created_at }));
  }
  return {
    path,
    versions,
    cursor: hasMore ? encodeCursor([selected[selected.length - 1].version]) : undefined,
  };
}

function normalizeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "params must be a JSON object", "INVALID_PARAMS");
  }
  if (Object.keys(value).length > MAX_PARAM_PROPERTIES) {
    throw new ApiError(400, `params may contain at most ${MAX_PARAM_PROPERTIES} top-level properties`, "INVALID_PARAMS");
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApiError(400, "params numbers must be finite", "INVALID_PARAMS");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ApiError(400, "params cannot contain cycles", "INVALID_PARAMS");
    seen.add(value);
    const result = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new ApiError(400, "params cannot contain cycles", "INVALID_PARAMS");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ApiError(400, "params must contain only JSON values", "INVALID_PARAMS");
    }
    seen.add(value);
    const object = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, canonicalJson(object[key], seen)]),
    );
    seen.delete(value);
    return result;
  }
  throw new ApiError(400, "params must contain only JSON values", "INVALID_PARAMS");
}

function parseParamsContent(content: string, stored: boolean): Record<string, unknown> {
  try {
    const params = normalizeParams(JSON.parse(content));
    canonicalJson(params);
    return params;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (stored) {
      throw new ApiError(409, "stored params.json is not a JSON object; update it with set_params", "INVALID_STORED_PARAMS");
    }
    throw new ApiError(400, "params.json must contain a JSON object", "INVALID_PARAMS");
  }
}

function parseParams(content: string): Record<string, unknown> {
  return parseParamsContent(content, true);
}

export async function getParams(env: Env, slug: string) {
  try {
    const source = await getSource(env, slug, PARAMS_PATH);
    return { params: parseParams(source.content), version: source.version };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { params: {}, version: 0 };
    throw error;
  }
}

export async function setParams(env: Env, slug: string, params: unknown) {
  const normalized = normalizeParams(params);
  const content = JSON.stringify(canonicalJson(normalized), null, 2) + "\n";
  if (byteLength(content) > MAX_PARAMS_BYTES) {
    throw new ApiError(400, `params too large (max ${MAX_PARAMS_BYTES} bytes)`, "PARAMS_TOO_LARGE");
  }
  const source = await putSource(env, slug, PARAMS_PATH, content);
  return { params: normalized, version: source.version, deduplicated: source.deduplicated };
}

export async function listBuilds(env: Env, slug: string, pagination?: PaginationOptions) {
  const project = await getProject(env, slug);
  if (!pagination) {
    const rows = await env.DB.prepare(
      `SELECT id, source_version, status, cancelled_at, created_at, finished_at FROM build
       WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
      .bind(project.id)
      .all<Record<string, unknown>>();
    return rows.results.map(publicBuildSummary);
  }

  const limit = pageLimit(pagination);
  const cursor = decodeCursor(pagination.cursor, 2);
  if (cursor && (typeof cursor[0] !== "string" || typeof cursor[1] !== "string")) {
    throw new ApiError(400, "invalid pagination cursor", "INVALID_CURSOR");
  }
  const rows = cursor
    ? await env.DB.prepare(
        `SELECT id, source_version, status, cancelled_at, created_at, finished_at FROM build
         WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
        .bind(project.id, cursor[0], cursor[0], cursor[1], limit + 1)
        .all<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT id, source_version, status, cancelled_at, created_at, finished_at FROM build
         WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
        .bind(project.id, limit + 1)
        .all<Record<string, unknown>>();
  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const last = selected.at(-1);
  return {
    builds: selected.map(publicBuildSummary),
    cursor: hasMore && last ? encodeCursor([last.created_at as string, last.id as string]) : undefined,
  };
}

function publicBuildSummary(row: Record<string, unknown>): Record<string, unknown> {
  const result = isoUtc(row);
  if (result.cancelled_at) result.status = "cancelled";
  return result;
}

function parseStoredJson(value: string | null, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

async function findBuildRow(env: Env, projectId: string, buildId: string): Promise<BuildRow | null> {
  return env.DB.prepare(
    `SELECT id, project_id, source_version, params_json, params_content,
            source_manifest_json, entry, timeout_s, printer_profile_json,
            status, report_json, r2_prefix, created_at, started_at,
            heartbeat_at, finished_at, attempt, archive_status, archived_at,
            failure_code, retry_of, cancelled_at
     FROM build WHERE project_id = ? AND id = ?`,
  )
    .bind(projectId, buildId)
    .first<BuildRow>();
}

export async function getBuild(env: Env, slug: string, buildId: string) {
  const project = await getProject(env, slug);
  const build = await findBuildRow(env, project.id, buildId);
  if (!build) throw new ApiError(404, `no build '${buildId}'`, "BUILD_NOT_FOUND");
  const sourceManifest = parseStoredJson(build.source_manifest_json, []);
  const exactProvenance = Array.isArray(sourceManifest) && sourceManifest.length > 0;
  return isoUtc({
    ...build,
    status: build.cancelled_at ? "cancelled" : build.status,
    database_status: build.status,
    params_content: exactProvenance ? build.params_content : null,
    entry: exactProvenance ? build.entry : null,
    timeout_s: exactProvenance ? build.timeout_s : null,
    params: parseStoredJson(build.params_json, {}),
    printer_profile: exactProvenance
      ? parseStoredJson(build.printer_profile_json, { x: 180, y: 180, z: 180 })
      : null,
    source_manifest: sourceManifest,
    provenance_status: exactProvenance ? "exact" : "legacy_unavailable",
    report_json: parseStoredJson(build.report_json, null),
  });
}

export async function getArtifact(env: Env, slug: string, buildId: string, path: string) {
  requireSafeArtifactPath(path);
  const build = await getBuild(env, slug, buildId);
  if (!build.r2_prefix) throw new ApiError(409, "build has no artifact archive", "ARCHIVE_NOT_AVAILABLE");
  if (build.archive_status !== "verified" && build.archive_status !== "legacy") {
    throw new ApiError(409, "build artifact archive is not finalized", "ARCHIVE_NOT_FINALIZED");
  }
  const obj = await env.ARTIFACTS.get(`${build.r2_prefix}${path}`);
  if (!obj) throw new ApiError(404, `no artifact '${path}'`, "ARTIFACT_NOT_FOUND");
  return obj;
}

export async function getArtifactMetadata(env: Env, slug: string, buildId: string, path: string) {
  requireSafeArtifactPath(path);
  const project = await getProject(env, slug);
  const build = await findBuildRow(env, project.id, buildId);
  if (!build) throw new ApiError(404, `no build '${buildId}'`, "BUILD_NOT_FOUND");
  const row = await env.DB.prepare(
    "SELECT path, sha256, size, created_at FROM artifact WHERE build_id = ? AND path = ?",
  )
    .bind(buildId, path)
    .first<{ path: string; sha256: string; size: number; created_at: string }>();
  return row ? isoUtc(row) : null;
}

export async function listArtifacts(env: Env, slug: string, buildId: string, cursor?: string) {
  const project = await getProject(env, slug);
  const build = await findBuildRow(env, project.id, buildId);
  if (!build) throw new ApiError(404, `no build '${buildId}'`, "BUILD_NOT_FOUND");
  if (!build.r2_prefix) throw new ApiError(409, "build has no artifact archive", "ARCHIVE_NOT_AVAILABLE");
  if (build.archive_status !== "verified" && build.archive_status !== "legacy") {
    throw new ApiError(409, "build artifact archive is not finalized", "ARCHIVE_NOT_FINALIZED");
  }

  const metadataCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM artifact WHERE build_id = ?",
  )
    .bind(buildId)
    .first<{ count: number }>();
  // Old builds predate artifact metadata; retain their native R2 pagination.
  if ((metadataCount?.count ?? 0) === 0) {
    const legacy = await env.ARTIFACTS.list({ prefix: build.r2_prefix, cursor, limit: 100 });
    return {
      artifacts: legacy.objects.map((object) => ({
        path: object.key.slice(build.r2_prefix!.length),
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        etag: object.etag,
      })),
      cursor: legacy.truncated ? legacy.cursor : undefined,
    };
  }

  const decoded = decodeCursor(cursor, 1);
  if (decoded && typeof decoded[0] !== "string") {
    throw new ApiError(400, "invalid artifact cursor", "INVALID_CURSOR");
  }
  const limit = 100;
  const rows = decoded
    ? await env.DB.prepare(
        `SELECT path, sha256, size, created_at FROM artifact
         WHERE build_id = ? AND path > ? ORDER BY path LIMIT ?`,
      )
        .bind(buildId, decoded[0], limit + 1)
        .all<{ path: string; sha256: string; size: number; created_at: string }>()
    : await env.DB.prepare(
        "SELECT path, sha256, size, created_at FROM artifact WHERE build_id = ? ORDER BY path LIMIT ?",
      )
        .bind(buildId, limit + 1)
        .all<{ path: string; sha256: string; size: number; created_at: string }>();

  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  return {
    artifacts: selected.map((row) => ({
      path: row.path,
      size: row.size,
      uploaded: isoUtc({ created_at: row.created_at }).created_at,
      etag: row.sha256,
      sha256: row.sha256,
    })),
    cursor: hasMore ? encodeCursor([selected[selected.length - 1].path]) : undefined,
  };
}

function normalizePrinterProfile(value: number | PrinterProfile): PrinterProfile {
  const profile = typeof value === "number" ? { x: value, y: value, z: value } : value;
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    Object.keys(profile).some((key) => key !== "x" && key !== "y" && key !== "z")
  ) {
    throw new ApiError(400, "printer_profile must contain x, y, and z", "INVALID_PRINTER_PROFILE");
  }
  for (const axis of ["x", "y", "z"] as const) {
    const dimension = profile[axis];
    if (!Number.isFinite(dimension) || dimension <= 0 || dimension > 1000) {
      throw new ApiError(400, `printer_profile.${axis} must be greater than 0 and at most 1000`, "INVALID_PRINTER_PROFILE");
    }
  }
  return { x: profile.x, y: profile.y, z: profile.z };
}

function validateRuntime(entry: string, timeoutS: number, profile: number | PrinterProfile): QueueSettings["printerProfile"] {
  requireSafePath(entry, "entry path");
  if (!Number.isInteger(timeoutS) || timeoutS < 30 || timeoutS > 900) {
    throw new ApiError(400, "timeout_s must be an integer from 30 to 900", "INVALID_TIMEOUT");
  }
  return normalizePrinterProfile(profile);
}

async function currentBuildInputs(env: Env, projectId: string): Promise<BuildInput[]> {
  const rows = await env.DB.prepare(
    `SELECT s.path, s.version, s.content, s.sha256, s.byte_size FROM source s
     WHERE s.project_id = ? AND s.version = (
       SELECT MAX(version) FROM source WHERE project_id = s.project_id AND path = s.path
     ) ORDER BY s.path`,
  )
    .bind(projectId)
    .all<{ path: string; version: number; content: string; sha256: string | null; byte_size: number | null }>();
  if (!rows.results.length) throw new ApiError(400, "project has no sources; put_source first", "NO_SOURCES");
  if (rows.results.length > MAX_SOURCE_FILES) {
    throw new ApiError(400, `too many source files (max ${MAX_SOURCE_FILES})`, "TOO_MANY_SOURCES");
  }

  let aggregate = 0;
  const inputs: BuildInput[] = [];
  for (const row of rows.results) {
    requireSafePath(row.path, "stored source path");
    const size = byteLength(row.content);
    if (size > MAX_SOURCE_BYTES) {
      throw new ApiError(409, `stored source '${row.path}' exceeds the per-file limit`, "INVALID_STORED_SOURCE");
    }
    aggregate += size;
    inputs.push({
      path: row.path,
      version: row.version,
      content: row.content,
      sha256: await sha256Hex(row.content),
      size,
    });
  }
  if (aggregate > MAX_AGGREGATE_SOURCE_BYTES) {
    throw new ApiError(400, `aggregate source content too large (max ${MAX_AGGREGATE_SOURCE_BYTES} bytes)`, "SOURCES_TOO_LARGE");
  }
  return inputs;
}

async function idempotencyHash(key: string | undefined): Promise<string | null> {
  if (key === undefined) return null;
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new ApiError(400, "idempotency key must be 1-128 visible ASCII characters", "INVALID_IDEMPOTENCY_KEY");
  }
  return sha256Hex(`kiln-idempotency:${key}`);
}

async function idempotentBuild(
  env: Env,
  projectId: string,
  keyHash: string | null,
): Promise<{ id: string; status: string; cancelled_at: string | null } | null> {
  if (!keyHash) return null;
  return env.DB.prepare(
    "SELECT id, status, cancelled_at FROM build WHERE project_id = ? AND idempotency_key = ?",
  )
    .bind(projectId, keyHash)
    .first<{ id: string; status: string; cancelled_at: string | null }>();
}

function queuedResult(
  row: { id: string; status: string; cancelled_at?: string | null },
  replay = false,
): QueuedBuild {
  const status = row.cancelled_at ? "cancelled" : row.status;
  return {
    build_id: row.id,
    status,
    note: replay
      ? "an existing build was returned for this idempotency key"
      : "build runs in the background; poll get_build until it reaches a terminal status",
    ...(replay ? { idempotent_replay: true } : {}),
  };
}

async function queuePinnedBuild(
  env: Env,
  project: ProjectRow,
  inputs: BuildInput[],
  settings: QueueSettings,
  idempotencyKey?: string,
): Promise<QueuedBuild> {
  if (!inputs.some((input) => input.path === settings.entry)) {
    throw new ApiError(400, `entry '${settings.entry}' is not among the project's sources`, "ENTRY_NOT_FOUND");
  }
  const keyHash = await idempotencyHash(idempotencyKey);
  const existing = await idempotentBuild(env, project.id, keyHash);
  if (existing) return queuedResult(existing, true);

  const manifest: SourceManifestEntry[] = inputs.map(({ content: _content, ...entry }) => entry);
  const fingerprint = await sha256Hex(JSON.stringify({
    manifest,
    entry: settings.entry,
    timeout_s: settings.timeoutS,
    printer_profile: settings.printerProfile,
    params_content: settings.paramsContent,
    retry_of: settings.retryOf ?? null,
  }));
  const sourceVersion = Math.max(...inputs.map((input) => input.version));
  const buildId = crypto.randomUUID().slice(0, 12);
  const r2Prefix = `projects/${project.id}/builds/${buildId}/`;

  let admission;
  try {
    admission = await env.DB.prepare(
      `INSERT INTO build (
         id, project_id, source_version, params_json, params_content,
         source_manifest_json, entry, timeout_s, printer_profile_json,
         status, r2_prefix, idempotency_key, idempotency_fingerprint, retry_of
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM build WHERE project_id = ? AND status IN ('queued','running')) < ?
         AND (SELECT COUNT(*) FROM build WHERE status IN ('queued','running')) < ?
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM build WHERE project_id = ? AND idempotency_key = ?
         ))`,
    )
      .bind(
        buildId,
        project.id,
        sourceVersion,
        JSON.stringify(settings.params),
        settings.paramsContent,
        JSON.stringify(manifest),
        settings.entry,
        settings.timeoutS,
        JSON.stringify(settings.printerProfile),
        r2Prefix,
        keyHash,
        fingerprint,
        settings.retryOf ?? null,
        project.id,
        MAX_ACTIVE_BUILDS,
        MAX_GLOBAL_ACTIVE_BUILDS,
        keyHash,
        project.id,
        keyHash,
      )
      .run();
  } catch {
    const raced = await idempotentBuild(env, project.id, keyHash);
    if (raced) return queuedResult(raced, true);
    throw new ApiError(503, "could not admit build", "BUILD_ADMISSION_FAILED");
  }

  if ((admission.meta.changes ?? 0) !== 1) {
    const raced = await idempotentBuild(env, project.id, keyHash);
    if (raced) return queuedResult(raced, true);
    throw new ApiError(
      429,
      `active build quota reached (project ${MAX_ACTIVE_BUILDS}, global ${MAX_GLOBAL_ACTIVE_BUILDS})`,
      "BUILD_QUOTA_EXCEEDED",
    );
  }

  try {
    await env.DB.batch(inputs.map((input) => env.DB.prepare(
      `INSERT INTO build_input
         (build_id, project_id, path, source_version, sha256, size)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(buildId, project.id, input.path, input.version, input.sha256, input.size)));

    await env.BUILD_WORKFLOW.create({
      id: buildId,
      params: {
        build_id: buildId,
        project_id: project.id,
        entry: settings.entry,
        timeout_s: settings.timeoutS,
        printer_volume: settings.printerProfile,
        r2_prefix: r2Prefix,
        files: Object.fromEntries(inputs.map((input) => [input.path, input.version])),
        input_manifest: Object.fromEntries(inputs.map((input) => [input.path, {
          version: input.version,
          sha256: input.sha256,
          size: input.size,
        }])),
        params: settings.params,
        params_content: settings.paramsContent,
      },
    });
  } catch {
    await env.DB.prepare(
      "UPDATE build SET archive_status = 'failed' WHERE id = ? AND status IN ('queued','running')",
    ).bind(buildId).run();
    await finishBuild(env, buildId, "failed", {
      ok: false,
      build_id: buildId,
      artifacts: [],
      error: "build dispatch failed",
      failure_code: "DISPATCH_FAILED",
    }, "DISPATCH_FAILED");
    throw new ApiError(503, "build could not be dispatched", "BUILD_DISPATCH_FAILED");
  }

  return queuedResult({ id: buildId, status: "queued" });
}

export async function runBuild(
  env: Env,
  slug: string,
  entry = "build.py",
  timeoutS = 600,
  bedOrPrinterProfile: number | PrinterProfile = 180,
  idempotencyKey?: string,
): Promise<QueuedBuild> {
  const printerProfile = validateRuntime(entry, timeoutS, bedOrPrinterProfile);
  const project = await getProject(env, slug);
  const existing = await idempotentBuild(env, project.id, await idempotencyHash(idempotencyKey));
  if (existing) return queuedResult(existing, true);
  const inputs = await currentBuildInputs(env, project.id);
  const paramsInput = inputs.find((input) => input.path === PARAMS_PATH);
  const paramsContent = paramsInput?.content ?? "{}\n";
  const params = paramsInput ? parseParams(paramsContent) : {};
  return queuePinnedBuild(env, project, inputs, {
    entry,
    timeoutS,
    printerProfile,
    params,
    paramsContent,
  }, idempotencyKey);
}

export async function retryBuild(
  env: Env,
  slug: string,
  buildId: string,
  idempotencyKey?: string,
): Promise<QueuedBuild> {
  const project = await getProject(env, slug);
  const existing = await idempotentBuild(env, project.id, await idempotencyHash(idempotencyKey));
  if (existing) return queuedResult(existing, true);
  const original = await findBuildRow(env, project.id, buildId);
  if (!original) throw new ApiError(404, `no build '${buildId}'`, "BUILD_NOT_FOUND");
  if (original.status === "queued" || original.status === "running") {
    throw new ApiError(409, "an active build cannot be retried", "BUILD_ACTIVE");
  }
  const rows = await env.DB.prepare(
    `SELECT bi.path, bi.source_version AS version, bi.sha256, bi.size,
            s.content
     FROM build_input bi JOIN source s
       ON s.project_id = bi.project_id AND s.path = bi.path AND s.version = bi.source_version
     WHERE bi.build_id = ? ORDER BY bi.path`,
  )
    .bind(buildId)
    .all<BuildInput>();
  const expected = parseStoredJson(original.source_manifest_json, []);
  if (!rows.results.length || !Array.isArray(expected) || rows.results.length !== expected.length) {
    throw new ApiError(409, "build predates exact input provenance and cannot be retried exactly", "INPUT_PROVENANCE_MISSING");
  }
  const expectedByPath = new Map(expected.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(409, "stored input provenance is invalid", "INPUT_PROVENANCE_MISSING");
    }
    const value = entry as Partial<SourceManifestEntry>;
    if (
      typeof value.path !== "string" ||
      !Number.isInteger(value.version) ||
      typeof value.sha256 !== "string" ||
      !Number.isInteger(value.size)
    ) {
      throw new ApiError(409, "stored input provenance is invalid", "INPUT_PROVENANCE_MISSING");
    }
    return [value.path, value] as const;
  }));
  for (const input of rows.results) {
    const manifestEntry = expectedByPath.get(input.path);
    if (
      !manifestEntry ||
      manifestEntry.version !== input.version ||
      manifestEntry.sha256 !== input.sha256 ||
      manifestEntry.size !== input.size ||
      byteLength(input.content) !== input.size ||
      await sha256Hex(input.content) !== input.sha256
    ) {
      throw new ApiError(409, `pinned source '${input.path}' failed integrity validation`, "INPUT_INTEGRITY_FAILED");
    }
  }
  const printerProfile = normalizePrinterProfile(
    parseStoredJson(original.printer_profile_json, { x: 180, y: 180, z: 180 }) as PrinterProfile,
  );
  validateRuntime(original.entry, original.timeout_s, printerProfile);
  return queuePinnedBuild(env, project, rows.results, {
    entry: original.entry,
    timeoutS: original.timeout_s,
    printerProfile,
    params: normalizeParams(parseStoredJson(original.params_json, {})),
    paramsContent: original.params_content,
    retryOf: buildId,
  }, idempotencyKey);
}

interface WorkflowInstanceCompatibility {
  terminate(): Promise<void>;
}

interface WorkflowBindingCompatibility {
  get(id: string): Promise<WorkflowInstanceCompatibility>;
}

export async function cancelBuild(env: Env, slug: string, buildId: string) {
  const project = await getProject(env, slug);
  const build = await findBuildRow(env, project.id, buildId);
  if (!build) throw new ApiError(404, `no build '${buildId}'`, "BUILD_NOT_FOUND");
  if (build.cancelled_at) return getBuild(env, slug, buildId);
  if (build.status !== "queued" && build.status !== "running") {
    throw new ApiError(409, "only queued or running builds can be cancelled", "BUILD_TERMINAL");
  }

  const report = {
    ok: false,
    cancelled: true,
    status: "cancelled",
    build_id: buildId,
    artifacts: [],
    error: "build cancelled by caller",
    failure_code: "CANCELLED",
  };
  const result = await env.DB.prepare(
    `UPDATE build SET status = 'failed', report_json = ?, failure_code = 'CANCELLED',
       cancelled_at = datetime('now'), finished_at = datetime('now'),
       heartbeat_at = datetime('now'), archive_status = 'failed'
     WHERE id = ? AND project_id = ? AND status IN ('queued','running') AND cancelled_at IS NULL`,
  )
    .bind(JSON.stringify(report), buildId, project.id)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return getBuild(env, slug, buildId);

  let workflow_terminated = false;
  try {
    const workflow = env.BUILD_WORKFLOW as unknown as WorkflowBindingCompatibility;
    const instance = await workflow.get(buildId);
    await instance.terminate();
    workflow_terminated = true;
  } catch {
    // The database cancellation is authoritative. A running workflow cannot
    // overwrite it because all lifecycle updates are conditional.
  }
  let container_destroyed = false;
  try {
    await getContainer(env.ENGINE, buildContainerName(buildId)).destroy();
    container_destroyed = true;
  } catch {}
  let archive_cleaned = false;
  try {
    await clearBuildArchive(env, buildId, build.r2_prefix);
    archive_cleaned = true;
  } catch {}
  return {
    ...(await getBuild(env, slug, buildId)),
    workflow_terminated,
    container_destroyed,
    archive_cleaned,
  };
}

export async function measureArtifact(env: Env, slug: string, buildId: string, path: string) {
  const obj = await getArtifact(env, slug, buildId, path);
  const engine = getContainer(env.ENGINE);
  const res = await engine.fetch(
    new Request("http://engine/measure", { method: "POST", body: await obj.arrayBuffer() }),
  );
  if (!res.ok) {
    throw new ApiError(res.status < 500 ? 422 : 502, "artifact measurement failed", "MEASUREMENT_FAILED");
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
    throw new ApiError(400, "expected and non-negative tolerance must be finite numbers", "INVALID_TARGET");
  }
  if (!path.startsWith("stl/") || !path.endsWith(".stl")) {
    throw new ApiError(400, "verify_target requires a print-oriented stl/*.stl artifact", "INVALID_ARTIFACT_TYPE");
  }
  const measurement = (await measureArtifact(env, slug, buildId, path)) as { extents?: unknown };
  const index = { x: 0, y: 1, z: 2 }[axis];
  const actual = Array.isArray(measurement.extents) ? measurement.extents[index] : undefined;
  if (typeof actual !== "number") throw new ApiError(502, "measure response missing extents", "INVALID_ENGINE_RESPONSE");
  const delta = Math.abs(actual - expected);
  return { axis, expected, tolerance, actual, delta, passed: delta <= tolerance, measurement };
}

export async function finishBuild(
  env: Env,
  buildId: string,
  status: string,
  report: unknown,
  failureCode?: string,
): Promise<boolean> {
  if (status !== "verified" && status !== "failed") {
    throw new ApiError(500, "invalid terminal build status", "INVALID_BUILD_STATUS");
  }
  const result = await env.DB.prepare(
    `UPDATE build SET status = ?, report_json = ?, finished_at = datetime('now'),
       heartbeat_at = datetime('now'), failure_code = ?
     WHERE id = ? AND status IN ('queued','running') AND cancelled_at IS NULL
       AND (? <> 'verified' OR archive_status = 'verified')`,
  )
    .bind(
      status,
      JSON.stringify(report),
      status === "verified" ? null : (failureCode ?? "BUILD_FAILED"),
      buildId,
      status,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function consumeRateLimit(
  env: Env,
  identityHash: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!/^[a-f0-9]{64}$/.test(identityHash) || !/^[a-z0-9_-]{1,40}$/.test(bucket)) {
    throw new ApiError(500, "invalid rate limit identity", "RATE_LIMIT_CONFIGURATION_ERROR");
  }
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new ApiError(500, "invalid rate limit configuration", "RATE_LIMIT_CONFIGURATION_ERROR");
  }
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const expiresAt = windowStart + windowSeconds * 2;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limit (identity_hash, bucket, window_start, count, expires_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(identity_hash, bucket, window_start) DO UPDATE SET
       count = rate_limit.count + 1,
       expires_at = excluded.expires_at
     WHERE rate_limit.count < ?
     RETURNING count`,
  )
    .bind(identityHash, bucket, windowStart, expiresAt, limit)
    .first<{ count: number }>();
  if (!row) {
    const retryAfter = Math.max(1, windowStart + windowSeconds - nowSeconds);
    throw new ApiError(429, "rate limit exceeded", "RATE_LIMITED", { "Retry-After": String(retryAfter) });
  }
  return { count: row.count, limit, remaining: Math.max(0, limit - row.count), reset_at: windowStart + windowSeconds };
}

export async function cleanupRateLimits(
  env: Env,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM rate_limit WHERE expires_at < ?")
    .bind(nowSeconds)
    .run();
  return result.meta.changes ?? 0;
}

export async function reconcileStaleBuilds(
  env: Env,
  staleAfterSeconds = 30 * 60,
): Promise<number> {
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 60) {
    throw new ApiError(500, "invalid stale build interval", "RECONCILIATION_CONFIGURATION_ERROR");
  }
  const report = JSON.stringify({
    ok: false,
    artifacts: [],
    error: "build stopped reporting progress",
    failure_code: "STALE_BUILD",
  });
  const stale = await env.DB.prepare(
    `UPDATE build SET status = 'failed', report_json = ?, failure_code = 'STALE_BUILD',
       archive_status = 'failed', finished_at = datetime('now')
     WHERE id IN (
       SELECT id FROM build
       WHERE status IN ('queued','running') AND cancelled_at IS NULL
         AND COALESCE(heartbeat_at, started_at, created_at) < datetime('now', '-' || ? || ' seconds')
       LIMIT 100
     )
       AND status IN ('queued','running') AND cancelled_at IS NULL
       AND COALESCE(heartbeat_at, started_at, created_at) < datetime('now', '-' || ? || ' seconds')
     RETURNING id, r2_prefix`,
  )
    .bind(report, staleAfterSeconds, staleAfterSeconds)
    .all<{ id: string; r2_prefix: string | null }>();
  if (!stale.results.length) return 0;

  const workflow = env.BUILD_WORKFLOW as unknown as WorkflowBindingCompatibility;
  await Promise.allSettled(stale.results.map(async ({ id, r2_prefix }) => {
    try {
      const instance = await workflow.get(id);
      await instance.terminate();
    } finally {
      await Promise.allSettled([
        getContainer(env.ENGINE, buildContainerName(id)).destroy(),
        clearBuildArchive(env, id, r2_prefix),
      ]);
    }
  }));
  return stale.results.length;
}

async function clearBuildArchive(env: Env, buildId: string, prefix: string | null): Promise<void> {
  await env.DB.prepare("DELETE FROM artifact WHERE build_id = ?").bind(buildId).run();
  if (!prefix) return;
  for (;;) {
    const objects = await env.ARTIFACTS.list({ prefix, limit: 1000 });
    if (!objects.objects.length) return;
    await env.ARTIFACTS.delete(objects.objects.map((object) => object.key));
  }
}
