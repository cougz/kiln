import { getContainer } from "@cloudflare/containers";
import { KilnEngine } from "./engine";
import { KilnMcp, type McpProps } from "./mcp";
import * as core from "./core";

export { KilnEngine, KilnMcp };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  MCP_OBJECT: DurableObjectNamespace<KilnMcp>;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  DB: D1Database;
}

const PHASE = "P4";

/**
 * Routes:
 *   POST/GET /mcp              MCP (Streamable HTTP), open (no auth — see PLAN.md)
 *   GET  /.well-known/mcp.json MCP server card (SEP-1649)
 *   GET  /.well-known/api-catalog  REST endpoint catalog
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
      const props: McpProps = { sub: email ?? "anonymous", email };
      (ctx as unknown as { props: McpProps }).props = props;
      return KilnMcp.serve("/mcp").fetch(req, env, ctx);
    }

    if (url.pathname === "/.well-known/mcp.json") {
      return Response.json(serverCard(url.origin));
    }

    if (url.pathname === "/.well-known/api-catalog") {
      return Response.json(apiCatalog(url.origin));
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
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("text/markdown")) {
        try {
          const md = await projectMarkdown(env, projMatch[1]);
          return new Response(md, {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        } catch (e) {
          return new Response(`error: ${e}`, { status: 404 });
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

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

function serverCard(origin: string) {
  return {
    $schema: "https://modelcontextprotocol.io/schemas/draft/server-card.json",
    name: "kiln",
    version: "0.2.0",
    description:
      "Agentic parametric CAD: versioned CadQuery projects, verified cloud " +
      "builds (watertight / bed-fit / support scan), immutable STL+render " +
      "artifacts. The connecting agent writes the CAD code; kiln executes " +
      "and verifies it.",
    endpoint: `${origin}/mcp`,
    transport: ["streamable-http"],
    authentication: { type: "none", description: "Public, unauthenticated MCP server." },
    capabilities: { tools: true, prompts: true },
  };
}

function apiCatalog(origin: string) {
  return {
    "linked-resources": [
      {
        href: `${origin}/api/projects`,
        rel: "collection",
        title: "kiln projects",
        description: "REST core over CAD projects, versioned sources, and builds.",
      },
      { href: `${origin}/mcp`, rel: "service", title: "kiln MCP server (Streamable HTTP, no auth)" },
      { href: `${origin}/.well-known/mcp.json`, rel: "describedby", title: "MCP server card (SEP-1649)" },
      { href: `${origin}/llms.txt`, rel: "describedby", title: "llms.txt" },
      { href: `${origin}/sitemap.xml`, rel: "sitemap" },
    ],
  };
}

async function sitemap(env: Env, origin: string): Promise<Response> {
  const projects = (await core.listProjects(env)) as { slug: string }[];
  const urls = [
    `<url><loc>${origin}/</loc></url>`,
    ...projects.map((p) => `<url><loc>${origin}/projects/${p.slug}</loc></url>`),
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
    `# ${p.name}`,
    "",
    p.description || "_(no description)_",
    "",
    "## Sources",
    ...(p.sources.length
      ? p.sources.map((s) => `- \`${s.path}\` (v${s.version})`)
      : ["_(none yet)_"]),
    "",
    "## Recent builds",
    ...(p.recent_builds.length
      ? p.recent_builds.map((b) => `- \`${b.id}\` — ${b.status} — ${b.created_at}`)
      : ["_(none yet)_"]),
    "",
    `Full REST detail: GET /api/projects/${p.slug}`,
  ];
  return lines.join("\n");
}
