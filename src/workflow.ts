import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { getContainer } from "@cloudflare/containers";
import { finishBuild } from "./core";
import type { Env } from "./index";

/** Build pipeline as a Workflow (PLAN.md §3): durable and retryable, so a
 *  multi-minute CAD build survives dropped client connections and transient
 *  engine failures. `run_build` queues and returns immediately; this owns
 *  the build row from 'queued' to 'verified'/'failed'.
 *
 *  Sources are pinned by (path, version) captured at queue time — a
 *  put_source racing the build can't change what gets built.
 */

export interface BuildWorkflowParams {
  build_id: string;
  project_id: string;
  entry: string;
  timeout_s: number;
  /** printer bed size (mm) the engine verifies stl/ exports against */
  bed?: number;
  r2_prefix: string;
  /** pinned source versions: path -> version */
  files: Record<string, number>;
}

// Only the fields the workflow reads; the engine's full report object
// (log, stl_reports, notes, …) is carried through at runtime and stored
// verbatim by finishBuild.
interface EngineReport {
  build_id: string;
  ok: boolean;
  artifacts: string[];
  notes?: string[];
}

const PREVIEW_VIEWS = ["front", "side"];

export class KilnBuildWorkflow extends WorkflowEntrypoint<Env, BuildWorkflowParams> {
  async run(event: WorkflowEvent<BuildWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      // One step for build + artifact archive + engine cleanup: the engine's
      // working directory only reliably exists within a single container
      // lifetime, so splitting these into separate steps could retry the
      // copy against a recycled container. The whole step is idempotent —
      // a retry reruns the build into the same immutable R2 prefix.
      const report = await step.do(
        "build on engine and archive artifacts",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "20 minutes" },
        async (): Promise<EngineReport> => {
          await this.env.DB.prepare(
            "UPDATE build SET status = 'running' WHERE id = ? AND status = 'queued'",
          )
            .bind(p.build_id)
            .run();

          const files: Record<string, string> = {};
          for (const [path, version] of Object.entries(p.files)) {
            const row = await this.env.DB.prepare(
              "SELECT content FROM source WHERE project_id = ? AND path = ? AND version = ?",
            )
              .bind(p.project_id, path, version)
              .first<{ content: string }>();
            if (!row) throw new NonRetryableError(`source ${path} v${version} not found`);
            files[path] = row.content;
          }

          const engine = getContainer(this.env.ENGINE);
          const res = await engine.fetch(
            new Request("http://engine/build", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                files,
                entry: p.entry,
                timeout_s: p.timeout_s,
                bed: p.bed ?? 180,
              }),
            }),
          );
          if (!res.ok) {
            const detail = `engine ${res.status}: ${await res.text()}`;
            // 4xx = the build request itself is bad; retrying can't help.
            if (res.status < 500) throw new NonRetryableError(detail);
            throw new Error(detail);
          }
          const result = (await res.json()) as EngineReport;

          try {
            for (const rel of result.artifacts) {
              const file = await engine.fetch(
                new Request(`http://engine/artifact/${result.build_id}/${rel}`),
              );
              if (file.ok) {
                await this.env.ARTIFACTS.put(p.r2_prefix + rel, await file.arrayBuffer());
              }
            }

            // The engine workspace only exists until cleanup below, so create
            // standard previews here rather than leaving every build script to
            // implement its own renderer. Assembly-coordinate meshes preserve
            // the design orientation; old scripts without asm/ get a fallback.
            const assemblyStls = result.artifacts.filter((path) => path.startsWith("asm/") && path.endsWith(".stl"));
            const printStls = result.artifacts.filter((path) => path.startsWith("stl/") && path.endsWith(".stl"));
            const paths = assemblyStls.length ? assemblyStls : printStls;
            if (result.ok && paths.length) {
              const missingViews = PREVIEW_VIEWS.filter((view) => !result.artifacts.includes(`img/kiln-${view}.png`));
              if (!missingViews.length) {
                result.notes = [...(result.notes ?? []), "build supplied standard img/kiln-*.png previews"];
              } else {
                if (!assemblyStls.length) {
                  result.notes = [...(result.notes ?? []), "standard previews use print-oriented stl/ (no asm/*.stl supplied)"];
                }
                const generatedPaths = missingViews.map((view) => `img/kiln-${view}.png`);
                const generatedKeys = generatedPaths.map((path) => p.r2_prefix + path);
                try {
                  await this.env.ARTIFACTS.delete(generatedKeys);
                  const render = await engine.fetch(
                    new Request("http://engine/render", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ build_id: result.build_id, paths, views: missingViews }),
                    }),
                  );
                  if (!render.ok) throw new Error(await render.text());
                  const images = (await render.json()) as Record<string, unknown>;
                  for (const view of missingViews) {
                    const data = images[view];
                    if (typeof data !== "string") throw new Error(`render response missing ${view} preview`);
                    const path = `img/kiln-${view}.png`;
                    await this.env.ARTIFACTS.put(p.r2_prefix + path, base64Bytes(data));
                    result.artifacts.push(path);
                  }
                } catch (err) {
                  try {
                    await this.env.ARTIFACTS.delete(generatedKeys);
                  } catch {}
                  result.artifacts = result.artifacts.filter((path) => !generatedPaths.includes(path));
                  result.notes = [...(result.notes ?? []), `preview render failed: ${err}`];
                }
              }
            }
            return result;
          } finally {
            // Never leave an engine workspace behind, even if R2 archival or
            // preview generation throws and causes the Workflow step to retry.
            try {
              await engine.fetch(new Request(`http://engine/build/${result.build_id}`, { method: "DELETE" }));
            } catch {}
          }
        },
      );

      await step.do("finalize build row", async () => {
        await finishBuild(this.env, p.build_id, report.ok ? "verified" : "failed", report);
      });
    } catch (err) {
      // Retries exhausted (or non-retryable): make sure the build row
      // doesn't stay 'running' forever.
      await step.do("mark build failed", async () => {
        await finishBuild(this.env, p.build_id, "failed", {
          ok: false,
          artifacts: [],
          error: String(err),
        });
      });
      throw err;
    }
  }
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
