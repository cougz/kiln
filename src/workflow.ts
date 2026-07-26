import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { getContainer } from "@cloudflare/containers";
import { finishBuild, PARAMS_PATH, sha256Hex, type PrinterProfile } from "./core";
import { buildContainerName } from "./engine";
import type { Env } from "./index";
import { ensureDatabaseSchema } from "./schema";

/** Durable build pipeline. New builds use build_input as the authoritative
 * source snapshot; the payload maps remain for workflows queued before the
 * provenance migration was deployed.
 */

interface InputManifestValue {
  version: number;
  sha256: string;
  size: number;
}

export interface BuildWorkflowParams {
  build_id: string;
  project_id: string;
  entry: string;
  timeout_s: number;
  /** Legacy cubic-bed payload retained for already queued workflows. */
  bed?: number;
  printer_volume?: PrinterProfile;
  r2_prefix: string;
  files: Record<string, number>;
  input_manifest?: Record<string, InputManifestValue>;
  params: Record<string, unknown>;
  params_content?: string;
}

interface ArtifactDescriptor {
  sha256: string;
  size: number;
}

interface EngineReport {
  build_id: string;
  ok: boolean;
  artifacts: string[];
  artifact_manifest: Record<string, ArtifactDescriptor>;
  notes?: string[];
  archive_manifest?: ArtifactDescriptor & { path: string };
}

interface ArchivedArtifact extends ArtifactDescriptor {
  path: string;
  r2Key: string;
}

interface InputRow extends InputManifestValue {
  path: string;
  content: string;
}

interface EngineCompatibility {
  fetch(request: Request): Promise<Response>;
}

const PREVIEW_VIEWS = ["front", "side"] as const;
const ARCHIVE_MANIFEST_PATH = "_kiln/archive-manifest.json";
const MAX_ENGINE_REPORT_BYTES = 768 * 1024;
const MAX_PREVIEW_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
const FAILURE_CODES = new Set([
  "ARCHIVE_FAILED",
  "ARTIFACT_INTEGRITY_FAILED",
  "BUILD_INACTIVE",
  "ENGINE_REQUEST_REJECTED",
  "ENGINE_UNAVAILABLE",
  "INPUT_INTEGRITY_FAILED",
  "INVALID_ENGINE_RESPONSE",
]);

export class KilnBuildWorkflow extends WorkflowEntrypoint<Env, BuildWorkflowParams> {
  async run(event: WorkflowEvent<BuildWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    await step.do("ensure database schema", async () => ensureDatabaseSchema(this.env));
    try {
      const report = await step.do(
        "build on engine and verify archive",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" },
        async (): Promise<EngineReport> => this.buildAndArchive(params),
      );

      await step.do("finalize build row", async () => {
        await finishBuild(
          this.env,
          params.build_id,
          report.ok ? "verified" : "failed",
          report,
          report.ok ? undefined : "ENGINE_VERIFICATION_FAILED",
        );
      });
    } catch (error) {
      const failureCode = pipelineFailureCode(error);
      await step.do("mark build failed", async () => {
        await this.env.DB.prepare(
          `UPDATE build SET archive_status = 'failed'
           WHERE id = ? AND status IN ('queued','running') AND cancelled_at IS NULL`,
        )
          .bind(params.build_id)
          .run();
        await finishBuild(this.env, params.build_id, "failed", {
          ok: false,
          build_id: params.build_id,
          artifacts: [],
          artifact_manifest: {},
          error: "build pipeline failed",
          failure_code: failureCode,
        }, failureCode);
      });
      throw error;
    }
  }

  private async buildAndArchive(params: BuildWorkflowParams): Promise<EngineReport> {
    const attempt = await this.env.DB.prepare(
      `UPDATE build SET status = 'running', started_at = COALESCE(started_at, datetime('now')),
         heartbeat_at = datetime('now'), attempt = attempt + 1,
         archive_status = 'pending', archived_at = NULL
       WHERE id = ? AND status IN ('queued','running') AND cancelled_at IS NULL`,
    )
      .bind(params.build_id)
      .run();
    if ((attempt.meta.changes ?? 0) !== 1) throw new NonRetryableError("BUILD_INACTIVE");

    // A Workflow retry reuses the build ID and R2 prefix. Remove all partial
    // objects and metadata before invoking the engine again.
    await clearArchive(this.env, params.build_id, params.r2_prefix);
    await heartbeat(this.env, params.build_id);

    const files = await loadInputs(this.env, params);
    const paramsContent = params.params_content ?? JSON.stringify(params.params ?? {}, null, 2) + "\n";
    if (Object.hasOwn(params, "params")) {
      files[PARAMS_PATH] = paramsContent;
    }

    const engine = getContainer(this.env.ENGINE, buildContainerName(params.build_id));
    const printerVolume = params.printer_volume ?? cubicProfile(params.bed ?? 180);
    let archiveStarted = false;
    try {
      const response = await engine.fetch(
        new Request("http://engine/build", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            build_id: params.build_id,
            files,
            entry: params.entry,
            timeout_s: params.timeout_s,
            printer_volume: printerVolume,
          }),
        }),
      );
      await heartbeat(this.env, params.build_id);
      if (!response.ok) {
        if (response.status < 500) throw new NonRetryableError("ENGINE_REQUEST_REJECTED");
        throw new Error("ENGINE_UNAVAILABLE");
      }

      const report = await parseEngineReport(response, params.build_id);
      const archiveUpdate = await this.env.DB.prepare(
        `UPDATE build SET archive_status = 'archiving', heartbeat_at = datetime('now')
         WHERE id = ? AND status = 'running' AND cancelled_at IS NULL`,
      )
        .bind(params.build_id)
        .run();
      if ((archiveUpdate.meta.changes ?? 0) !== 1) throw new NonRetryableError("BUILD_INACTIVE");
      archiveStarted = true;

      const archived: ArchivedArtifact[] = [];
      for (const path of report.artifacts) {
        const descriptor = report.artifact_manifest[path];
        const artifactResponse = await engine.fetch(
          new Request(`http://engine/artifact/${encodeURIComponent(params.build_id)}/${encodePath(path)}`),
        );
        if (!artifactResponse.ok) throw new NonRetryableError("ARTIFACT_INTEGRITY_FAILED");
        const bytes = await artifactResponse.arrayBuffer();
        await requireDigest(bytes, descriptor, path);
        archived.push(await putVerifiedArtifact(this.env, params.r2_prefix, path, bytes, descriptor));
        await heartbeat(this.env, params.build_id);
      }

      await this.addPreviews(engine, params, report, archived);

      const sortedManifest = Object.fromEntries(
        Object.entries(report.artifact_manifest).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
      );
      const archiveManifestBytes = new TextEncoder().encode(JSON.stringify({
        schema_version: 1,
        build_id: params.build_id,
        source_manifest: params.input_manifest ?? null,
        entry: params.entry,
        timeout_s: params.timeout_s,
        printer_profile: printerVolume,
        params: params.params,
        params_content_sha256: await sha256Hex(paramsContent),
        artifacts: sortedManifest,
      }, null, 2) + "\n");
      const archiveManifestDescriptor = {
        sha256: await sha256Hex(archiveManifestBytes),
        size: archiveManifestBytes.byteLength,
      };
      const archiveManifest = await putVerifiedArtifact(
        this.env,
        params.r2_prefix,
        ARCHIVE_MANIFEST_PATH,
        archiveManifestBytes,
        archiveManifestDescriptor,
      );
      archived.push(archiveManifest);
      report.archive_manifest = {
        path: ARCHIVE_MANIFEST_PATH,
        sha256: archiveManifest.sha256,
        size: archiveManifest.size,
      };

      await replaceArtifactMetadata(this.env, params.build_id, archived);
      const archivedUpdate = await this.env.DB.prepare(
        `UPDATE build SET archive_status = 'verified', archived_at = datetime('now'),
           heartbeat_at = datetime('now')
         WHERE id = ? AND status = 'running' AND cancelled_at IS NULL`,
      )
        .bind(params.build_id)
        .run();
      if ((archivedUpdate.meta.changes ?? 0) !== 1) throw new NonRetryableError("BUILD_INACTIVE");
      return report;
    } catch (error) {
      if (archiveStarted) {
        try {
          await clearArchive(this.env, params.build_id, params.r2_prefix);
        } catch {}
      }
      throw error;
    } finally {
      // Every build gets a dedicated container. Destroying it also terminates
      // subprocesses that escaped the runner's process group.
      try {
        await engine.destroy();
      } catch {}
    }
  }

  private async addPreviews(
    engine: EngineCompatibility,
    params: BuildWorkflowParams,
    report: EngineReport,
    archived: ArchivedArtifact[],
  ): Promise<void> {
    const assemblyStls = report.artifacts.filter((path) => path.startsWith("asm/") && path.endsWith(".stl"));
    const printStls = report.artifacts.filter((path) => path.startsWith("stl/") && path.endsWith(".stl"));
    const paths = assemblyStls.length ? assemblyStls : printStls;
    if (!report.ok || !paths.length) return;

    const missingViews = PREVIEW_VIEWS.filter((view) => !report.artifacts.includes(`img/kiln-${view}.png`));
    if (!missingViews.length) {
      report.notes = [...(report.notes ?? []), "build supplied standard img/kiln-*.png previews"];
      return;
    }
    if (!assemblyStls.length) {
      report.notes = [...(report.notes ?? []), "standard previews use print-oriented stl/ (no asm/*.stl supplied)"];
    }

    try {
      const render = await engine.fetch(
        new Request("http://engine/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ build_id: params.build_id, paths, views: missingViews }),
        }),
      );
      if (!render.ok) throw new Error("preview render rejected");
      const images = await readBoundedJson(render, MAX_PREVIEW_RESPONSE_BYTES) as Record<string, unknown>;
      for (const view of missingViews) {
        const data = images[view];
        if (typeof data !== "string") throw new Error("preview missing");
        const path = `img/kiln-${view}.png`;
        const bytes = base64Bytes(data);
        const archivedBytes = archived.reduce((total, artifact) => total + artifact.size, 0);
        if (archivedBytes + bytes.byteLength > MAX_ARTIFACT_TOTAL_BYTES) {
          throw new Error("preview exceeds aggregate artifact limit");
        }
        const descriptor = { sha256: await sha256Hex(bytes), size: bytes.byteLength };
        archived.push(await putVerifiedArtifact(this.env, params.r2_prefix, path, bytes, descriptor));
        report.artifacts.push(path);
        report.artifact_manifest[path] = descriptor;
        await heartbeat(this.env, params.build_id);
      }
    } catch {
      const generated = missingViews.map((view) => `img/kiln-${view}.png`);
      const generatedKeys = generated.map((path) => params.r2_prefix + path);
      try {
        await this.env.ARTIFACTS.delete(generatedKeys);
      } catch {}
      for (let index = archived.length - 1; index >= 0; index--) {
        if (generated.includes(archived[index].path)) archived.splice(index, 1);
      }
      report.artifacts = report.artifacts.filter((path) => !generated.includes(path));
      for (const path of generated) delete report.artifact_manifest[path];
      report.notes = [...(report.notes ?? []), "preview render failed"];
    }
  }
}

async function loadInputs(env: Env, params: BuildWorkflowParams): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT bi.path, bi.source_version AS version, bi.sha256, bi.size,
            s.content
     FROM build_input bi JOIN source s
       ON s.project_id = bi.project_id AND s.path = bi.path AND s.version = bi.source_version
     WHERE bi.build_id = ? ORDER BY bi.path`,
  )
    .bind(params.build_id)
    .all<InputRow>();

  if (rows.results.length) {
    const files: Record<string, string> = {};
    const manifest = params.input_manifest;
    if (manifest && Object.keys(manifest).length !== rows.results.length) {
      throw new NonRetryableError("INPUT_INTEGRITY_FAILED");
    }
    for (const row of rows.results) {
      const expected = manifest?.[row.path];
      if (
        (expected && (
          expected.version !== row.version ||
          expected.sha256 !== row.sha256 ||
          expected.size !== row.size
        )) ||
        params.files[row.path] !== row.version ||
        new TextEncoder().encode(row.content).byteLength !== row.size ||
        await sha256Hex(row.content) !== row.sha256
      ) {
        throw new NonRetryableError("INPUT_INTEGRITY_FAILED");
      }
      files[row.path] = row.content;
    }
    return files;
  }

  // Compatibility for workflows queued immediately before migration 0003.
  const files: Record<string, string> = {};
  for (const [path, version] of Object.entries(params.files)) {
    const row = await env.DB.prepare(
      "SELECT content FROM source WHERE project_id = ? AND path = ? AND version = ?",
    )
      .bind(params.project_id, path, version)
      .first<{ content: string }>();
    if (!row) throw new NonRetryableError("INPUT_INTEGRITY_FAILED");
    files[path] = row.content;
  }
  return files;
}

async function parseEngineReport(response: Response, buildId: string): Promise<EngineReport> {
  let value: unknown;
  try {
    value = await readBoundedJson(response, MAX_ENGINE_REPORT_BYTES);
  } catch {
    throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
  }
  const report = value as Partial<EngineReport>;
  if (
    report.build_id !== buildId ||
    typeof report.ok !== "boolean" ||
    !Array.isArray(report.artifacts) ||
    !report.artifact_manifest ||
    typeof report.artifact_manifest !== "object" ||
    Array.isArray(report.artifact_manifest)
  ) {
    throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
  }
  const paths = new Set<string>();
  let aggregateSize = 0;
  if (report.artifacts.length > MAX_ARTIFACTS) throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
  for (const path of report.artifacts) {
    if (
      typeof path !== "string" ||
      path === ARCHIVE_MANIFEST_PATH ||
      !safeArtifactPath(path) ||
      paths.has(path)
    ) {
      throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
    }
    paths.add(path);
    const descriptor = report.artifact_manifest[path];
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0 ||
      descriptor.size > MAX_ARTIFACT_BYTES
    ) {
      throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
    }
    aggregateSize += descriptor.size;
    if (aggregateSize > MAX_ARTIFACT_TOTAL_BYTES) throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
  }
  if (
    Object.keys(report.artifact_manifest).length !== paths.size ||
    Object.keys(report.artifact_manifest).some((path) => !paths.has(path))
  ) {
    throw new NonRetryableError("INVALID_ENGINE_RESPONSE");
  }
  return report as EngineReport;
}

async function requireDigest(
  bytes: ArrayBuffer | Uint8Array,
  expected: ArtifactDescriptor,
  path: string,
): Promise<void> {
  const size = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength;
  if (size !== expected.size || await sha256Hex(bytes) !== expected.sha256) {
    throw new NonRetryableError(`ARTIFACT_INTEGRITY_FAILED:${path}`);
  }
}

async function putVerifiedArtifact(
  env: Env,
  prefix: string,
  path: string,
  bytes: ArrayBuffer | Uint8Array,
  descriptor: ArtifactDescriptor,
): Promise<ArchivedArtifact> {
  if (!safeArtifactPath(path)) throw new Error("ARTIFACT_INTEGRITY_FAILED");
  if (descriptor.size > MAX_ARTIFACT_BYTES) throw new NonRetryableError("ARTIFACT_INTEGRITY_FAILED");
  await requireDigest(bytes, descriptor, path);
  const r2Key = prefix + path;
  await env.ARTIFACTS.put(r2Key, bytes, {
    customMetadata: { sha256: descriptor.sha256 },
  });
  const stored = await env.ARTIFACTS.get(r2Key);
  if (!stored || stored.size !== descriptor.size) throw new Error("ARCHIVE_FAILED");
  const storedBytes = await stored.arrayBuffer();
  if (await sha256Hex(storedBytes) !== descriptor.sha256) throw new Error("ARCHIVE_FAILED");
  return { path, r2Key, ...descriptor };
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("response too large");
  if (!response.body) throw new Error("response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}

async function replaceArtifactMetadata(
  env: Env,
  buildId: string,
  artifacts: ArchivedArtifact[],
): Promise<void> {
  if (!artifacts.length) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifact WHERE build_id = ?").bind(buildId),
    ...artifacts.map((artifact) => env.DB.prepare(
      `INSERT INTO artifact (build_id, path, sha256, size, r2_key)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(buildId, artifact.path, artifact.sha256, artifact.size, artifact.r2Key)),
  ]);
}

async function clearArchive(env: Env, buildId: string, prefix: string): Promise<void> {
  await env.DB.prepare("DELETE FROM artifact WHERE build_id = ?").bind(buildId).run();
  for (;;) {
    const objects = await env.ARTIFACTS.list({ prefix, limit: 1000 });
    if (!objects.objects.length) return;
    await env.ARTIFACTS.delete(objects.objects.map((object) => object.key));
  }
}

async function heartbeat(env: Env, buildId: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE build SET heartbeat_at = datetime('now')
     WHERE id = ? AND status = 'running' AND cancelled_at IS NULL`,
  )
    .bind(buildId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new NonRetryableError("BUILD_INACTIVE");
}

function cubicProfile(size: number): PrinterProfile {
  return { x: size, y: size, z: size };
}

function safeArtifactPath(path: string): boolean {
  return path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function pipelineFailureCode(error: unknown): string {
  const text = String(error);
  for (const code of FAILURE_CODES) {
    if (text.includes(code)) return code;
  }
  return "BUILD_PIPELINE_FAILED";
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
