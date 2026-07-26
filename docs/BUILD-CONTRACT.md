# Build Contract

This document defines what a kiln 0.3.0 build records, how it transitions, and
what `verified` does and does not mean.

## Queue-Time Snapshot

`run_build` accepts:

- `entry`, default `build.py`.
- `timeout_s`, an integer from 30 through 900.
- `printer_profile` with positive millimeter dimensions `x`, `y`, and `z`, each
  no greater than 1000.
- An optional idempotency key.

The legacy scalar `bed` field remains accepted by REST and MCP for already
shipped clients, but new callers should use `printer_profile`. The two fields
cannot be combined.

Before dispatch, kiln captures every current source head. The immutable source
manifest contains, for each path:

```json
{
  "path": "build.py",
  "version": 3,
  "sha256": "64-lowercase-hex-digits",
  "size": 1842
}
```

`params.json` is an ordinary versioned source in that manifest. The build also
stores the exact pinned parameter text, its parsed object, entry, timeout,
printer profile, idempotency fingerprint, and optional retry parent. Source
edits made after queueing cannot affect the build.

## Canonical Build ID

The Worker creates a 12-character build ID and uses it as:

- The D1 build primary key and foreign key for inputs and artifacts.
- The Cloudflare Workflow instance ID.
- The ID sent to and required back from the engine.
- The engine workspace name.
- The R2 prefix segment under `projects/{project-id}/builds/{build-id}/`.
- The identifier in REST, MCP, reports, retries, and archive manifests.

The engine cannot substitute another ID. A mismatched report is an invalid
engine response. A user-requested exact retry receives a new canonical ID and
records the original in `retry_of`.

## Lifecycle

The public lifecycle is:

```text
queued -> running -> verified
                  -> failed
queued/running    -> cancelled
```

D1 retains `failed` as the underlying database status for a cancellation and
adds `cancelled_at`; public responses normalize that state to `cancelled`.

- `queued`: D1 and pinned inputs exist and Workflow dispatch succeeded.
- `running`: a Workflow attempt owns the build and updates heartbeats.
- `verified`: the archive was finalized and the engine preflight result was
  successful.
- `failed`: dispatch, input integrity, execution, preflight, engine response,
  archive, Workflow, or stale reconciliation failed.
- `cancelled`: the database cancellation is authoritative and Workflow
  termination is best effort.

Queueing returns immediately with HTTP `202` or the MCP equivalent. Poll
`get_build` about every 15 seconds until a terminal state. A client timeout or
disconnect does not cancel the Workflow.

The Workflow step permits up to two retries for retryable pipeline failures,
with exponential backoff starting at 10 seconds and a 30-minute step timeout.
Each attempt increments `attempt`, reuses the canonical ID, clears partial R2
objects and metadata, and starts from the pinned inputs. Engine request 4xx and
integrity or inactive-build failures are non-retryable.

## Idempotency

REST build queue and retry endpoints accept `Idempotency-Key`; MCP uses
`idempotency_key`. A key must contain 1 to 128 visible ASCII characters without
spaces. It is hashed before storage and scoped to a project.

Reusing a key returns the existing build, including a terminal or cancelled
build, with `idempotent_replay: true`. It does not create another Workflow and
does not compare a new payload with the original intent. Therefore:

- Generate one key for one logical queue operation.
- Reuse that key only when retrying delivery of the same request.
- Use a new key when source, settings, or intent changes.
- Use a separate new key for a user-requested exact retry.

Admission allows no more than two active builds per project and two globally,
matching the configured engine-instance ceiling. An idempotent replay is
checked before quota admission.

## Cancellation

Only `queued` or `running` builds can be cancelled. kiln first conditionally
marks the row cancelled, failed for archive purposes, and terminal. It then
asks the Workflow platform to terminate the instance, destroys the dedicated
build container, and removes partial archive state. A late Workflow update
cannot overwrite cancellation because lifecycle writes require an active,
non-cancelled row.

Cancelling an already cancelled build is idempotent. Cancelling any other
terminal build returns `409`. Partial output is never exposed as a finalized
archive.

## Exact Retry

`retry_build` and the REST `/retry` endpoint accept only terminal builds. The
new build reuses the original:

- Source paths and exact source versions.
- Source byte sizes and SHA-256 values.
- Entry path and timeout.
- Printer `x`, `y`, and `z` profile.
- Parsed parameters and exact parameter text.

Before queueing, kiln joins the pinned `build_input` rows back to their source
versions and re-hashes every source. A missing manifest, count mismatch,
version mismatch, size mismatch, or digest mismatch returns `409`; kiln will not
silently approximate an exact retry. Builds created before exact provenance was
available cannot be retried exactly.

An exact retry is distinct from an automatic Workflow attempt. It gets a new
canonical build ID and a `retry_of` link; an automatic attempt keeps the same
ID.

## Artifact Contract

The engine collects only regular, non-symlink files with these extensions:

```text
.stl .png .md .json .svg
```

It excludes submitted source files and temporary/cache directories. Collection
is bounded to 256 artifacts, 16 MiB per artifact, 64 MiB in aggregate, and
4096 output-tree entries. A collection rejection is reported and prevents a
successful preflight result.

The engine report contains `artifact_manifest`, mapping every reported path to
an exact SHA-256 and byte size. The Workflow requires a one-to-one match between
the artifact list and manifest, then:

1. Fetches each artifact from the engine.
2. Verifies size and SHA-256 before upload.
3. Stores the SHA-256 in R2 custom metadata.
4. Reads the object back and verifies the SHA-256 again.
5. Records path, SHA-256, size, and R2 key in D1.

Standard `img/kiln-front.png` and `img/kiln-side.png` previews are generated
when possible, preferring `asm/*.stl` and falling back to `stl/*.stl`. Preview
failure adds a note but does not change the engine geometry result. Generated
previews receive the same digest checks and enter the artifact manifest.

The Workflow writes `_kiln/archive-manifest.json` with schema version 1,
canonical build ID, source manifest, entry, timeout, printer profile, parameter
object, SHA-256 of the exact parameter text, and the sorted artifact manifest.
The archive manifest's own SHA-256 and size are recorded in the build report
and D1 inventory. It cannot include its own digest inside itself.

Artifact listing and download for current builds require `archive_status:
verified`, even when the overall build status is `failed` because the engine
preflight found issues. Downloads use long-lived immutable caching and a quoted
ETag based on the recorded SHA-256 when available.

Builds archived before this contract are marked `archive_status: legacy`. Their
artifacts remain readable for compatibility, but they have no authoritative D1
digest inventory or archive manifest and cannot be retried exactly.

## Geometry Preflight

Only `stl/*.stl` files participate in the build pass/fail geometry scan. At
least one such file is required. For each mesh, the engine reports:

- Bounds, extents, triangle count, and watertightness.
- Whether extents fit the configured `x`, `y`, and `z` volume within a 0.01 mm
  placement tolerance.
- Whether X and Y remain in the positive printer envelope and Z remains within
  the height envelope.
- Whether every disconnected component reaches Z=0 within tolerance.
- A low-confidence estimate of sloped downward-facing area above the first
  layer, compared with a fixed 120 mm2 budget.

The overhang scan deliberately excludes near-flat downward faces as bridges.
It cannot determine support requirements. All checks are bounded preflight
heuristics, not manufacturing or safety certification. `verified` must not be
interpreted as proof of printability, support behavior, fit, strength, machine
accuracy, material suitability, compliance, or safety.

`verify_target` loads a finalized `stl/*.stl`, measures one overall bounding-box
extent, and returns `passed` when `abs(actual - expected) <= tolerance`. This is
a convenience comparison, not physical metrology.

## Stale Reconciliation

Every ten minutes scheduled maintenance finds up to 100 non-cancelled `queued`
or `running` builds whose latest heartbeat, start, or creation time is more than
30 minutes old. It marks them `failed` with `STALE_BUILD`, fails the archive,
sets a finish time, and attempts to terminate each Workflow. The same job
deletes expired rate-limit rows.
