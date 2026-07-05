import { getContainer } from "@cloudflare/containers";
import { KilnEngine } from "./engine";

export { KilnEngine };

export interface Env {
  ENGINE: DurableObjectNamespace<KilnEngine>;
  ASSETS: Fetcher;
}

const PHASE = "P0";

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
      return Response.json({ ok: true, service: "kiln", phase: PHASE });
    }

    if (url.pathname.startsWith("/api/engine/")) {
      const engine = getContainer(env.ENGINE);
      const inner = new URL(req.url);
      inner.pathname = url.pathname.slice("/api/engine".length) || "/";
      return engine.fetch(new Request(inner.toString(), req));
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
