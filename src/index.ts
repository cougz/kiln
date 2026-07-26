import { getContainer } from "@cloudflare/containers";
import { KilnEngine } from "./engine";
import { KilnMcp, type McpProps } from "./mcp";
import { KilnBuildWorkflow } from "./workflow";
import * as core from "./core";

export { KilnEngine, KilnMcp, KilnBuildWorkflow };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  MCP_OBJECT: DurableObjectNamespace<KilnMcp>;
  BUILD_WORKFLOW: Workflow;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  DB: D1Database;
}

const PHASE = "P4";

/**
 * Routes:
 *   POST/GET /mcp              MCP (Streamable HTTP), open (no auth — see PLAN.md)
 *   GET  /.well-known/mcp/server-card.json  MCP server card (SEP-1649)
 *   GET  /.well-known/api-catalog  RFC 9727 API catalog
 *   GET  /.well-known/openapi.json OpenAPI service description
 *   GET  /.well-known/agent-skills/index.json Agent Skills index
 *   GET  /sitemap.xml          home + one entry per project
 *   GET  /projects/:slug       text/markdown negotiation, else redirects into the SPA
 *   GET  /api/health           Worker + bindings liveness
 *   ANY  /api/engine/*         proxied into the engine container
 *   ANY  /api/*                REST core (see src/api.ts)
 *   *                          static assets (public/)
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      // No auth: kiln is a public, unauthenticated MCP server for now (the
      // Cloudflare Access managed-OAuth path was implemented and then
      // deliberately removed — see PLAN.md status log for why).
      const email =
        req.headers.get("cf-access-authenticated-user-email") ?? undefined;
      const props: McpProps = { sub: email ?? "anonymous", email, origin: url.origin };
      (ctx as unknown as { props: McpProps }).props = props;
      return KilnMcp.serve("/mcp").fetch(req, env, ctx);
    }

    if (
      url.pathname === "/.well-known/mcp.json" ||
      url.pathname === "/.well-known/mcp/server-card.json" ||
      url.pathname === "/.well-known/mcp/server-cards.json"
    ) {
      return json(serverCard(url.origin), "application/mcp-server-card+json");
    }

    if (url.pathname === "/.well-known/api-catalog") {
      return withApiCatalogLink(
        json(apiCatalog(url.origin), 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'),
      );
    }

    if (url.pathname === "/.well-known/openapi.json") {
      return json(openApi(url.origin), "application/vnd.oai.openapi+json;version=3.1");
    }

    if (url.pathname === "/.well-known/agent-skills/index.json") {
      return json(agentSkillsIndex(url.origin));
    }

    if (url.pathname === "/sitemap.xml") {
      return sitemap(env, url.origin);
    }

    // Content-negotiated project pages: agents following llms.txt / the
    // API catalog with `Accept: text/markdown` get a markdown summary
    // (no client-side JS needed); browsers get redirected into the SPA
    // route the frontend actually understands.
    const projMatch = url.pathname.match(/^\/projects\/([a-z0-9][a-z0-9-]{1,63})\/?$/);
    if (projMatch && req.method === "GET") {
      if (acceptsMarkdown(req)) {
        try {
          const md = await projectMarkdown(env, projMatch[1]);
          return markdown(md);
        } catch (e) {
          return new Response(`error: ${e}`, { status: 404, headers: { vary: "Accept" } });
        }
      }
      return Response.redirect(`${url.origin}/#/p/${projMatch[1]}`, 302);
    }

    if (url.pathname === "/api/health") {
      let d1 = false;
      let r2 = false;
      try {
        await env.DB.prepare("SELECT 1").first();
        d1 = true;
      } catch {}
      try {
        await env.ARTIFACTS.head("healthcheck");
        r2 = true;
      } catch {}
      return Response.json({
        ok: d1 && r2,
        service: "kiln",
        phase: PHASE,
        d1,
        r2,
        mcp: true,
      });
    }

    if (url.pathname.startsWith("/api/engine/")) {
      const engine = getContainer(env.ENGINE);
      const inner = new URL(req.url);
      inner.pathname = url.pathname.slice("/api/engine".length) || "/";
      return engine.fetch(new Request(inner.toString(), req));
    }

    if (url.pathname.startsWith("/api/")) {
      const { handleApi } = await import("./api");
      return handleApi(req, env, url);
    }

    if (url.pathname === "/" && req.method === "GET" && acceptsMarkdown(req)) {
      return withDiscoveryLinks(markdown(homeMarkdown(url.origin)));
    }

    const response = await env.ASSETS.fetch(req);
    return url.pathname === "/" ? withDiscoveryLinks(response) : response;
  },
} satisfies ExportedHandler<Env>;

function serverCard(origin: string) {
  return {
    $schema: "https://modelcontextprotocol.io/schemas/draft/server-card.json",
    serverInfo: { name: "kiln", version: "0.2.0" },
    name: "kiln",
    version: "0.2.0",
    description:
      "Agentic parametric CAD: versioned CadQuery projects, verified cloud " +
      "builds (watertight / bed-fit / support scan), immutable STL+render " +
      "artifacts. The connecting agent writes the CAD code; kiln executes " +
      "and verifies it.",
    endpoint: `${origin}/mcp`,
    transport: ["streamable-http"],
    transports: [{ type: "streamable-http", endpoint: `${origin}/mcp` }],
    remotes: [{ type: "streamable-http", url: `${origin}/mcp` }],
    authentication: { type: "none", description: "Public, unauthenticated MCP server." },
    capabilities: { tools: {}, prompts: {} },
  };
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
        "describedby": [{ href: `${origin}/llms.txt`, type: "text/plain" }],
      },
      {
        anchor: `${origin}/mcp`,
        "service-doc": [{ href: `${origin}/llms.txt`, type: "text/plain" }],
        describedby: [{ href: `${origin}/.well-known/mcp/server-card.json`, type: "application/json" }],
        status: [{ href: `${origin}/api/health`, type: "application/json" }],
      },
    ],
  };
}

function openApi(origin: string) {
  return {
    openapi: "3.1.1",
    info: {
      title: "kiln REST API",
      version: "0.2.0",
      description: "Public API for versioned CadQuery projects and asynchronous verified builds.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/health": { get: { summary: "Service health", responses: { "200": { description: "Health report" } } } },
      "/api/projects": {
        get: { summary: "List projects", responses: { "200": { description: "Projects" } } },
        post: { summary: "Create a project", responses: { "201": { description: "Created project" } } },
      },
      "/api/projects/{slug}": {
        get: {
          summary: "Get project detail",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Project detail" } },
        },
      },
      "/api/projects/{slug}/source": {
        put: {
          summary: "Create a versioned source",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Stored source" } },
        },
      },
      "/api/projects/{slug}/source/{path}": {
        get: {
          summary: "Get the latest source version",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "path", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Source" } },
        },
      },
      "/api/projects/{slug}/params": {
        get: {
          summary: "Get current versioned build parameters",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Parameters and source version" } },
        },
        put: {
          summary: "Set versioned build parameters",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["params"],
                  properties: { params: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
          responses: { "200": { description: "Stored parameters and source version" } },
        },
      },
      "/api/projects/{slug}/docs": {
        get: {
          summary: "List project documents",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Document summaries" } },
        },
      },
      "/api/projects/{slug}/docs/{kind}": {
        get: {
          summary: "Get a project document",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "kind", in: "path", required: true, schema: { enum: ["specification", "instructions", "bom", "page"] } },
          ],
          responses: { "200": { description: "Document" } },
        },
        put: {
          summary: "Create or update a project document",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "kind", in: "path", required: true, schema: { enum: ["specification", "instructions", "bom", "page"] } },
          ],
          responses: { "200": { description: "Stored document" } },
        },
      },
      "/api/projects/{slug}/builds": {
        get: {
          summary: "List builds",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Builds" } },
        },
        post: {
          summary: "Queue a build",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "202": { description: "Queued build" } },
        },
      },
      "/api/projects/{slug}/builds/{buildId}": {
        get: {
          summary: "Get build status and report",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "buildId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Build" } },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/artifacts/{path}": {
        get: {
          summary: "Download an immutable build artifact",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "buildId", in: "path", required: true, schema: { type: "string" } },
            { name: "path", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Artifact" } },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/artifacts": {
        get: {
          summary: "List archived build artifacts",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "buildId", in: "path", required: true, schema: { type: "string" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "Artifact inventory" } },
        },
      },
      "/api/projects/{slug}/builds/{buildId}/verify": {
        post: {
          summary: "Verify one STL extent against a target",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
            { name: "buildId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Target verification result" } },
        },
      },
    },
  };
}

function agentSkillsIndex(origin: string) {
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "kiln-cad-builds",
        type: "skill-md",
        description: "Create versioned CadQuery projects and queue verified print-ready builds with kiln.",
        url: `${origin}/agent-skills/kiln-cad-builds/SKILL.md`,
        digest: "sha256:eea64a249331929eb52a54bcde6777ee0786d1e10f3c6c195625d5119b0f58f6",
      },
    ],
  };
}

function json(data: unknown, contentType = "application/json; charset=utf-8"): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": contentType } });
}

function acceptsMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  const quality = (mediaType: string) => {
    let best = -1;
    for (const rawRange of accept.toLowerCase().split(",")) {
      const [range, ...params] = rawRange.trim().split(";");
      if (range !== mediaType && range !== "text/*" && range !== "*/*") continue;
      const q = params.find((param) => param.trim().startsWith("q="))?.split("=")[1];
      const value = q === undefined ? 1 : Number(q);
      if (Number.isFinite(value)) best = Math.max(best, value);
    }
    return best;
  };
  const markdownQuality = quality("text/markdown");
  return markdownQuality > 0 && markdownQuality > quality("text/html");
}

function markdown(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept" },
  });
}

function withDiscoveryLinks(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Link",
    [
      '</.well-known/api-catalog>; rel="api-catalog"',
      '</.well-known/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
      '</api.md>; rel="service-doc"; type="text/markdown"',
      '</.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"',
    ].join(", "),
  );
  const vary = headers.get("Vary");
  if (!vary?.toLowerCase().split(",").map((v) => v.trim()).includes("accept")) {
    headers.set("Vary", vary ? `${vary}, Accept` : "Accept");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withApiCatalogLink(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Link", '</.well-known/api-catalog>; rel="api-catalog"');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function homeMarkdown(origin: string): string {
  return [
    "# kiln",
    "",
    "Agentic parametric CAD. Submit CadQuery source, queue an asynchronous cloud build, and retrieve verified print-ready artifacts.",
    "",
    "## Agent access",
    "",
    `- MCP (public Streamable HTTP): ${origin}/mcp`,
    `- MCP server card: ${origin}/.well-known/mcp/server-card.json`,
    `- REST API catalog: ${origin}/.well-known/api-catalog`,
    `- OpenAPI description: ${origin}/.well-known/openapi.json`,
    `- REST API documentation: ${origin}/api.md`,
    `- Agent skill: ${origin}/agent-skills/kiln-cad-builds/SKILL.md`,
    "",
    "The service is public and currently does not use OAuth or API keys.",
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
      (p) => `<url><loc>${origin}/projects/${p.slug}</loc><lastmod>${p.lastmod}</lastmod></url>`,
    ),
  ].join("");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml" } });
}

async function projectMarkdown(env: Env, slug: string): Promise<string> {
  const p = (await core.getProjectDetail(env, slug)) as unknown as {
    name: string;
    slug: string;
    description: string;
    sources: { path: string; version: number }[];
    recent_builds: { id: string; status: string; created_at: string }[];
  };
  const lines = [
    `# ${markdownText(p.name)}`,
    "",
    p.description ? markdownText(p.description) : "_(no description)_",
    "",
    "## Sources",
    ...(p.sources.length
      ? p.sources.map((s) => `- \`${markdownCode(s.path)}\` (v${s.version})`)
      : ["_(none yet)_"]),
    "",
    "## Recent builds",
    ...(p.recent_builds.length
      ? p.recent_builds.map(
          (b) => `- \`${markdownCode(b.id)}\` - ${markdownText(b.status)} - ${markdownText(b.created_at)}`,
        )
      : ["_(none yet)_"]),
    "",
    `Full REST detail: GET /api/projects/${p.slug}`,
  ];
  return lines.join("\n");
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]<>#+|]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function markdownCode(value: string): string {
  return value.replace(/`/g, "\\`").replace(/[\r\n]/g, " ");
}
