import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as core from "./core";
import { ApiError } from "./core";
import type { Env } from "./index";

export interface McpProps extends Record<string, unknown> {
  sub: string;
  email?: string;
  /** request origin, so artifact URLs work on any deployment domain */
  origin?: string;
}

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});

const fail = (err: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: err instanceof ApiError ? `${err.status}: ${err.message}` : `error: ${err}`,
    },
  ],
  isError: true,
});

const DISCIPLINE = `kiln CAD discipline (from the parametric-cad-stl workflow):
- Never guess geometry: measure with bounds/extents, solve free dimensions
  algebraically from measured inputs, assert targets within tight tolerance.
- Joined bodies must overlap >= 2mm (named EMBED constant), never touch
  exactly co-planar.
- Every printed part must fit the bed (default 180x180x180) sitting at Z=0.
- Export print-oriented STLs to stl/ (slicer-ready, part on bed corner),
  assembly-coordinate copies to asm/; parts that only fit diagonally get
  their 45-degree rotation baked into the stl/ export.
- Builds are only 'verified' when the script's own assertions AND the
  engine checks pass (watertight, bed fit, support-free scan with a small
  budget for horizontal bores).
- Front-load physical risk: emit cheap fit coupons before big parts when
  a sliding/press fit matters, and expose the clearance as one parameter.`;

export class KilnMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "kiln", version: "0.2.0" });

  async init() {
    const env = this.env;
    const s = this.server;

    s.tool(
      "list_projects",
      "List all CAD projects on this kiln instance.",
      {},
      async () => {
        try {
          return text(await core.listProjects(env));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "create_project",
      "Create a new CAD project.",
      {
        slug: z.string().describe("lowercase alphanumeric + dashes"),
        name: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ slug, name, description }) => {
        try {
          return text(await core.createProject(env, slug, name, description));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "get_project",
      "Project detail: sources (latest versions) and recent builds.",
      { slug: z.string() },
      async ({ slug }) => {
        try {
          return text(await core.getProjectDetail(env, slug));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "put_source",
      "Create or update a source file (versioned; builds always use the latest " +
        "version of every file). Entry scripts are CadQuery/trimesh Python that " +
        "export print-oriented STLs to stl/ and may write img/ and *.md docs.",
      { slug: z.string(), path: z.string(), content: z.string() },
      async ({ slug, path, content }) => {
        try {
          return text(await core.putSource(env, slug, path, content));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "get_source",
      "Fetch the latest version of a project source file.",
      { slug: z.string(), path: z.string() },
      async ({ slug, path }) => {
        try {
          return text(await core.getSource(env, slug, path));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "run_build",
      "Queue the project's build script on the CAD engine (cadquery 2.8 + trimesh " +
        "+ manifold3d + matplotlib). Returns immediately with status 'queued'; the " +
        "build runs in the background (typically 1-5 min) — poll get_build every " +
        "~15s until status is 'verified' or 'failed'. Every exported stl/*.stl is " +
        "verified: watertight, bed fit at Z=0, support-free scan. Artifacts are " +
        "archived immutably; the report includes per-part results and the script's log.",
      {
        slug: z.string(),
        entry: z.string().default("build.py"),
        timeout_s: z.number().int().min(30).max(900).default(600),
      },
      async ({ slug, entry, timeout_s }) => {
        try {
          return text(await core.runBuild(env, slug, entry, timeout_s));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "get_build",
      "Build status + full verification report.",
      { slug: z.string(), build_id: z.string() },
      async ({ slug, build_id }) => {
        try {
          return text(await core.getBuild(env, slug, build_id));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "get_artifact_url",
      "Download URL for one build artifact (STL, render PNG, doc).",
      { slug: z.string(), build_id: z.string(), path: z.string() },
      async ({ slug, build_id, path }) => {
        try {
          await core.getArtifact(env, slug, build_id, path); // existence check
          const origin = this.props?.origin ?? "https://kiln.timcf.workers.dev";
          const enc = path.split("/").map(encodeURIComponent).join("/");
          return text({
            url: `${origin}/api/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(build_id)}/artifacts/${enc}`,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.tool(
      "measure",
      "Re-measure a build artifact STL on the engine: extents, bounds, " +
        "watertight, volume, triangle count. Use this before asserting any " +
        "dimension in reasoning — never guess.",
      { slug: z.string(), build_id: z.string(), path: z.string() },
      async ({ slug, build_id, path }) => {
        try {
          return text(await core.measureArtifact(env, slug, build_id, path));
        } catch (e) {
          return fail(e);
        }
      },
    );

    s.prompt("cad-discipline", "kiln's CAD design rules for build scripts", () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: DISCIPLINE } },
      ],
    }));
  }
}
