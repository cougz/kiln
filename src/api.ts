import { z, type ZodType } from "zod";
import * as core from "./core";
import { ApiError } from "./core";
import type { Env } from "./index";

const MAX_JSON_BODY_BYTES = 6 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** A trusted caller (normally src/index.ts) supplies this only after auth. */
export interface ApiAuthorizationContext {
  subject: string;
  canMutate: boolean;
  canCompute: boolean;
  method?: "access" | "api_key";
  email?: string;
}

const projectSchema = z.object({
  slug: z.string().min(2).max(64),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
}).strict();

const projectUpdateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined, {
  message: "name or description is required",
});

const sourceSchema = z.object({
  path: z.string().min(1).max(160),
  content: z.string().max(500_000),
}).strict();

const paramsSchema = z.object({
  params: z.record(z.string(), z.unknown()),
}).strict();

const docSchema = z.object({
  markdown: z.string().max(250_000),
  build_id: z.string().min(1).max(64).optional(),
}).strict();

const printerProfileSchema = z.object({
  x: z.number().finite().positive().max(1000),
  y: z.number().finite().positive().max(1000),
  z: z.number().finite().positive().max(1000),
}).strict();

const buildSchema = z.object({
  entry: z.string().min(1).max(160).default("build.py"),
  timeout_s: z.number().int().min(30).max(900).default(600),
  printer_profile: printerProfileSchema.optional(),
  // Retained for the already-published REST contract; new callers should use printer_profile.
  bed: z.number().finite().positive().max(1000).optional(),
}).strict().refine((body) => !(body.printer_profile && body.bed !== undefined), {
  message: "printer_profile and bed cannot both be supplied",
});

const verifySchema = z.object({
  path: z.string().min(1).max(512),
  axis: z.enum(["x", "y", "z"]),
  expected: z.number().finite(),
  tolerance: z.number().finite().nonnegative(),
}).strict();

const emptySchema = z.object({}).strict();
const paginationSchema = z.object({
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export async function handleApi(
  req: Request,
  env: Env,
  url: URL,
  authorization?: ApiAuthorizationContext,
): Promise<Response> {
  const requestId = requestIdentifier(req);
  try {
    return await route(req, env, url, authorization, requestId);
  } catch (error) {
    if (error instanceof ApiError) {
      return errorResponse(error, requestId);
    }
    return errorResponse(
      new ApiError(500, "an internal error occurred", "INTERNAL_ERROR"),
      requestId,
    );
  }
}

async function route(
  req: Request,
  env: Env,
  url: URL,
  authorization: ApiAuthorizationContext | undefined,
  requestId: string,
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "api") {
    throw new ApiError(404, "not found", "ROUTE_NOT_FOUND");
  }

  if (segments[1] === "session" && segments.length === 2) {
    requireMethod(req, "GET");
    return json({
      authenticated: Boolean(authorization),
      identity: authorization ? {
        method: authorization.method ?? "api_key",
        email: authorization.email ?? null,
      } : null,
      permissions: {
        mutate: authorization?.canMutate === true,
        compute: authorization?.canCompute === true,
      },
    }, 200, requestId);
  }

  if (segments[1] !== "projects") throw new ApiError(404, "not found", "ROUTE_NOT_FOUND");

  if (segments.length === 2) {
    if (req.method === "GET") {
      await rateLimit(env, req, authorization, "read", 180, 60);
      const pagination = paginationOptions(url);
      return json(await core.listProjects(env, pagination), 200, requestId);
    }
    if (req.method === "POST") {
      await protect(env, req, authorization, "mutate");
      const body = await jsonBody(req, projectSchema);
      return json(
        await core.createProject(env, body.slug, body.name, body.description, authorization?.subject),
        201,
        requestId,
      );
    }
    throw methodNotAllowed("GET", "POST");
  }

  const slug = decodeSegment(segments[2], "project slug");
  if (segments.length === 3) {
    if (req.method === "GET") {
      await rateLimit(env, req, authorization, "read", 180, 60);
      return json(await core.getProjectDetail(env, slug), 200, requestId);
    }
    if (req.method === "PATCH") {
      await protect(env, req, authorization, "mutate");
      const body = await jsonBody(req, projectUpdateSchema);
      return json(await core.updateProject(env, slug, body), 200, requestId);
    }
    throw methodNotAllowed("GET", "PATCH");
  }

  if (segments[3] === "source") {
    if (segments.length === 4) {
      requireMethod(req, "PUT");
      await protect(env, req, authorization, "mutate");
      const body = await jsonBody(req, sourceSchema);
      return json(await core.putSource(env, slug, body.path, body.content), 200, requestId);
    }
    requireMethod(req, "GET");
    await rateLimit(env, req, authorization, "read", 180, 60);
    const historyQuery = url.searchParams.get("history") === "1";
    const path = decodePath(segments.slice(4), "source path");
    if (historyQuery) {
      return json(await core.listSourceHistory(env, slug, path, paginationOptions(url) ?? {}), 200, requestId);
    }
    const versionValue = url.searchParams.get("version");
    const version = versionValue === null ? undefined : positiveInteger(versionValue, "version");
    return json(await core.getSource(env, slug, path, version), 200, requestId);
  }

  if (segments[3] === "params" && segments.length === 4) {
    if (req.method === "GET") {
      await rateLimit(env, req, authorization, "read", 180, 60);
      return json(await core.getParams(env, slug), 200, requestId);
    }
    if (req.method === "PUT") {
      await protect(env, req, authorization, "mutate");
      const body = await jsonBody(req, paramsSchema);
      return json(await core.setParams(env, slug, body.params), 200, requestId);
    }
    throw methodNotAllowed("GET", "PUT");
  }

  if (segments[3] === "docs") {
    if (segments.length === 4) {
      requireMethod(req, "GET");
      await rateLimit(env, req, authorization, "read", 180, 60);
      return json(await core.listDocs(env, slug), 200, requestId);
    }
    if (segments.length !== 5) throw new ApiError(404, "not found", "ROUTE_NOT_FOUND");
    const kind = decodeSegment(segments[4], "document kind");
    if (req.method === "GET") {
      await rateLimit(env, req, authorization, "read", 180, 60);
      return json(await core.getDoc(env, slug, kind), 200, requestId);
    }
    if (req.method === "PUT") {
      await protect(env, req, authorization, "mutate");
      const body = await jsonBody(req, docSchema);
      return json(await core.putDoc(env, slug, kind, body.markdown, body.build_id), 200, requestId);
    }
    throw methodNotAllowed("GET", "PUT");
  }

  if (segments[3] === "builds") {
    if (segments.length === 4) {
      if (req.method === "GET") {
        await rateLimit(env, req, authorization, "read", 180, 60);
        return json(await core.listBuilds(env, slug, paginationOptions(url)), 200, requestId);
      }
      if (req.method === "POST") {
        await protect(env, req, authorization, "compute");
        const body = await jsonBody(req, buildSchema);
        const profile = body.printer_profile ?? body.bed ?? 180;
        const key = idempotencyKey(req);
        return json(await core.runBuild(env, slug, body.entry, body.timeout_s, profile, key), 202, requestId);
      }
      throw methodNotAllowed("GET", "POST");
    }

    const buildId = decodeSegment(segments[4], "build id");
    if (segments.length === 5) {
      requireMethod(req, "GET");
      await rateLimit(env, req, authorization, "read", 180, 60);
      return json(await core.getBuild(env, slug, buildId), 200, requestId);
    }

    if (segments.length === 6 && segments[5] === "cancel") {
      requireMethod(req, "POST");
      await protect(env, req, authorization, "mutate");
      await jsonBody(req, emptySchema);
      return json(await core.cancelBuild(env, slug, buildId), 200, requestId);
    }

    if (segments.length === 6 && segments[5] === "retry") {
      requireMethod(req, "POST");
      await protect(env, req, authorization, "compute");
      await jsonBody(req, emptySchema);
      return json(await core.retryBuild(env, slug, buildId, idempotencyKey(req)), 202, requestId);
    }

    if (segments.length === 6 && segments[5] === "verify") {
      requireMethod(req, "POST");
      await protect(env, req, authorization, "compute");
      const body = await jsonBody(req, verifySchema);
      return json(
        await core.verifyTarget(env, slug, buildId, body.path, body.axis, body.expected, body.tolerance),
        200,
        requestId,
      );
    }

    if (segments[5] === "artifacts") {
      requireMethod(req, "GET");
      await rateLimit(env, req, authorization, "read", 180, 60);
      if (segments.length === 6) {
        return json(
          await core.listArtifacts(env, slug, buildId, url.searchParams.get("cursor") ?? undefined),
          200,
          requestId,
        );
      }
      const path = decodePath(segments.slice(6), "artifact path");
      const [object, metadata] = await Promise.all([
        core.getArtifact(env, slug, buildId, path),
        core.getArtifactMetadata(env, slug, buildId, path),
      ]);
      const etag = `"${metadata?.sha256 ?? object.etag}"`;
      const headers = artifactHeaders(path, object.size, etag, requestId);
      if (etagMatches(req.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(object.body, { status: 200, headers });
    }

    throw new ApiError(404, "not found", "ROUTE_NOT_FOUND");
  }

  throw new ApiError(404, "not found", "ROUTE_NOT_FOUND");
}

async function protect(
  env: Env,
  req: Request,
  authorization: ApiAuthorizationContext | undefined,
  permission: "mutate" | "compute",
): Promise<void> {
  if (!authorization || !authorization.subject || authorization.subject.length > 256) {
    throw new ApiError(401, "authentication required", "AUTH_REQUIRED", {
      "WWW-Authenticate": "Bearer",
    });
  }
  const allowed = permission === "mutate" ? authorization.canMutate : authorization.canCompute;
  if (!allowed) throw new ApiError(403, "permission denied", "INSUFFICIENT_PERMISSION");
  if (authorization.method === "access") requireSameOriginBrowserWrite(req);
  if (permission === "compute") {
    await rateLimit(env, req, authorization, "compute", 10, 60);
  } else {
    await rateLimit(env, req, authorization, "mutate", 60, 60);
  }
}

function requireSameOriginBrowserWrite(req: Request): void {
  const fetchSite = req.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    throw new ApiError(403, "cross-origin browser writes are not allowed", "CROSS_ORIGIN_WRITE_FORBIDDEN");
  }
  const origin = req.headers.get("Origin");
  if (origin === null) return;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(req.url).origin;
  } catch {
    throw new ApiError(403, "cross-origin browser writes are not allowed", "CROSS_ORIGIN_WRITE_FORBIDDEN");
  }
  if (origin !== requestOrigin) {
    throw new ApiError(403, "cross-origin browser writes are not allowed", "CROSS_ORIGIN_WRITE_FORBIDDEN");
  }
}

async function rateLimit(
  env: Env,
  req: Request,
  authorization: ApiAuthorizationContext | undefined,
  bucket: "read" | "mutate" | "compute",
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const identity = authorization?.subject
    ? `subject:${authorization.subject}`
    : `client:${req.headers.get("cf-connecting-ip") ?? "unknown"}`;
  const hash = await core.sha256Hex(identity);
  await core.consumeRateLimit(env, hash, bucket, limit, windowSeconds);
}

async function jsonBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new ApiError(415, "content-type must be application/json", "JSON_CONTENT_TYPE_REQUIRED");
  }
  let value: unknown;
  try {
    value = JSON.parse(await limitedBodyText(req, MAX_JSON_BODY_BYTES)) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "request body is not valid JSON", "INVALID_JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ApiError(400, `invalid request body: ${field}${issue?.message ?? "invalid value"}`, "INVALID_BODY");
  }
  return parsed.data;
}

async function limitedBodyText(req: Request, maximum: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    throw new ApiError(413, "request body is too large", "BODY_TOO_LARGE");
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ApiError(413, "request body is too large", "BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new ApiError(400, "request body is not valid UTF-8", "INVALID_JSON");
  }
}

function paginationOptions(url: URL): core.PaginationOptions | undefined {
  const values: Record<string, string> = {};
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  if (cursor !== null) values.cursor = cursor;
  if (limit !== null) values.limit = limit;
  if (!Object.keys(values).length) return undefined;
  const parsed = paginationSchema.safeParse(values);
  if (!parsed.success) throw new ApiError(400, "invalid cursor or limit", "INVALID_PAGINATION");
  return parsed.data;
}

function positiveInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ApiError(400, `${name} must be a positive integer`, "INVALID_QUERY");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(400, `${name} is too large`, "INVALID_QUERY");
  }
  return parsed;
}

function idempotencyKey(req: Request): string | undefined {
  const key = req.headers.get("idempotency-key") ?? undefined;
  if (key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new ApiError(400, "idempotency-key must be 1-128 visible ASCII characters", "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

function requireMethod(req: Request, ...allowed: string[]): void {
  if (!allowed.includes(req.method)) throw methodNotAllowed(...allowed);
}

function methodNotAllowed(...allowed: string[]): ApiError {
  return new ApiError(405, "method not allowed", "METHOD_NOT_ALLOWED", { Allow: allowed.join(", ") });
}

function decodeSegment(value: string | undefined, label: string): string {
  if (!value) throw new ApiError(404, "not found", "ROUTE_NOT_FOUND");
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, `malformed ${label}`, "MALFORMED_PATH");
  }
}

function decodePath(segments: string[], label: string): string {
  if (!segments.length) throw new ApiError(400, `${label} is required`, "INVALID_PATH");
  return segments.map((segment) => decodeSegment(segment, label)).join("/");
}

function requestIdentifier(req: Request): string {
  const ray = req.headers.get("cf-ray")?.split("-", 1)[0];
  return ray && /^[a-zA-Z0-9]{8,64}$/.test(ray) ? ray : crypto.randomUUID();
}

function json(data: unknown, status: number, requestId: string): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    },
  });
}

function errorResponse(error: ApiError, requestId: string): Response {
  const headers = new Headers(error.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-request-id", requestId);
  return new Response(JSON.stringify({
    error: error.message,
    code: error.code,
    request_id: requestId,
  }), { status: error.status, headers });
}

function artifactHeaders(
  path: string,
  size: number,
  etag: string,
  requestId: string,
): Headers {
  return new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(size),
    "content-type": contentType(path),
    etag,
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
}

function etagMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || trimmed === etag || trimmed === `W/${etag}`;
  });
}

function contentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".stl")) return "model/stl";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
