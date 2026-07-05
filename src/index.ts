import { getContainer } from "@cloudflare/containers";
import { KilnEngine } from "./engine";

export { KilnEngine };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  DB: D1Database;
}

const PHASE = "P1";

/**
 * Routes:
 *   GET  /api/health           liveness of the Worker itself
 *   ANY  /api/engine/*         proxied into the engine container
 *                              (P0: GET /healthz, POST /measure)
 *   *                          static assets (public/)
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      let d1 = false;
      let r2 = false;
      try {
        await env.DB.prepare("SELECT 1").first();
        d1 = true;
      } catch {}
      try {
        await env.ARTIFACTS.head("healthcheck"); // null for missing key, throws only if binding is broken
        r2 = true;
      } catch {}
      return Response.json({ ok: d1 && r2, service: "kiln", phase: PHASE, d1, r2 });
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
