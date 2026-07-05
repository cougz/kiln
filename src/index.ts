import { getContainer } from "@cloudflare/containers";
import { KilnEngine } from "./engine";
import { KilnMcp, type McpProps } from "./mcp";
import { verifyAccess } from "./access";

export { KilnEngine, KilnMcp };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  MCP_OBJECT: DurableObjectNamespace<KilnMcp>;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  DB: D1Database;
  TEAM_DOMAIN?: string; // <team>.cloudflareaccess.com
  POLICY_AUD?: string; // Access application AUD tag
}

const PHASE = "P2";

/**
 * Routes:
 *   POST/GET /mcp              MCP (Streamable HTTP), Access-JWT protected
 *   GET  /.well-known/mcp.json MCP server card (SEP-1649)
 *   GET  /api/health           Worker + bindings liveness
 *   ANY  /api/engine/*         proxied into the engine container
 *   ANY  /api/*                REST core (see src/api.ts)
 *   *                          static assets (public/)
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      const auth = await verifyAccess(req, env);
      if (auth instanceof Response) return auth;
      const props: McpProps = { sub: auth.sub, email: auth.email };
      (ctx as unknown as { props: McpProps }).props = props;
      return KilnMcp.serve("/mcp").fetch(req, env, ctx);
    }

    if (url.pathname === "/.well-known/mcp.json") {
      return Response.json(serverCard(url.origin));
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
        mcp: Boolean(env.TEAM_DOMAIN && env.POLICY_AUD),
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
    authentication: {
      type: "oauth2",
      description:
        "Cloudflare Access managed OAuth. Requests must carry a valid " +
        "Cf-Access-Jwt-Assertion for this application.",
    },
    capabilities: { tools: true, prompts: true },
  };
}
