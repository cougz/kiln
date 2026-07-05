import { getContainer } from "@cloudflare/containers";
import { KilnEngine } from "./engine";
import { KilnMcp, type McpProps } from "./mcp";
import { verifyMcpAuth } from "./access";

export { KilnEngine, KilnMcp };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  MCP_OBJECT: DurableObjectNamespace<KilnMcp>;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  DB: D1Database;
  TEAM_DOMAIN?: string; // <team>.cloudflareaccess.com (JWT path, unused on workers.dev)
  POLICY_AUD?: string; // Access application AUD tag (JWT path)
  MCP_SHARED_SECRET?: string; // secret: Access MCP app custom-header value
  MCP_PUBLIC?: string; // "true" = /mcp auth disabled (temporary)
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
      let props: McpProps;
      if (env.MCP_PUBLIC === "true") {
        // auth intentionally disabled (MCP_PUBLIC var) — flip to re-enforce
        const email =
          req.headers.get("cf-access-authenticated-user-email") ?? undefined;
        props = { sub: email ?? "anonymous", email };
        console.log(`mcp ${req.method} unauthenticated mode: ${props.sub}`);
      } else {
        const auth = await verifyMcpAuth(req, env);
        if (auth instanceof Response) {
          console.log(`mcp ${req.method} -> ${auth.status}`);
          return auth;
        }
        console.log(`mcp ${req.method} authenticated: ${auth.email ?? auth.sub}`);
        props = { sub: auth.sub, email: auth.email };
      }
      (ctx as unknown as { props: McpProps }).props = props;
      return KilnMcp.serve("/mcp").fetch(req, env, ctx);
    }

    if (url.pathname === "/.well-known/mcp.json") {
      return Response.json(serverCard(url.origin));
    }

    // Legacy MCP OAuth discovery (2025-03-26 spec): clients that expect
    // the AS metadata on the resource origin get the team AS's metadata
    // proxied through.
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      if (!env.TEAM_DOMAIN) return new Response("not configured", { status: 404 });
      const upstream = await fetch(
        `https://${env.TEAM_DOMAIN}/.well-known/oauth-authorization-server`,
      );
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    }

    // RFC 9728 protected-resource metadata: Access is the authorization
    // server (managed OAuth incl. dynamic client registration).
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      if (!env.TEAM_DOMAIN) return new Response("not configured", { status: 404 });
      return Response.json({
        resource: `${url.origin}/mcp`,
        authorization_servers: [`https://${env.TEAM_DOMAIN}`],
        bearer_methods_supported: ["header"],
        resource_name: "kiln",
        resource_documentation: `${url.origin}/llms.txt`,
      });
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
        mcp: Boolean(env.MCP_SHARED_SECRET || (env.TEAM_DOMAIN && env.POLICY_AUD)),
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
        "Cloudflare Access managed OAuth — connect via the Access MCP " +
        "portal for this application; direct requests require upstream " +
        "credentials.",
    },
    capabilities: { tools: true, prompts: true },
  };
}
