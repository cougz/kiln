// Keep Zod first: MCP's protocol schemas call z.custom() during module
// evaluation, so Wrangler's bundle must initialize Zod before the SDK.
import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import * as core from "./core";
import { ApiError } from "./core";
import type { Env } from "./index";
import { APP_VERSION } from "./version";

export interface McpProps extends Record<string, unknown> {
  /** Request origin, so artifact URLs work on any deployment domain. */
  origin?: string;
}

export const MCP_TOOL_PERMISSIONS = {
  create_project: "mutate",
  update_project: "mutate",
  put_source: "mutate",
  set_params: "mutate",
  put_doc: "mutate",
  run_build: "compute",
  retry_build: "compute",
  cancel_build: "mutate",
  verify_target: "compute",
  measure: "compute",
} as const;

const DEFAULT_ORIGIN = "https://kiln.timcf.workers.dev";

const INSTRUCTIONS = `Kiln exposes public read tools and resources. Writes and compute operations are
Cloudflare Access protected; unauthenticated sessions can only read. The transition API key remains available to existing automation. Builds run asynchronously:
run_build and retry_build return a durable build ID immediately, so poll get_build about
every 15 seconds until verified, failed, or cancelled. Verification and measurement are
geometry preflight only, not manufacturing, structural, dimensional, or safety certification.`;

const DISCIPLINE = `kiln CAD discipline (from the parametric-cad-stl workflow):
- Never guess geometry: measure with bounds/extents, solve free dimensions
  algebraically from measured inputs, assert targets within tight tolerance.
- Joined bodies must overlap >= 2mm (named EMBED constant), never touch
  exactly co-planar.
- Every printed part must fit the printer profile sitting at Z=0 (default
  180x180x180; run_build accepts a per-build printer_profile override).
- Use set_params for dimensions and load the versioned params.json file in
  build scripts; each queued build pins its parameters for reproducibility.
- Export print-oriented STLs to stl/ (slicer-ready, part on bed corner),
  assembly-coordinate copies to asm/; parts that only fit diagonally get
  their 45-degree rotation baked into the stl/ export.
- Treat engine checks and verify_target as geometry preflight, not certification.
  Watertightness, bounds, bed-fit, and support scans are heuristics with tolerances
  and can produce false positives or negatives; they do not prove printability,
  material strength, machine accuracy, fit, regulatory compliance, or safety.
- Front-load physical risk: emit cheap fit coupons before big parts when
  a sliding/press fit matters, and expose the clearance as one parameter.`;

const executionErrorSchema = z.object({
  code: z.string(),
  status: z.number().int().min(100).max(599),
  message: z.string(),
  retryable: z.boolean(),
}).strict();

const outputSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: executionErrorSchema.optional(),
}).strict();

const slugSchema = z.string().min(2).max(64).regex(
  /^[a-z0-9][a-z0-9-]+$/,
  "use lowercase alphanumeric characters and dashes",
);
const sourcePathSchema = z.string().min(1).max(160);
const artifactPathSchema = z.string().min(1).max(512);
const buildIdSchema = z.string().min(1).max(64);
const cursorSchema = z.string().min(1).max(2_000).optional();
const limitSchema = z.number().int().min(1).max(100).optional();
const docKindSchema = z.enum(["specification", "instructions", "bom", "page"]);
const idempotencyKeySchema = z.string().min(1).max(128).regex(
  /^[\x21-\x7e]+$/,
  "use visible ASCII characters without spaces",
).optional();
const printerProfileSchema = z.object({
  x: z.number().finite().positive().max(1000),
  y: z.number().finite().positive().max(1000),
  z: z.number().finite().positive().max(1000),
}).strict();

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const UPSERT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const REPLACE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const QUEUE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const CANCEL = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface ExecutionError {
  code: string;
  status: number;
  message: string;
  retryable: boolean;
}

function stableError(error: unknown): ExecutionError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      retryable: error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    status: 500,
    message: "an internal error occurred",
    retryable: true,
  };
}

function success(data: unknown, links: ResourceLink[] = []) {
  const structuredContent = { ok: true, data };
  return {
    structuredContent,
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
      ...links,
    ],
  };
}

function failure(error: unknown) {
  const structuredContent = { ok: false, error: stableError(error) };
  return {
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    isError: true,
  };
}

async function execute(operation: () => Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function artifactUrl(origin: string | undefined, slug: string, buildId: string, path: string): string {
  const base = (origin ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  return `${base}/api/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/artifacts/${encodedPath(path)}`;
}

function artifactResourceUri(slug: string, buildId: string, path: string): string {
  return `kiln://projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(buildId)}/artifacts/${encodedPath(path)}`;
}

function artifactMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".stl")) return "model/stl";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function resourceVariable(variables: Record<string, string | string[]>, name: string): string {
  const value = variables[name];
  const encoded = typeof value === "string" ? value : value?.join("/");
  if (!encoded) throw new ApiError(400, `missing resource variable '${name}'`, "INVALID_RESOURCE_URI");
  try {
    return encoded.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new ApiError(400, `invalid resource variable '${name}'`, "INVALID_RESOURCE_URI");
  }
}

async function jsonResource(uri: URL, load: () => Promise<unknown>) {
  try {
    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(await load(), null, 2),
      }],
    };
  } catch (error) {
    const stable = stableError(error);
    throw new ApiError(stable.status, stable.message, stable.code);
  }
}

async function markdownResource(uri: URL, load: () => Promise<unknown>) {
  try {
    const document = await load() as { markdown?: unknown };
    if (typeof document.markdown !== "string") {
      throw new ApiError(500, "document content is unavailable", "INVALID_DOCUMENT_RESPONSE");
    }
    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "text/markdown",
        text: document.markdown,
      }],
    };
  } catch (error) {
    const stable = stableError(error);
    throw new ApiError(stable.status, stable.message, stable.code);
  }
}

export class KilnMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer(
    { name: "kiln", version: APP_VERSION },
    { instructions: INSTRUCTIONS },
  );

  async init() {
    const env = this.env;
    const s = this.server;

    s.registerTool("list_projects", {
      title: "List Projects",
      description: "List public CAD project summaries using cursor pagination.",
      inputSchema: z.object({ cursor: cursorSchema, limit: limitSchema }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ cursor, limit }) => execute(() => core.listProjects(env, { cursor, limit })));

    s.registerTool("create_project", {
      title: "Create Project",
      description: "Create a CAD project. Requires mutation permission.",
      inputSchema: z.object({
        slug: slugSchema,
        name: z.string().min(1).max(160).optional(),
        description: z.string().max(2_000).optional(),
      }).strict(),
      outputSchema,
      annotations: CREATE,
    }, ({ slug, name, description }) => execute(async () => {
      return core.createProject(env, slug, name, description);
    }));

    s.registerTool("update_project", {
      title: "Update Project Metadata",
      description: "Update a project's public name or description. Requires mutation permission.",
      inputSchema: z.object({
        slug: slugSchema,
        name: z.string().min(1).max(160).optional(),
        description: z.string().max(2_000).optional(),
      }).strict().refine((value) => value.name !== undefined || value.description !== undefined, {
        message: "name or description is required",
      }),
      outputSchema,
      annotations: UPSERT,
    }, ({ slug, name, description }) => execute(async () => {
      return core.updateProject(env, slug, { name, description });
    }));

    s.registerTool("get_project", {
      title: "Get Project",
      description: "Get a public project summary, latest sources, documents, and recent builds.",
      inputSchema: z.object({ slug: slugSchema }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug }) => execute(() => core.getProjectDetail(env, slug)));

    s.registerTool("put_source", {
      title: "Put Source File",
      description: "Create a versioned source file or append a new version. Requires mutation permission.",
      inputSchema: z.object({
        slug: slugSchema,
        path: sourcePathSchema,
        content: z.string().max(500_000),
      }).strict(),
      outputSchema,
      annotations: UPSERT,
    }, ({ slug, path, content }) => execute(async () => {
      return core.putSource(env, slug, path, content);
    }));

    s.registerTool("get_source", {
      title: "Get Source File",
      description: "Read the latest or a specified immutable version of a public project source file.",
      inputSchema: z.object({
        slug: slugSchema,
        path: sourcePathSchema,
        version: z.number().int().positive().optional(),
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, path, version }) => execute(() => core.getSource(env, slug, path, version)));

    s.registerTool("list_source_history", {
      title: "List Source History",
      description: "List immutable versions and hashes for a public source file using cursor pagination.",
      inputSchema: z.object({
        slug: slugSchema,
        path: sourcePathSchema,
        cursor: cursorSchema,
        limit: limitSchema,
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, path, cursor, limit }) => execute(
      () => core.listSourceHistory(env, slug, path, { cursor, limit }),
    ));

    s.registerTool("set_params", {
      title: "Set Project Parameters",
      description: "Set versioned JSON parameters used by subsequent builds. Requires mutation permission.",
      inputSchema: z.object({
        slug: slugSchema,
        params: z.record(z.string(), z.unknown()),
      }).strict(),
      outputSchema,
      annotations: UPSERT,
    }, ({ slug, params }) => execute(async () => {
      return core.setParams(env, slug, params);
    }));

    s.registerTool("get_params", {
      title: "Get Project Parameters",
      description: "Read the current public versioned JSON parameters for a project.",
      inputSchema: z.object({ slug: slugSchema }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug }) => execute(() => core.getParams(env, slug)));

    s.registerTool("put_doc", {
      title: "Put Project Document",
      description: "Create or replace a Markdown project document. Requires mutation permission.",
      inputSchema: z.object({
        slug: slugSchema,
        kind: docKindSchema,
        markdown: z.string().max(250_000),
        build_id: buildIdSchema.optional(),
      }).strict(),
      outputSchema,
      annotations: REPLACE,
    }, ({ slug, kind, markdown, build_id }) => execute(async () => {
      return core.putDoc(env, slug, kind, markdown, build_id);
    }));

    s.registerTool("get_doc", {
      title: "Get Project Document",
      description: "Read a public project specification, instructions, bill of materials, or page document.",
      inputSchema: z.object({ slug: slugSchema, kind: docKindSchema }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, kind }) => execute(() => core.getDoc(env, slug, kind)));

    s.registerTool("run_build", {
      title: "Queue Build",
      description: "Queue an asynchronous CAD build. Requires compute permission; poll get_build with the returned build_id.",
      inputSchema: z.object({
        slug: slugSchema,
        entry: sourcePathSchema.default("build.py"),
        timeout_s: z.number().int().min(30).max(900).default(600),
        printer_profile: printerProfileSchema.optional(),
        // Retained for already-shipped MCP clients; new clients should use printer_profile.
        bed: z.number().finite().positive().max(1000).optional(),
        idempotency_key: idempotencyKeySchema,
      }).strict().refine((input) => !(input.printer_profile && input.bed !== undefined), {
        message: "printer_profile and bed cannot both be supplied",
      }),
      outputSchema,
      annotations: QUEUE,
    }, ({ slug, entry, timeout_s, printer_profile, bed, idempotency_key }) => execute(async () => {
      return core.runBuild(
        env,
        slug,
        entry,
        timeout_s,
        printer_profile ?? bed ?? 180,
        idempotency_key,
      );
    }));

    s.registerTool("retry_build", {
      title: "Retry Build",
      description: "Queue an exact retry from a terminal build's pinned inputs. Requires compute permission.",
      inputSchema: z.object({
        slug: slugSchema,
        build_id: buildIdSchema,
        idempotency_key: idempotencyKeySchema,
      }).strict(),
      outputSchema,
      annotations: QUEUE,
    }, ({ slug, build_id, idempotency_key }) => execute(async () => {
      return core.retryBuild(env, slug, build_id, idempotency_key);
    }));

    s.registerTool("cancel_build", {
      title: "Cancel Build",
      description: "Cancel a queued or running build. Requires mutation permission.",
      inputSchema: z.object({ slug: slugSchema, build_id: buildIdSchema }).strict(),
      outputSchema,
      annotations: CANCEL,
    }, ({ slug, build_id }) => execute(async () => {
      return core.cancelBuild(env, slug, build_id);
    }));

    s.registerTool("get_build", {
      title: "Get Build",
      description: "Get public build status and its full geometry-preflight report.",
      inputSchema: z.object({ slug: slugSchema, build_id: buildIdSchema }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, build_id }) => execute(() => core.getBuild(env, slug, build_id)));

    s.registerTool("list_builds", {
      title: "List Builds",
      description: "List public build summaries for a project using cursor pagination.",
      inputSchema: z.object({
        slug: slugSchema,
        cursor: cursorSchema,
        limit: limitSchema,
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, cursor, limit }) => execute(() => core.listBuilds(env, slug, { cursor, limit })));

    s.registerTool("list_artifacts", {
      title: "List Build Artifacts",
      description: "List the authoritative public artifact inventory for a build using cursor pagination.",
      inputSchema: z.object({
        slug: slugSchema,
        build_id: buildIdSchema,
        cursor: cursorSchema,
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, build_id, cursor }) => execute(() => core.listArtifacts(env, slug, build_id, cursor)));

    s.registerTool("get_artifact_url", {
      title: "Get Artifact Download URL",
      description: "Get structured metadata and a resource link for downloading one public build artifact.",
      inputSchema: z.object({
        slug: slugSchema,
        build_id: buildIdSchema,
        path: artifactPathSchema,
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, async ({ slug, build_id, path }) => {
      try {
        const object = await core.getArtifact(env, slug, build_id, path);
        const url = artifactUrl(this.props?.origin, slug, build_id, path);
        const data = {
          url,
          resource_uri: artifactResourceUri(slug, build_id, path),
          path,
          size: object.size,
          sha256: object.customMetadata?.sha256 ?? null,
        };
        return success(data, [{
          type: "resource_link",
          uri: url,
          name: path,
          title: `Download ${path}`,
          description: `Immutable artifact from build ${build_id}`,
          mimeType: artifactMimeType(path),
          size: object.size,
        }]);
      } catch (error) {
        return failure(error);
      }
    });

    s.registerTool("verify_target", {
      title: "Preflight Target Dimension",
      description: "Heuristically measure one print-oriented STL extent against a target. This is geometry preflight, not certification.",
      inputSchema: z.object({
        slug: slugSchema,
        build_id: buildIdSchema,
        path: artifactPathSchema,
        axis: z.enum(["x", "y", "z"]),
        expected: z.number().finite(),
        tolerance: z.number().finite().nonnegative(),
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, build_id, path, axis, expected, tolerance }) => execute(async () => {
      return core.verifyTarget(env, slug, build_id, path, axis, expected, tolerance);
    }));

    s.registerTool("measure", {
      title: "Measure Artifact Geometry",
      description: "Heuristically re-measure STL bounds, extents, watertightness, volume, and triangles. Requires compute permission.",
      inputSchema: z.object({
        slug: slugSchema,
        build_id: buildIdSchema,
        path: artifactPathSchema,
      }).strict(),
      outputSchema,
      annotations: READ_ONLY,
    }, ({ slug, build_id, path }) => execute(async () => {
      return core.measureArtifact(env, slug, build_id, path);
    }));

    s.registerResource(
      "project-summary",
      new ResourceTemplate("kiln://projects/{slug}", { list: undefined }),
      {
        title: "Project Summary",
        description: "Public project metadata, source manifest, documents, and recent builds.",
        mimeType: "application/json",
      },
      (uri, variables) => jsonResource(
        uri,
        () => core.getProjectDetail(env, resourceVariable(variables, "slug")),
      ),
    );

    s.registerResource(
      "source-file",
      new ResourceTemplate("kiln://projects/{slug}/sources/{+path}", { list: undefined }),
      {
        title: "Source File",
        description: "Latest public version of a project source file, represented as JSON.",
        mimeType: "application/json",
      },
      (uri, variables) => jsonResource(uri, () => core.getSource(
        env,
        resourceVariable(variables, "slug"),
        resourceVariable(variables, "path"),
      )),
    );

    s.registerResource(
      "authored-document",
      new ResourceTemplate("kiln://projects/{slug}/documents/{kind}", { list: undefined }),
      {
        title: "Authored Project Document",
        description: "Public authored project document in Markdown.",
        mimeType: "text/markdown",
      },
      (uri, variables) => markdownResource(uri, () => core.getDoc(
        env,
        resourceVariable(variables, "slug"),
        resourceVariable(variables, "kind"),
      )),
    );

    s.registerResource(
      "build-report",
      new ResourceTemplate("kiln://projects/{slug}/builds/{build_id}", { list: undefined }),
      {
        title: "Build Report",
        description: "Public asynchronous build state and geometry-preflight report.",
        mimeType: "application/json",
      },
      (uri, variables) => jsonResource(uri, () => core.getBuild(
        env,
        resourceVariable(variables, "slug"),
        resourceVariable(variables, "build_id"),
      )),
    );

    s.registerResource(
      "artifact-metadata",
      new ResourceTemplate(
        "kiln://projects/{slug}/builds/{build_id}/artifacts/{+path}",
        { list: undefined },
      ),
      {
        title: "Artifact Metadata and Download Link",
        description: "Public immutable artifact metadata and deployment-relative download URL.",
        mimeType: "application/json",
      },
      (uri, variables) => jsonResource(uri, async () => {
        const slug = resourceVariable(variables, "slug");
        const buildId = resourceVariable(variables, "build_id");
        const path = resourceVariable(variables, "path");
        const object = await core.getArtifact(env, slug, buildId, path);
        return {
          path,
          size: object.size,
          etag: object.etag,
          sha256: object.customMetadata?.sha256 ?? null,
          uploaded: object.uploaded.toISOString(),
          mime_type: artifactMimeType(path),
          download_url: artifactUrl(this.props?.origin, slug, buildId, path),
        };
      }),
    );

    s.registerPrompt("cad-discipline", {
      title: "CAD Geometry Preflight Discipline",
      description: "Kiln's CAD design and geometry-preflight rules for build scripts.",
    }, () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: DISCIPLINE } },
      ],
    }));
  }
}
