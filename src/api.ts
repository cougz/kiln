import * as core from "./core";
import { ApiError } from "./core";
import type { Env } from "./index";

/** Thin HTTP layer over src/core.ts (the MCP tools wrap the same core).
 *
 *  POST /api/projects                        {slug, name, description?}
 *  GET  /api/projects
 *  GET  /api/projects/:slug
 *  PUT  /api/projects/:slug/source           {path, content}
 *  GET  /api/projects/:slug/source/:path     latest version
 *  GET/PUT /api/projects/:slug/params         {params}
 *  GET  /api/projects/:slug/docs
 *  GET  /api/projects/:slug/docs/:kind
 *  PUT  /api/projects/:slug/docs/:kind        {markdown, build_id?}
 *  POST /api/projects/:slug/builds           {entry?, timeout_s?, bed?} → 202, queued (poll :id)
 *  GET  /api/projects/:slug/builds
 *  GET  /api/projects/:slug/builds/:n
 *  GET  /api/projects/:slug/builds/:n/artifacts
 *  GET  /api/projects/:slug/builds/:n/artifacts/<path>
 *  POST /api/projects/:slug/builds/:n/verify  {path, axis, expected, tolerance}
 */

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    return await route(req, env, url);
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    return json({ error: `internal: ${err}` }, 500);
  }
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const seg = url.pathname.split("/").filter(Boolean); // ["api","projects",...]
  if (seg[1] !== "projects") throw new ApiError(404, "not found");

  if (seg.length === 2) {
    if (req.method === "POST") {
      const b = await req.json<{ slug?: string; name?: string; description?: string }>();
      return json(await core.createProject(env, b.slug ?? "", b.name, b.description), 201);
    }
    return json(await core.listProjects(env));
  }

  const slug = seg[2];
  if (seg.length === 3) return json(await core.getProjectDetail(env, slug));

  if (seg[3] === "source") {
    if (req.method === "PUT") {
      const b = await req.json<{ path?: string; content?: string }>();
      if (b.path === undefined || b.content === undefined) {
        throw new ApiError(400, "path and content required");
      }
      return json(await core.putSource(env, slug, b.path, b.content));
    }
    const path = seg.slice(4).join("/");
    return json(await core.getSource(env, slug, path));
  }

  if (seg[3] === "params" && seg.length === 4) {
    if (req.method === "GET") return json(await core.getParams(env, slug));
    if (req.method === "PUT") {
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) || !("params" in body)) {
        throw new ApiError(400, "JSON object with params required");
      }
      return json(await core.setParams(env, slug, (body as { params: unknown }).params));
    }
    throw new ApiError(405, "method not allowed");
  }

  if (seg[3] === "docs") {
    if (seg.length === 4 && req.method === "GET") return json(await core.listDocs(env, slug));
    if (seg.length !== 5) throw new ApiError(404, "not found");
    const kind = seg[4];
    if (req.method === "PUT") {
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(400, "JSON object required");
      }
      const { markdown, build_id } = body as { markdown?: unknown; build_id?: unknown };
      if (typeof markdown !== "string" || (build_id !== undefined && typeof build_id !== "string")) {
        throw new ApiError(400, "markdown string and optional build_id string required");
      }
      return json(await core.putDoc(env, slug, kind, markdown, build_id));
    }
    if (req.method === "GET") return json(await core.getDoc(env, slug, kind));
    throw new ApiError(405, "method not allowed");
  }

  if (seg[3] === "builds") {
    if (seg.length === 4 && req.method === "POST") {
      const b = await req
        .json<{ entry?: string; timeout_s?: number; bed?: number }>()
        .catch(() => ({}) as { entry?: string; timeout_s?: number; bed?: number });
      // async: queues a Workflow and returns immediately — poll GET builds/:id
      return json(await core.runBuild(env, slug, b.entry, b.timeout_s, b.bed), 202);
    }
    if (seg.length === 4) return json(await core.listBuilds(env, slug));
    if (seg.length === 5) return json(await core.getBuild(env, slug, seg[4]));
    if (seg[5] === "verify" && req.method === "POST") {
      const b = await req.json<{ path?: string; axis?: "x" | "y" | "z"; expected?: number; tolerance?: number }>();
      if (
        !b.path ||
        !b.axis ||
        !["x", "y", "z"].includes(b.axis) ||
        b.expected === undefined ||
        b.tolerance === undefined
      ) {
        throw new ApiError(400, "path, axis, expected, and tolerance required");
      }
      return json(await core.verifyTarget(env, slug, seg[4], b.path, b.axis, b.expected, b.tolerance));
    }
    if (seg[5] === "artifacts") {
      if (seg.length === 6) {
        return json(await core.listArtifacts(env, slug, seg[4], url.searchParams.get("cursor") ?? undefined));
      }
      const path = decodePath(seg.slice(6));
      const obj = await core.getArtifact(env, slug, seg[4], path);
      return new Response(obj.body, { headers: { "content-type": contentType(path) } });
    }
  }

  throw new ApiError(404, "not found");
}

function decodePath(segments: string[]): string {
  try {
    return segments.map(decodeURIComponent).join("/");
  } catch {
    throw new ApiError(400, "malformed artifact path");
  }
}

function contentType(key: string): string {
  if (key.endsWith(".stl")) return "model/stl";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
