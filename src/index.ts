import { getContainer } from "@cloudflare/containers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { KilnEngine } from "./engine";
import { KilnMcp, MCP_TOOL_PERMISSIONS, type McpProps } from "./mcp";
import { KilnBuildWorkflow } from "./workflow";
import * as core from "./core";
import { ensureDatabaseSchema } from "./schema";
import { APP_VERSION } from "./version";

export { KilnEngine, KilnMcp, KilnBuildWorkflow };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  MCP_OBJECT: DurableObjectNamespace<KilnMcp>;
  BUILD_WORKFLOW: Workflow;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  DB: D1Database;
  KILN_API_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_ORIGINS?: string;
}

const PHASE = "P4";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const PRODUCTION_ORIGIN = "https://kiln.timcf.workers.dev";
const SERVER_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const MCP_ALLOWED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Last-Event-ID",
  "MCP-Protocol-Version",
  "MCP-Session-Id",
  "X-Kiln-API-Key",
].join(", ");
const MAX_MCP_BODY_BYTES = 1024 * 1024;

interface TrustedAuthorization {
  subject: string;
  canMutate: boolean;
  canCompute: boolean;
  method: "access" | "api_key";
  email?: string;
}

interface EngineProbe {
  ok: boolean;
  status: number | null;
  latency_ms: number;
  details?: unknown;
}

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    const requestId = requestIdentifier(req);
    let response: Response;

    try {
      response = await routeRequest(req, env, ctx, url);
    } catch {
      console.error(JSON.stringify({
        event: "request_error",
        request_id: requestId,
        error: "unhandled_exception",
      }));
      response = json({
        error: "an internal error occurred",
        code: "INTERNAL_ERROR",
        request_id: requestId,
      }, "application/json; charset=utf-8", 500);
    }

    response = withSecurityHeaders(response, url);
    console.log(JSON.stringify({
      event: "request",
      request_id: requestId,
      method: req.method,
      path: safeLogPath(url.pathname),
      status: response.status,
      duration_ms: Date.now() - started,
    }));
    return response;
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledMaintenance(controller, env));
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (usesDatabase(url.pathname)) await ensureDatabaseSchema(env);

  if (url.pathname === "/mcp") {
    return handleMcp(req, env, ctx, url);
  }

  if (url.pathname === "/server.json" || url.pathname === "/.well-known/mcp/server.json") {
    if (!isGetOrHead(req)) return methodNotAllowed("GET", "HEAD");
    return forHead(req, json(serverDocument(url.origin), "application/json; charset=utf-8"));
  }

  if (isCompatibilityServerAlias(url.pathname)) {
    if (!isGetOrHead(req)) return methodNotAllowed("GET", "HEAD");
    const response = json(
      serverDocument(url.origin, url.pathname),
      "application/json; charset=utf-8",
    );
    const headers = new Headers(response.headers);
    headers.set("Content-Location", "/server.json");
    headers.set("Deprecation", "true");
    headers.set("Link", '</server.json>; rel="canonical"; type="application/json"');
    return forHead(req, responseWithHeaders(response, headers));
  }

  if (url.pathname === "/.well-known/api-catalog") {
    if (!isGetOrHead(req)) return methodNotAllowed("GET", "HEAD");
    return forHead(req, withApiCatalogLink(json(
      apiCatalog(url.origin),
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    )));
  }

  if (url.pathname === "/.well-known/openapi.json") {
    if (!isGetOrHead(req)) return methodNotAllowed("GET", "HEAD");
    return forHead(req, json(openApi(url.origin), "application/vnd.oai.openapi+json;version=3.1"));
  }

  if (url.pathname === "/.well-known/agent-skills/index.json") {
    if (!isGetOrHead(req)) return methodNotAllowed("GET", "HEAD");
    return forHead(req, json(agentSkillsIndex(url.origin)));
  }

  if (url.pathname === "/sitemap.xml") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    return sitemap(env, url.origin);
  }

  const projectMatch = url.pathname.match(/^\/projects\/([a-z0-9][a-z0-9-]{1,63})\/?$/);
  if (projectMatch && isGetOrHead(req)) {
    if (acceptsMarkdown(req)) {
      try {
        return forHead(req, markdown(await projectMarkdown(env, projectMatch[1])));
      } catch {
        return new Response("project not found\n", {
          status: 404,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            vary: "Accept",
          },
        });
      }
    }
    const response = Response.redirect(`${url.origin}/#/p/${projectMatch[1]}`, 302);
    return withVary(response, "Accept");
  }

  if (url.pathname === "/api/health") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    return healthResponse(env, url.searchParams.get("deep") === "1");
  }

  if (url.pathname === "/api/engine/healthz") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const probe = await probeEngine(env);
    return withNoStore(json(probe, "application/json; charset=utf-8", probe.ok ? 200 : 503));
  }

  if (url.pathname.startsWith("/api/")) {
    const authorization = await authenticate(req, env);
    const { handleApi } = await import("./api");
    return handleApi(req, env, url, authorization);
  }

  if (url.pathname === "/" && isGetOrHead(req) && acceptsMarkdown(req)) {
    return forHead(req, withDiscoveryLinks(markdown(homeMarkdown(url.origin))));
  }

  const response = await env.ASSETS.fetch(req);
  return url.pathname === "/" ? withDiscoveryLinks(response) : response;
}

async function handleMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const browserOrigin = req.headers.get("Origin");
  if (browserOrigin !== null && !isAllowedOrigin(browserOrigin, url.origin, env.ALLOWED_ORIGINS)) {
    return mcpError(403, -32000, "Forbidden: browser origin is not allowed");
  }
  if (req.method === "OPTIONS") {
    return withMcpCors(new Response(null, { status: 204 }), browserOrigin);
  }

  const protocolVersion = req.headers.get("MCP-Protocol-Version");
  if (protocolVersion !== null && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return withMcpCors(
      mcpError(400, -32600, "Unsupported MCP-Protocol-Version", {
        supported: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      }),
      browserOrigin,
    );
  }

  const authorization = await authenticate(req, env);
  let message: Record<string, unknown> | undefined;
  if (req.method === "POST") {
    const inspected = await inspectMcpMessage(req);
    if (inspected instanceof Response) return withMcpCors(inspected, browserOrigin);
    message = inspected;
  }

  try {
    const identity = authorization?.subject
      ? `subject:${authorization.subject}`
      : `client:${req.headers.get("cf-connecting-ip") ?? "unknown"}`;
    await core.consumeRateLimit(env, await core.sha256Hex(identity), "mcp_transport", 240, 60);
  } catch (error) {
    if (error instanceof core.ApiError) {
      const response = mcpError(error.status, -32000, error.message);
      const headers = new Headers(response.headers);
      for (const [name, value] of new Headers(error.headers)) headers.set(name, value);
      return withMcpCors(responseWithHeaders(response, headers), browserOrigin);
    }
    throw error;
  }

  const permission = mcpToolPermission(message);
  if (permission) {
    if (!authorization) {
      const response = mcpError(401, -32001, "authentication required");
      const headers = new Headers(response.headers);
      headers.set("WWW-Authenticate", "Bearer");
      return withMcpCors(responseWithHeaders(response, headers), browserOrigin);
    }
    const allowed = permission === "mutate" ? authorization.canMutate : authorization.canCompute;
    if (!allowed) return withMcpCors(mcpError(403, -32002, "permission denied"), browserOrigin);
    try {
      await core.consumeRateLimit(
        env,
        await core.sha256Hex(`subject:${authorization.subject}`),
        permission,
        permission === "compute" ? 10 : 60,
        60,
      );
    } catch (error) {
      if (error instanceof core.ApiError) {
        const response = mcpError(error.status, -32000, error.message);
        const headers = new Headers(response.headers);
        for (const [name, value] of new Headers(error.headers)) headers.set(name, value);
        return withMcpCors(responseWithHeaders(response, headers), browserOrigin);
      }
      throw error;
    }
  }

  const props: McpProps = { origin: url.origin };
  (ctx as unknown as { props: McpProps }).props = props;
  const response = await KilnMcp.serve("/mcp").fetch(req, env, ctx);
  return withMcpCors(response, browserOrigin);
}

async function inspectMcpMessage(req: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
    return mcpError(413, -32600, "MCP request body is too large");
  }
  const body = req.clone().body;
  if (!body) return mcpError(400, -32700, "MCP request body is required");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_BODY_BYTES) {
      await reader.cancel();
      return mcpError(413, -32600, "MCP request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    return mcpError(400, -32700, "MCP request body is not valid JSON");
  }
  if (Array.isArray(value)) {
    return mcpError(400, -32600, "MCP Streamable HTTP accepts one JSON-RPC message per POST");
  }
  if (!value || typeof value !== "object") {
    return mcpError(400, -32600, "MCP request body must be a JSON-RPC object");
  }
  return value as Record<string, unknown>;
}

function mcpToolPermission(message: Record<string, unknown> | undefined): "mutate" | "compute" | undefined {
  if (message?.method !== "tools/call" || !message.params || typeof message.params !== "object") return undefined;
  const name = (message.params as Record<string, unknown>).name;
  return typeof name === "string"
    ? MCP_TOOL_PERMISSIONS[name as keyof typeof MCP_TOOL_PERMISSIONS]
    : undefined;
}

async function authenticate(req: Request, env: Env): Promise<TrustedAuthorization | undefined> {
  const assertion = req.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion !== null) return authenticateAccessAssertion(assertion, env);

  const expected = env.KILN_API_KEY;
  if (!expected) return undefined;

  const authorization = req.headers.get("Authorization");
  const apiKeyHeader = req.headers.get("X-Kiln-API-Key");
  let bearer: string | undefined;
  if (authorization !== null) {
    const match = authorization.match(/^Bearer[ \t]+([^\s,]+)$/i);
    if (!match) return undefined;
    bearer = match[1];
  }
  if (apiKeyHeader !== null && apiKeyHeader.length === 0) return undefined;
  if (bearer !== undefined && apiKeyHeader !== null && bearer !== apiKeyHeader) return undefined;

  const supplied = bearer ?? apiKeyHeader ?? undefined;
  if (supplied === undefined) return undefined;
  const [expectedDigest, suppliedDigest] = await Promise.all([
    sha256Bytes(expected),
    sha256Bytes(supplied),
  ]);
  if (!constantTimeEqual(expectedDigest, suppliedDigest)) return undefined;

  return {
    subject: `api-key:${hex(expectedDigest)}`,
    canMutate: true,
    canCompute: true,
    method: "api_key",
  };
}

async function authenticateAccessAssertion(
  assertion: string,
  env: Env,
): Promise<TrustedAuthorization | undefined> {
  const configuration = accessConfiguration(env);
  if (!configuration || !assertion) return undefined;
  let jwks = accessJwks.get(configuration.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${configuration.issuer}/cdn-cgi/access/certs`));
    accessJwks.set(configuration.issuer, jwks);
  }

  try {
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer: configuration.issuer,
      audience: configuration.audiences,
      algorithms: ["RS256"],
    });
    if (payload.type !== "app") return undefined;
    const identity = typeof payload.sub === "string" && payload.sub
      ? `user:${payload.sub}`
      : typeof payload.common_name === "string" && payload.common_name
        ? `service:${payload.common_name}`
        : undefined;
    if (!identity || identity.length > 256) return undefined;
    const email = typeof payload.email === "string" && payload.email.length <= 320
      ? payload.email
      : undefined;
    return {
      subject: `access:${identity}`,
      canMutate: true,
      canCompute: true,
      method: "access",
      ...(email ? { email } : {}),
    };
  } catch {
    return undefined;
  }
}

function accessConfiguration(env: Env): { issuer: string; audiences: string[] } | undefined {
  const rawIssuer = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audiences = (env.CF_ACCESS_AUD ?? "")
    .split(",")
    .map((audience) => audience.trim())
    .filter((audience) => /^[\x21-\x7e]{1,256}$/.test(audience));
  if (!rawIssuer || !audiences.length) return undefined;
  try {
    const issuer = new URL(rawIssuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash) {
      return undefined;
    }
    return { issuer: issuer.origin, audiences: [...new Set(audiences)] };
  } catch {
    return undefined;
  }
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAllowedOrigin(origin: string, requestOrigin: string, configured?: string): boolean {
  const normalized = normalizedHttpOrigin(origin);
  if (!normalized) return false;
  if (normalized === requestOrigin) return true;
  return (configured ?? "")
    .split(",")
    .map((candidate) => normalizedHttpOrigin(candidate.trim()))
    .some((candidate) => candidate === normalized);
}

function normalizedHttpOrigin(value: string): string | undefined {
  if (!value || value === "null") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

async function healthResponse(env: Env, deep: boolean): Promise<Response> {
  const [d1, r2, engine] = await Promise.all([
    probeD1(env),
    probeR2(env),
    deep ? probeEngine(env) : Promise.resolve(undefined),
  ]);
  const workflowConfigured = typeof (env.BUILD_WORKFLOW as unknown as { create?: unknown })?.create === "function";
  const ok = d1 && r2 && workflowConfigured && (!deep || engine?.ok === true);
  const accessAuthConfigured = accessConfiguration(env) !== undefined;
  return withNoStore(json({
    ok,
    service: "kiln",
    version: APP_VERSION,
    phase: PHASE,
    write_auth_configured: accessAuthConfigured || Boolean(env.KILN_API_KEY),
    access_auth_configured: accessAuthConfigured,
    d1,
    r2,
    workflow_configured: workflowConfigured,
    workflow: { configured: workflowConfigured },
    ...(deep && engine ? { engine: { probed: true, ...engine } } : {}),
  }, "application/json; charset=utf-8", ok ? 200 : 503));
}

async function probeD1(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

async function probeR2(env: Env): Promise<boolean> {
  try {
    await env.ARTIFACTS.head("healthcheck");
    return true;
  } catch {
    return false;
  }
}

async function probeEngine(env: Env): Promise<EngineProbe> {
  const started = Date.now();
  try {
    const engine = getContainer(env.ENGINE);
    const response = await engine.fetch(new Request("http://engine/healthz", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    }));
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = undefined;
    }
    const bodyOk = isRecord(details) && details.ok === true;
    return {
      ok: response.ok && bodyOk,
      status: response.status,
      latency_ms: Date.now() - started,
      ...(details === undefined ? {} : { details }),
    };
  } catch {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
    };
  }
}

async function runScheduledMaintenance(controller: ScheduledController, env: Env): Promise<void> {
  const started = Date.now();
  try {
    await ensureDatabaseSchema(env);
    const [reconciledBuilds, deletedRateLimits] = await Promise.all([
      core.reconcileStaleBuilds(env),
      core.cleanupRateLimits(env),
    ]);
    console.log(JSON.stringify({
      event: "scheduled_maintenance",
      cron: controller.cron,
      scheduled_time: controller.scheduledTime,
      reconciled_builds: reconciledBuilds,
      deleted_rate_limits: deletedRateLimits,
      duration_ms: Date.now() - started,
      ok: true,
    }));
  } catch {
    console.error(JSON.stringify({
      event: "scheduled_maintenance",
      cron: controller.cron,
      scheduled_time: controller.scheduledTime,
      duration_ms: Date.now() - started,
      ok: false,
      error: "maintenance_failed",
    }));
    throw new Error("scheduled maintenance failed");
  }
}

function usesDatabase(pathname: string): boolean {
  return pathname === "/mcp" ||
    pathname === "/sitemap.xml" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/projects") ||
    pathname.startsWith("/projects/");
}

function serverDocument(origin: string, compatibilityAlias?: string) {
  return {
    $schema: SERVER_SCHEMA,
    name: "io.github.cougz/kiln",
    title: "kiln",
    description: "Versioned CadQuery projects and verified cloud builds with immutable 3D-print artifacts.",
    version: APP_VERSION,
    websiteUrl: `${origin}/`,
    repository: {
      url: "https://github.com/cougz/kiln",
      source: "github",
    },
    remotes: [
      {
        type: "streamable-http",
        url: `${origin}/mcp`,
      },
    ],
    _meta: {
      "io.modelcontextprotocol.registry/publisher-provided": {
        discovery: {
          format: "MCP Registry server.json",
          canonical: `${origin}/server.json`,
          production_origin: PRODUCTION_ORIGIN,
          ...(compatibilityAlias
            ? {
                compatibility_alias: compatibilityAlias,
                notice: "Compatibility alias for server.json; not a ratified MCP Server Card endpoint.",
              }
            : {}),
        },
        authentication: {
          public_reads: true,
          protected_operations: ["write", "compute"],
          preferred: "Cloudflare Access Managed OAuth with RFC 8707",
          transition_fallback: ["Authorization: Bearer <key>", "X-Kiln-API-Key: <key>"],
        },
        api: {
          openapi: `${origin}/.well-known/openapi.json`,
          catalog: `${origin}/.well-known/api-catalog`,
        },
      },
    },
  };
}

function isCompatibilityServerAlias(pathname: string): boolean {
  return pathname === "/.well-known/mcp.json" ||
    pathname === "/.well-known/mcp/server-card.json" ||
    pathname === "/.well-known/mcp/server-cards.json";
}

function apiCatalog(origin: string) {
  return {
    linkset: [
      {
        anchor: `${origin}/api/projects`,
        "service-desc": [
          {
            href: `${origin}/.well-known/openapi.json`,
            type: "application/vnd.oai.openapi+json;version=3.1",
            title: "kiln REST OpenAPI description",
          },
        ],
        "service-doc": [
          {
            href: `${origin}/api.md`,
            type: "text/markdown",
            title: "kiln REST API documentation",
          },
        ],
        status: [{ href: `${origin}/api/health`, type: "application/json" }],
        describedby: [{ href: `${origin}/llms.txt`, type: "text/plain" }],
      },
      {
        anchor: `${origin}/mcp`,
        "service-desc": [
          {
            href: `${origin}/server.json`,
            type: "application/json",
            title: "MCP Registry server metadata",
          },
        ],
        "service-doc": [{ href: `${origin}/llms.txt`, type: "text/plain" }],
        status: [{ href: `${origin}/api/health`, type: "application/json" }],
      },
      {
        anchor: `${origin}/agent-skills/kiln-cad-builds/SKILL.md`,
        describedby: [
          {
            href: `${origin}/.well-known/agent-skills/index.json`,
            type: "application/json",
            title: "Non-standard Agent Skills compatibility index",
          },
        ],
      },
    ],
  };
}

function openApi(origin: string) {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const parameterRef = (name: string) => ({ $ref: `#/components/parameters/${name}` });
  const jsonResponse = (description: string, schema: unknown, example?: unknown) => ({
    description,
    content: {
      "application/json": {
        schema,
        ...(example === undefined ? {} : { example }),
      },
    },
  });
  const errorResponseNames: Record<string, string> = {
    "400": "BadRequest",
    "401": "Unauthorized",
    "403": "Forbidden",
    "404": "NotFound",
    "405": "MethodNotAllowed",
    "409": "Conflict",
    "413": "PayloadTooLarge",
    "415": "UnsupportedMediaType",
    "422": "UnprocessableEntity",
    "429": "TooManyRequests",
    "500": "InternalError",
    "502": "BadGateway",
    "503": "ServiceUnavailable",
  };
  const errors = (...statuses: string[]): Record<string, unknown> => Object.fromEntries(
    statuses.map((status) => [status, { $ref: `#/components/responses/${errorResponseNames[status]}` }]),
  );
  const protectedSecurity = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

  return {
    openapi: "3.1.1",
    info: {
      title: "kiln REST API",
      version: APP_VERSION,
      description: [
        "Public reads for versioned CadQuery projects and immutable build artifacts.",
        "Writes and compute require Cloudflare Access or the transition API key. Geometry checks are preflight heuristics, not manufacturing or safety certification.",
      ].join(" "),
    },
    servers: [{ url: origin, description: "Current kiln deployment" }],
    tags: [
      { name: "Service" },
      { name: "Projects" },
      { name: "Sources" },
      { name: "Documents" },
      { name: "Builds" },
      { name: "Artifacts" },
    ],
    security: [],
    paths: {
      "/api/health": {
        get: {
          operationId: "getHealth",
          tags: ["Service"],
          summary: "Check Worker dependencies",
          description: "Checks D1, R2, and workflow binding configuration. Set deep=1 to start and probe the CAD engine.",
          parameters: [parameterRef("DeepHealth")],
          responses: {
            "200": jsonResponse("Configured dependencies are ready", ref("Health"), {
              ok: true,
              service: "kiln",
              version: APP_VERSION,
              phase: PHASE,
              write_auth_configured: true,
              access_auth_configured: true,
              d1: true,
              r2: true,
              workflow_configured: true,
              workflow: { configured: true },
            }),
            ...errors("503"),
          },
        },
      },
      "/api/engine/healthz": {
        get: {
          operationId: "getEngineHealth",
          tags: ["Service"],
          summary: "Probe the CAD engine",
          description: "Starts or reuses the utility engine container and reports its import health.",
          responses: {
            "200": jsonResponse("Engine is ready", {
              type: "object",
              required: ["ok", "status", "latency_ms"],
              properties: {
                ok: { type: "boolean" },
                status: { type: ["integer", "null"] },
                latency_ms: { type: "integer", minimum: 0 },
                details: {},
              },
            }),
            ...errors("503"),
          },
        },
      },
      "/api/session": {
        get: {
          operationId: "getSession",
          tags: ["Service"],
          summary: "Read the current authentication state",
          description: "Returns a sanitized Access or transition-key identity summary without exposing credentials or the stable subject.",
          responses: {
            "200": jsonResponse("Current session and permissions", ref("Session")),
          },
        },
      },
      "/api/projects": {
        get: {
          operationId: "listProjects",
          tags: ["Projects"],
          summary: "List public projects",
          description: "Without pagination parameters the legacy response is an array. Supplying cursor or limit returns a page object.",
          parameters: [parameterRef("Cursor"), parameterRef("Limit")],
          responses: {
            "200": jsonResponse("Project list or cursor page", {
              oneOf: [
                { type: "array", items: ref("Project") },
                ref("ProjectPage"),
              ],
            }),
            ...errors("400", "429", "500"),
          },
        },
        post: {
          operationId: "createProject",
          tags: ["Projects"],
          summary: "Create a project",
          security: protectedSecurity,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("ProjectCreate"),
                example: { slug: "mounting-bracket", name: "Mounting bracket", description: "Parametric wall bracket" },
              },
            },
          },
          responses: {
            "201": jsonResponse("Project created", ref("ProjectCreated")),
            ...errors("400", "401", "403", "409", "413", "415", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}": {
        get: {
          operationId: "getProject",
          tags: ["Projects"],
          summary: "Get project detail",
          parameters: [parameterRef("Slug")],
          responses: {
            "200": jsonResponse("Project, source heads, documents, and recent builds", ref("ProjectDetail")),
            ...errors("404", "429", "500"),
          },
        },
        patch: {
          operationId: "updateProject",
          tags: ["Projects"],
          summary: "Update public project metadata",
          security: protectedSecurity,
          parameters: [parameterRef("Slug")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("ProjectUpdate"),
                example: { name: "Wall mounting bracket", description: "Parameterized bracket family" },
              },
            },
          },
          responses: {
            "200": jsonResponse("Updated project metadata", ref("ProjectIdentity")),
            ...errors("400", "401", "403", "404", "413", "415", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/source": {
        put: {
          operationId: "putProjectSource",
          tags: ["Sources"],
          summary: "Append an immutable source version",
          security: protectedSecurity,
          parameters: [parameterRef("Slug")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("SourceWrite"),
                example: { path: "build.py", content: "import cadquery as cq\n" },
              },
            },
          },
          responses: {
            "200": jsonResponse("Stored or deduplicated source version", ref("SourceStored")),
            ...errors("400", "401", "403", "404", "409", "413", "415", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/source/{path}": {
        get: {
          operationId: "getProjectSource",
          tags: ["Sources"],
          summary: "Get source content, version, or history",
          description: "The path may contain slash-separated segments. Use version for one immutable version or history=1 for metadata history.",
          parameters: [
            parameterRef("Slug"),
            parameterRef("SourcePath"),
            parameterRef("SourceVersion"),
            parameterRef("History"),
            parameterRef("Cursor"),
            parameterRef("Limit"),
          ],
          responses: {
            "200": jsonResponse("Source version or history page", {
              oneOf: [ref("Source"), ref("SourceHistory")],
            }),
            ...errors("400", "404", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/params": {
        get: {
          operationId: "getProjectParams",
          tags: ["Sources"],
          summary: "Get versioned build parameters",
          parameters: [parameterRef("Slug")],
          responses: {
            "200": jsonResponse("Current parameters and source version", ref("Params")),
            ...errors("404", "429", "500"),
          },
        },
        put: {
          operationId: "putProjectParams",
          tags: ["Sources"],
          summary: "Store versioned build parameters",
          security: protectedSecurity,
          parameters: [parameterRef("Slug")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("ParamsWrite"),
                example: { params: { width: 42, clearance: 0.25 } },
              },
            },
          },
          responses: {
            "200": jsonResponse("Stored parameters and source version", ref("Params")),
            ...errors("400", "401", "403", "404", "413", "415", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/docs": {
        get: {
          operationId: "listProjectDocuments",
          tags: ["Documents"],
          summary: "List project documents",
          parameters: [parameterRef("Slug")],
          responses: {
            "200": jsonResponse("Document metadata", { type: "array", items: ref("DocumentSummary") }),
            ...errors("404", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/docs/{kind}": {
        get: {
          operationId: "getProjectDocument",
          tags: ["Documents"],
          summary: "Get a Markdown project document",
          parameters: [parameterRef("Slug"), parameterRef("DocumentKind")],
          responses: {
            "200": jsonResponse("Project document", ref("Document")),
            ...errors("400", "404", "429", "500"),
          },
        },
        put: {
          operationId: "putProjectDocument",
          tags: ["Documents"],
          summary: "Create or replace a project document",
          security: protectedSecurity,
          parameters: [parameterRef("Slug"), parameterRef("DocumentKind")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("DocumentWrite"),
                example: { markdown: "# Print instructions\n", build_id: "bld_01" },
              },
            },
          },
          responses: {
            "200": jsonResponse("Stored project document", ref("Document")),
            ...errors("400", "401", "403", "404", "413", "415", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/builds": {
        get: {
          operationId: "listProjectBuilds",
          tags: ["Builds"],
          summary: "List project builds",
          description: "Without pagination parameters the legacy response is an array. Supplying cursor or limit returns a page object.",
          parameters: [parameterRef("Slug"), parameterRef("Cursor"), parameterRef("Limit")],
          responses: {
            "200": jsonResponse("Build list or cursor page", {
              oneOf: [
                { type: "array", items: ref("BuildSummary") },
                ref("BuildPage"),
              ],
            }),
            ...errors("400", "404", "429", "500"),
          },
        },
        post: {
          operationId: "queueProjectBuild",
          tags: ["Builds"],
          summary: "Queue an asynchronous build",
          security: protectedSecurity,
          parameters: [parameterRef("Slug"), parameterRef("IdempotencyKey")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("BuildRequest"),
                example: {
                  entry: "build.py",
                  timeout_s: 600,
                  printer_profile: { x: 220, y: 220, z: 250 },
                },
              },
            },
          },
          responses: {
            "202": jsonResponse("Build queued with pinned source and parameter provenance", ref("QueuedBuild")),
            ...errors("400", "401", "403", "404", "409", "413", "415", "429", "500", "503"),
          },
        },
      },
      "/api/projects/{slug}/builds/{buildId}": {
        get: {
          operationId: "getProjectBuild",
          tags: ["Builds"],
          summary: "Get build status, provenance, and verification report",
          parameters: [parameterRef("Slug"), parameterRef("BuildId")],
          responses: {
            "200": jsonResponse("Build lifecycle and pinned inputs", ref("Build")),
            ...errors("404", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/cancel": {
        post: {
          operationId: "cancelProjectBuild",
          tags: ["Builds"],
          summary: "Cancel a queued or running build",
          security: protectedSecurity,
          parameters: [parameterRef("Slug"), parameterRef("BuildId")],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("EmptyBody"), example: {} } },
          },
          responses: {
            "200": jsonResponse("Build marked cancelled", ref("Build")),
            ...errors("400", "401", "403", "404", "409", "413", "415", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/retry": {
        post: {
          operationId: "retryProjectBuild",
          tags: ["Builds"],
          summary: "Retry a terminal build from exact pinned inputs",
          security: protectedSecurity,
          parameters: [parameterRef("Slug"), parameterRef("BuildId"), parameterRef("IdempotencyKey")],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("EmptyBody"), example: {} } },
          },
          responses: {
            "202": jsonResponse("Exact retry queued", ref("QueuedBuild")),
            ...errors("400", "401", "403", "404", "409", "413", "415", "429", "500", "503"),
          },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/verify": {
        post: {
          operationId: "verifyProjectBuildArtifact",
          tags: ["Builds"],
          summary: "Measure an STL extent against a target",
          description: "Geometry preflight only; this does not certify printability, fit, strength, or safety.",
          security: protectedSecurity,
          parameters: [parameterRef("Slug"), parameterRef("BuildId")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref("VerificationRequest"),
                example: { path: "stl/bracket.stl", axis: "x", expected: 42, tolerance: 0.1 },
              },
            },
          },
          responses: {
            "200": jsonResponse("Measured extent and pass/fail comparison", ref("VerificationResult")),
            ...errors("400", "401", "403", "404", "409", "413", "415", "422", "429", "500", "502", "503"),
          },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/artifacts": {
        get: {
          operationId: "listProjectBuildArtifacts",
          tags: ["Artifacts"],
          summary: "List immutable archived artifacts",
          parameters: [parameterRef("Slug"), parameterRef("BuildId"), parameterRef("Cursor")],
          responses: {
            "200": jsonResponse("Artifact inventory page", ref("ArtifactPage")),
            ...errors("400", "404", "409", "429", "500"),
          },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/artifacts/{path}": {
        get: {
          operationId: "downloadProjectBuildArtifact",
          tags: ["Artifacts"],
          summary: "Download an immutable build artifact",
          parameters: [
            parameterRef("Slug"),
            parameterRef("BuildId"),
            parameterRef("ArtifactPath"),
            parameterRef("IfNoneMatch"),
          ],
          responses: {
            "200": {
              description: "Artifact bytes. Content-Type reflects the archived file type.",
              headers: {
                ETag: { schema: { type: "string" }, description: "Artifact SHA-256 or object ETag" },
                "Content-Length": { schema: { type: "integer" } },
              },
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
                "model/stl": { schema: { type: "string", format: "binary" } },
                "image/png": { schema: { type: "string", format: "binary" } },
                "application/json": { schema: {} },
                "text/markdown": { schema: { type: "string" } },
              },
            },
            "304": { description: "The supplied ETag still matches" },
            ...errors("400", "404", "409", "429", "500"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Cloudflare Access Managed OAuth opaque bearer token, or the transition KILN_API_KEY. Required only for write and compute operations.",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Kiln-API-Key",
          description: "Transition KILN_API_KEY header alternative for existing automation. Never place the key in a URL.",
        },
      },
      parameters: {
        Slug: {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,63}$", maxLength: 64 },
          example: "mounting-bracket",
        },
        BuildId: {
          name: "buildId",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 64 },
        },
        SourcePath: {
          name: "path",
          in: "path",
          required: true,
          description: "Slash-separated project-relative source path",
          schema: { type: "string", minLength: 1, maxLength: 160 },
          example: "lib/geometry.py",
        },
        ArtifactPath: {
          name: "path",
          in: "path",
          required: true,
          description: "Slash-separated project-relative artifact path",
          schema: { type: "string", minLength: 1, maxLength: 512 },
          example: "stl/bracket.stl",
        },
        Cursor: {
          name: "cursor",
          in: "query",
          description: "Opaque cursor returned by the previous page",
          schema: { type: "string", minLength: 1, maxLength: 2000 },
        },
        Limit: {
          name: "limit",
          in: "query",
          description: "Page size; defaults to 25 and is capped at 100",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
        SourceVersion: {
          name: "version",
          in: "query",
          description: "Specific immutable source version; latest when omitted",
          schema: { type: "integer", minimum: 1 },
        },
        History: {
          name: "history",
          in: "query",
          description: "Return source history metadata instead of content",
          schema: { type: "string", enum: ["1"] },
        },
        DeepHealth: {
          name: "deep",
          in: "query",
          description: "Probe the engine container when set to 1; may incur a cold start",
          schema: { type: "string", enum: ["1"] },
        },
        DocumentKind: {
          name: "kind",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["specification", "instructions", "bom", "page"] },
        },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          description: "Optional 1-128 character key for idempotent build queueing",
          schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[!-~]+$" },
        },
        IfNoneMatch: {
          name: "If-None-Match",
          in: "header",
          schema: { type: "string" },
        },
      },
      responses: Object.fromEntries(Object.entries({
        BadRequest: ["Malformed path, query, or request body", 400, "INVALID_REQUEST"],
        Unauthorized: ["Missing or invalid authentication", 401, "AUTH_REQUIRED"],
        Forbidden: ["Authenticated caller lacks permission or violates browser-origin policy", 403, "INSUFFICIENT_PERMISSION"],
        NotFound: ["Resource was not found", 404, "NOT_FOUND"],
        MethodNotAllowed: ["HTTP method is not supported", 405, "METHOD_NOT_ALLOWED"],
        Conflict: ["Request conflicts with current resource state", 409, "CONFLICT"],
        PayloadTooLarge: ["Request body exceeds the 6 MiB transport limit", 413, "BODY_TOO_LARGE"],
        UnsupportedMediaType: ["A JSON request body requires application/json", 415, "JSON_CONTENT_TYPE_REQUIRED"],
        UnprocessableEntity: ["Artifact geometry could not be measured", 422, "MEASUREMENT_FAILED"],
        TooManyRequests: ["Rate limit exceeded", 429, "RATE_LIMITED"],
        InternalError: ["Internal service error", 500, "INTERNAL_ERROR"],
        BadGateway: ["The engine returned an invalid or failed response", 502, "INVALID_ENGINE_RESPONSE"],
        ServiceUnavailable: ["A required dependency is unavailable", 503, "SERVICE_UNAVAILABLE"],
      }).map(([name, value]) => {
        const [description, status, code] = value as [string, number, string];
        return [name, {
          ...jsonResponse(description, ref("Error"), {
            error: description.toLowerCase(),
            code,
            request_id: "7d6f2a8c-5cb6-48bb-a0d6-bc39b25449cc",
          }),
          ...(status === 401
            ? { headers: { "WWW-Authenticate": { schema: { type: "string", example: "Bearer" } } } }
            : {}),
          ...(status === 429
            ? { headers: { "Retry-After": { schema: { type: "integer", minimum: 1 } } } }
            : {}),
        }];
      })),
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code", "request_id"],
          additionalProperties: false,
          properties: {
            error: { type: "string" },
            code: { type: "string" },
            request_id: { type: "string" },
          },
        },
        Health: {
          type: "object",
          required: ["ok", "service", "version", "phase", "write_auth_configured", "access_auth_configured", "d1", "r2", "workflow_configured", "workflow"],
          properties: {
            ok: { type: "boolean" },
            service: { const: "kiln" },
            version: { type: "string", example: APP_VERSION },
            phase: { type: "string" },
            write_auth_configured: { type: "boolean" },
            access_auth_configured: { type: "boolean" },
            d1: { type: "boolean" },
            r2: { type: "boolean" },
            workflow_configured: { type: "boolean" },
            workflow: {
              type: "object",
              required: ["configured"],
              properties: { configured: { type: "boolean" } },
            },
            engine: {
              type: "object",
              required: ["probed", "ok", "status", "latency_ms"],
              properties: {
                probed: { const: true },
                ok: { type: "boolean" },
                status: { type: ["integer", "null"] },
                latency_ms: { type: "integer", minimum: 0 },
                details: {},
              },
            },
          },
        },
        Session: {
          type: "object",
          required: ["authenticated", "identity", "permissions"],
          additionalProperties: false,
          properties: {
            authenticated: { type: "boolean" },
            identity: {
              oneOf: [
                { type: "null" },
                {
                  type: "object",
                  required: ["method", "email"],
                  additionalProperties: false,
                  properties: {
                    method: { type: "string", enum: ["access", "api_key"] },
                    email: { type: ["string", "null"] },
                  },
                },
              ],
            },
            permissions: {
              type: "object",
              required: ["mutate", "compute"],
              additionalProperties: false,
              properties: {
                mutate: { type: "boolean" },
                compute: { type: "boolean" },
              },
            },
          },
        },
        Project: {
          type: "object",
          required: ["slug", "name", "description", "created_at"],
          properties: {
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            created_at: { type: "string", format: "date-time" },
          },
        },
        ProjectCreate: {
          type: "object",
          required: ["slug"],
          additionalProperties: false,
          properties: {
            slug: { type: "string", minLength: 2, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]+$" },
            name: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: "string", maxLength: 2000 },
          },
        },
        ProjectCreated: {
          type: "object",
          required: ["id", "slug"],
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
          },
        },
        ProjectIdentity: {
          type: "object",
          required: ["id", "slug", "name", "description"],
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
          },
        },
        ProjectUpdate: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: "string", maxLength: 2000 },
          },
        },
        ProjectPage: {
          type: "object",
          required: ["projects"],
          properties: {
            projects: { type: "array", items: ref("Project") },
            cursor: { type: "string" },
          },
        },
        ProjectDetail: {
          type: "object",
          required: ["id", "slug", "name", "description", "sources", "recent_builds", "docs"],
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            sources: {
              type: "array",
              items: {
                type: "object",
                required: ["path", "version"],
                properties: {
                  path: { type: "string" },
                  version: { type: "integer", minimum: 1 },
                },
              },
            },
            recent_builds: { type: "array", items: ref("BuildSummary") },
            docs: { type: "array", items: ref("DocumentSummary") },
          },
        },
        SourceWrite: {
          type: "object",
          required: ["path", "content"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 160 },
            content: { type: "string", maxLength: 500000, description: "Maximum 500,000 UTF-8 bytes" },
          },
        },
        SourceStored: {
          type: "object",
          required: ["path", "version", "sha256", "size", "deduplicated"],
          properties: {
            path: { type: "string" },
            version: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            size: { type: "integer", minimum: 0 },
            deduplicated: { type: "boolean" },
          },
        },
        Source: {
          type: "object",
          required: ["content", "version", "sha256", "size", "created_at"],
          properties: {
            content: { type: "string" },
            version: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            size: { type: "integer", minimum: 0 },
            created_at: { type: "string", format: "date-time" },
          },
        },
        SourceVersion: {
          type: "object",
          required: ["version", "sha256", "size", "created_at"],
          properties: {
            version: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            size: { type: "integer", minimum: 0 },
            created_at: { type: "string", format: "date-time" },
          },
        },
        SourceHistory: {
          type: "object",
          required: ["path", "versions"],
          properties: {
            path: { type: "string" },
            versions: { type: "array", items: ref("SourceVersion") },
            cursor: { type: "string" },
          },
        },
        ParamsWrite: {
          type: "object",
          required: ["params"],
          additionalProperties: false,
          properties: {
            params: { type: "object", maxProperties: 1000, additionalProperties: true },
          },
        },
        Params: {
          type: "object",
          required: ["params", "version"],
          properties: {
            params: { type: "object", additionalProperties: true, description: "Canonical JSON, limited to 50,000 UTF-8 bytes" },
            version: { type: "integer", minimum: 0 },
            deduplicated: { type: "boolean" },
          },
        },
        DocumentSummary: {
          type: "object",
          required: ["kind", "updated_at"],
          properties: {
            kind: { type: "string", enum: ["specification", "instructions", "bom", "page"] },
            build_id: { type: ["string", "null"] },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        Document: {
          allOf: [
            ref("DocumentSummary"),
            {
              type: "object",
              required: ["markdown"],
              properties: { markdown: { type: "string", description: "Maximum 250,000 UTF-8 bytes" } },
            },
          ],
        },
        DocumentWrite: {
          type: "object",
          required: ["markdown"],
          additionalProperties: false,
          properties: {
            markdown: { type: "string", maxLength: 250000 },
            build_id: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        PrinterProfile: {
          type: "object",
          required: ["x", "y", "z"],
          additionalProperties: false,
          description: "Printer build volume in millimeters",
          properties: {
            x: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
            y: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
            z: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          },
        },
        BuildRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            entry: { type: "string", minLength: 1, maxLength: 160, default: "build.py" },
            timeout_s: { type: "integer", minimum: 30, maximum: 900, default: 600 },
            printer_profile: ref("PrinterProfile"),
            bed: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: 1000,
              deprecated: true,
              description: "Legacy cubic build volume; do not combine with printer_profile",
            },
          },
          not: { required: ["printer_profile", "bed"] },
        },
        QueuedBuild: {
          type: "object",
          required: ["build_id", "status", "note"],
          properties: {
            build_id: { type: "string" },
            status: { type: "string", enum: ["queued", "running", "verified", "failed", "cancelled"] },
            note: { type: "string" },
            idempotent_replay: { type: "boolean" },
          },
        },
        BuildSummary: {
          type: "object",
          required: ["id", "status", "created_at"],
          properties: {
            id: { type: "string" },
            source_version: { type: "integer", minimum: 0 },
            status: { type: "string", enum: ["queued", "running", "verified", "failed", "cancelled"] },
            cancelled_at: { type: ["string", "null"], format: "date-time" },
            created_at: { type: "string", format: "date-time" },
            finished_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        BuildPage: {
          type: "object",
          required: ["builds"],
          properties: {
            builds: { type: "array", items: ref("BuildSummary") },
            cursor: { type: "string" },
          },
        },
        SourceManifestEntry: {
          type: "object",
          required: ["path", "version", "sha256", "size"],
          properties: {
            path: { type: "string" },
            version: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            size: { type: "integer", minimum: 0 },
          },
        },
        Build: {
          allOf: [
            ref("BuildSummary"),
            {
              type: "object",
              required: [
                "entry",
                "timeout_s",
                "printer_profile",
                "params",
                "source_manifest",
                "provenance_status",
                "attempt",
                "archive_status",
              ],
              properties: {
                project_id: { type: "string" },
                database_status: { type: "string" },
                entry: { type: ["string", "null"] },
                timeout_s: { type: ["integer", "null"], minimum: 30, maximum: 900 },
                printer_profile: { oneOf: [ref("PrinterProfile"), { type: "null" }] },
                params: { type: "object", additionalProperties: true },
                params_content: { type: ["string", "null"], description: "Exact pinned params.json content, or null for legacy builds" },
                source_manifest: { type: "array", items: ref("SourceManifestEntry") },
                provenance_status: { type: "string", enum: ["exact", "legacy_unavailable"] },
                retry_of: { type: ["string", "null"] },
                attempt: { type: "integer", minimum: 0 },
                archive_status: { type: "string", enum: ["pending", "archiving", "verified", "failed", "legacy"] },
                report_json: {
                  type: ["object", "null"],
                  additionalProperties: true,
                  description: "Engine geometry-preflight report and artifact manifest",
                },
                failure_code: { type: ["string", "null"] },
                started_at: { type: ["string", "null"], format: "date-time" },
                heartbeat_at: { type: ["string", "null"], format: "date-time" },
                archived_at: { type: ["string", "null"], format: "date-time" },
              },
            },
          ],
        },
        Artifact: {
          type: "object",
          required: ["path", "size"],
          properties: {
            path: { type: "string" },
            size: { type: "integer", minimum: 0 },
            uploaded: { type: "string", format: "date-time" },
            etag: { type: "string" },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        ArtifactPage: {
          type: "object",
          required: ["artifacts"],
          properties: {
            artifacts: { type: "array", maxItems: 100, items: ref("Artifact") },
            cursor: { type: "string" },
          },
        },
        VerificationRequest: {
          type: "object",
          required: ["path", "axis", "expected", "tolerance"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 512, pattern: "^stl/.+\\.stl$" },
            axis: { type: "string", enum: ["x", "y", "z"] },
            expected: { type: "number" },
            tolerance: { type: "number", minimum: 0 },
          },
        },
        VerificationResult: {
          type: "object",
          required: ["axis", "expected", "tolerance", "actual", "delta", "passed", "measurement"],
          properties: {
            axis: { type: "string", enum: ["x", "y", "z"] },
            expected: { type: "number" },
            tolerance: { type: "number", minimum: 0 },
            actual: { type: "number" },
            delta: { type: "number", minimum: 0 },
            passed: { type: "boolean" },
            measurement: {
              type: "object",
              properties: {
                extents: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } },
                bounds: { type: "array", items: { type: "array", items: { type: "number" } } },
                watertight: { type: "boolean" },
                volume: { type: ["number", "null"] },
                triangles: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        EmptyBody: {
          type: "object",
          maxProperties: 0,
          additionalProperties: false,
        },
      },
    },
    "x-kiln-limits": {
      request_body_bytes: 6291456,
      source_file_bytes: 500000,
      aggregate_source_bytes: 5242880,
      source_files: 128,
      document_bytes: 250000,
      params_bytes: 50000,
      page_size_default: 25,
      page_size_maximum: 100,
      active_builds_per_project: 2,
      active_builds_global: 2,
      artifact_bytes: 16777216,
      aggregate_artifact_bytes: 67108864,
      build_timeout_seconds: { minimum: 30, maximum: 900 },
    },
  };
}

function agentSkillsIndex(origin: string) {
  return {
    format: "Agent Skills compatibility index",
    status: "non-standard compatibility discovery; no ratified schema is claimed",
    skills: [
      {
        name: "kiln-cad-builds",
        type: "skill-md",
        description: "Author versioned CadQuery projects and inspect bounded geometry-preflight builds with kiln.",
        url: `${origin}/agent-skills/kiln-cad-builds/SKILL.md`,
        digest: "sha256:19616faa8b150049cd7da2325a40446b9667db3bb50a7af974a3e84f7c9552ab",
      },
    ],
  };
}

function json(
  data: unknown,
  contentType = "application/json; charset=utf-8",
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": status >= 400 ? "no-store" : "public, max-age=300",
    },
  });
}

function mcpError(status: number, code: number, message: string, data?: unknown): Response {
  return json({
    jsonrpc: "2.0",
    error: { code, message, ...(data === undefined ? {} : { data }) },
    id: null,
  }, "application/json; charset=utf-8", status);
}

function acceptsMarkdown(req: Request): boolean {
  const accept = req.headers.get("Accept");
  if (!accept) return false;
  const markdownQuality = acceptedQuality(accept, "text", "markdown");
  const htmlQuality = acceptedQuality(accept, "text", "html");
  return markdownQuality > 0 && markdownQuality > htmlQuality;
}

function acceptedQuality(accept: string, targetType: string, targetSubtype: string): number {
  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const rawRange of accept.split(",")) {
    const [rawMediaRange, ...rawParameters] = rawRange.trim().split(";");
    const [type, subtype, extra] = rawMediaRange.toLowerCase().split("/");
    if (extra !== undefined || !type || !subtype) continue;
    const specificity = type === targetType && subtype === targetSubtype
      ? 2
      : type === targetType && subtype === "*"
        ? 1
        : type === "*" && subtype === "*"
          ? 0
          : -1;
    if (specificity < 0 || specificity < bestSpecificity) continue;
    const qualityParameter = rawParameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
    const parsedQuality = qualityParameter === undefined
      ? 1
      : Number(qualityParameter.trim().slice(2));
    const quality = Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
      ? parsedQuality
      : 0;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = quality;
    }
  }
  return bestQuality;
}

function markdown(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      vary: "Accept",
    },
  });
}

function withDiscoveryLinks(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Link", [
    '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
    '</.well-known/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"',
    '</server.json>; rel="service-desc"; type="application/json"; title="MCP Registry server metadata"',
    '</api.md>; rel="service-doc"; type="text/markdown"',
  ].join(", "));
  appendVary(headers, "Accept");
  return responseWithHeaders(response, headers);
}

function withApiCatalogLink(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Link",
    '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  );
  return responseWithHeaders(response, headers);
}

function withVary(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  appendVary(headers, value);
  return responseWithHeaders(response, headers);
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return responseWithHeaders(response, headers);
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("Vary");
  if (current === "*") return;
  const values = (current ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  if (values.length) headers.set("Vary", values.join(", "));
}

function withMcpCors(response: Response, browserOrigin: string | null): Response {
  if (browserOrigin === null) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", browserOrigin);
  headers.set("Access-Control-Allow-Headers", MCP_ALLOWED_HEADERS);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Expose-Headers", "MCP-Session-Id");
  headers.set("Access-Control-Max-Age", "86400");
  appendVary(headers, "Origin");
  return responseWithHeaders(response, headers);
}

function withSecurityHeaders(response: Response, url: URL): Response {
  if ((response as Response & { webSocket?: WebSocket }).webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return responseWithHeaders(response, headers);
}

function responseWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function methodNotAllowed(...allowed: string[]): Response {
  const response = json(
    { error: "method not allowed", code: "METHOD_NOT_ALLOWED" },
    "application/json; charset=utf-8",
    405,
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", allowed.join(", "));
  return responseWithHeaders(response, headers);
}

function isGetOrHead(req: Request): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function forHead(req: Request, response: Response): Response {
  if (req.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function homeMarkdown(origin: string): string {
  return [
    "# kiln",
    "",
    "Agentic parametric CAD. Submit CadQuery source, queue an asynchronous cloud build, and retrieve geometry-preflight artifacts.",
    "",
    "## Agent access",
    "",
    `- MCP (public reads; Access Managed OAuth for writes and compute): ${origin}/mcp`,
    `- MCP Registry server metadata: ${origin}/server.json`,
    `- REST API catalog: ${origin}/.well-known/api-catalog`,
    `- OpenAPI description: ${origin}/.well-known/openapi.json`,
    `- REST API documentation: ${origin}/api.md`,
    `- Agent skill: ${origin}/agent-skills/kiln-cad-builds/SKILL.md`,
    "",
    "Send the configured key as `Authorization: Bearer <key>` or `X-Kiln-API-Key: <key>` for protected operations. Public reads remain available when write authentication is not configured.",
  ].join("\n");
}

async function sitemap(env: Env, origin: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT p.slug, substr(COALESCE(MAX(b.created_at), p.created_at), 1, 10) AS lastmod
     FROM project p LEFT JOIN build b ON b.project_id = p.id
     GROUP BY p.id ORDER BY p.created_at DESC`,
  ).all<{ slug: string; lastmod: string }>();
  const urls = [
    `<url><loc>${origin}/</loc></url>`,
    ...rows.results.map(
      (project) => `<url><loc>${origin}/projects/${project.slug}</loc><lastmod>${project.lastmod}</lastmod></url>`,
    ),
  ].join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

async function projectMarkdown(env: Env, slug: string): Promise<string> {
  const project = (await core.getProjectDetail(env, slug)) as unknown as {
    name: string;
    slug: string;
    description: string;
    sources: { path: string; version: number }[];
    recent_builds: { id: string; status: string; created_at: string }[];
  };
  const lines = [
    `# ${markdownText(project.name)}`,
    "",
    project.description ? markdownText(project.description) : "_(no description)_",
    "",
    "## Sources",
    ...(project.sources.length
      ? project.sources.map((source) => `- \`${markdownCode(source.path)}\` (v${source.version})`)
      : ["_(none yet)_"]),
    "",
    "## Recent builds",
    ...(project.recent_builds.length
      ? project.recent_builds.map(
          (build) => `- \`${markdownCode(build.id)}\` - ${markdownText(build.status)} - ${markdownText(build.created_at)}`,
        )
      : ["_(none yet)_"]),
    "",
    `Full REST detail: GET /api/projects/${project.slug}`,
  ];
  return lines.join("\n");
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]<>#+|]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function markdownCode(value: string): string {
  return value.replace(/`/g, "\\`").replace(/[\r\n]/g, " ");
}

function requestIdentifier(req: Request): string {
  const ray = req.headers.get("CF-Ray")?.split("-", 1)[0];
  return ray && /^[a-zA-Z0-9]{8,64}$/.test(ray) ? ray : crypto.randomUUID();
}

function safeLogPath(pathname: string): string {
  if (pathname === "/mcp" || pathname === "/api/health" || pathname === "/api/engine/healthz") {
    return pathname;
  }
  if (pathname === "/api/projects") return pathname;
  if (pathname.startsWith("/api/projects/")) return "/api/projects/:resource";
  if (pathname.startsWith("/projects/")) return "/projects/:slug";
  if ([
    "/server.json",
    "/.well-known/api-catalog",
    "/.well-known/openapi.json",
    "/.well-known/agent-skills/index.json",
    "/.well-known/mcp.json",
    "/.well-known/mcp/server.json",
    "/.well-known/mcp/server-card.json",
    "/.well-known/mcp/server-cards.json",
  ].includes(pathname)) return pathname;
  return pathname === "/" ? "/" : "/assets-or-unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
