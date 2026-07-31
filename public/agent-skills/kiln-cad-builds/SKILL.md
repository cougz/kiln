---
name: kiln-cad-builds
description: Author versioned CadQuery projects, queue reproducible builds, and inspect bounded geometry-preflight results and immutable artifacts with kiln.
compatibility: Requires HTTPS and either an RFC 8707-capable Streamable HTTP MCP client, an Access service token, or a REST client using the transition API key. Build scripts target Python 3.12 and CadQuery 2.8.
metadata:
  version: "0.3.0"
  service: "https://kiln.timcf.workers.dev"
  mcp: "https://kiln.timcf.workers.dev/mcp"
  openapi: "https://kiln.timcf.workers.dev/.well-known/openapi.json"
---

# kiln CAD Builds

Use kiln to maintain public, versioned CadQuery source and parameters, queue an
asynchronous build from exact pinned inputs, and inspect a SHA-256-verified
artifact archive.

## Safety and Data Boundary

Everything stored in kiln is public: project metadata, all source revisions,
parameters, documents, build settings, logs, reports, manifests, and artifacts.
Never send secrets, credentials, private designs, personal data, or regulated
data.

A build with status `verified` passed bounded mesh and printer-envelope
preflight and completed archive integrity checks. This is not proof that a part
is printable, needs no supports, has the requested local dimensions or fit,
will survive a load, is accurate on a physical printer, meets a regulation, or
is safe. Slice and inspect the exact STL for the actual machine and material,
then validate critical dimensions, tolerances, orientation, supports, material,
loads, and hazards independently.

## Production Connection

- MCP Streamable HTTP: `https://kiln.timcf.workers.dev/mcp`
- MCP Registry metadata: `https://kiln.timcf.workers.dev/server.json`
- REST guide: `https://kiln.timcf.workers.dev/api.md`
- OpenAPI 3.1.1: `https://kiln.timcf.workers.dev/.well-known/openapi.json`
- API catalog: `https://kiln.timcf.workers.dev/.well-known/api-catalog`
- Authentication guide: `https://kiln.timcf.workers.dev/auth.md`
- Browser workspace: `https://kiln.timcf.workers.dev/`

Public read tools and resources need no credentials on the public hostname.
For write and compute tools, use Cloudflare Access Managed OAuth. The client
must support RFC 8707 protected-resource indicators, authorization code with
PKCE, and the redirect URI allowed by the deployment. Access opens the user's
browser and redirects through the configured SSO provider.

For unattended automation use an Access service token. Existing automation may
temporarily configure either transition-key header:

```http
Authorization: Bearer <key>
```

```http
X-Kiln-API-Key: <key>
```

Managed OAuth discovery is provided by Cloudflare Access rather than the kiln
Worker. Access validates its opaque OAuth token and forwards a signed identity
assertion; kiln checks authorization on every protected `tools/call`.

## MCP Inventory

The server exposes 20 tools:

| Tool | Access | Use |
|---|---|---|
| `list_projects` | Public read | Cursor-page project summaries |
| `create_project` | Write | Create a public project |
| `update_project` | Write | Change public name or description |
| `get_project` | Public read | Metadata, source heads, documents, recent builds |
| `put_source` | Write | Append or deduplicate a source version |
| `get_source` | Public read | Latest or one exact source version |
| `list_source_history` | Public read | Cursor-page versions, sizes, and SHA-256 values |
| `set_params` | Write | Canonicalize and version the `params.json` object |
| `get_params` | Public read | Current parsed parameters and version |
| `put_doc` | Write | Replace `specification`, `instructions`, `bom`, or `page` Markdown |
| `get_doc` | Public read | Read one authored document |
| `run_build` | Compute | Queue current source heads and return a build ID |
| `retry_build` | Compute | Queue a new build from exact terminal-build inputs |
| `cancel_build` | Write | Cancel a queued or running build |
| `get_build` | Public read | Lifecycle, settings, provenance, and preflight report |
| `list_builds` | Public read | Cursor-page build summaries |
| `list_artifacts` | Public read | Cursor-page finalized archive inventory |
| `get_artifact_url` | Public read | Artifact metadata, HTTPS URL, and resource link |
| `verify_target` | Compute | Compare one STL extent with a numeric target |
| `measure` | Compute | Re-measure archived STL geometry |

There are five public resource templates:

| Resource | URI template |
|---|---|
| Project summary | `kiln://projects/{slug}` |
| Latest source file | `kiln://projects/{slug}/sources/{+path}` |
| Authored Markdown document | `kiln://projects/{slug}/documents/{kind}` |
| Build state and report | `kiln://projects/{slug}/builds/{build_id}` |
| Artifact metadata and download URL | `kiln://projects/{slug}/builds/{build_id}/artifacts/{+path}` |

The `cad-discipline` prompt provides the service's parametric design and
geometry-preflight guidance. Read it before authoring a non-trivial project.

Tools declare MCP behavior annotations for read-only, destructive,
idempotent, and open-world hints. These are behavior hints, not permissions.
For example, `verify_target` reads archived bytes but still requires compute
authorization.

## Structured Results

Successful tools return structured content and equivalent JSON text:

```json
{
  "ok": true,
  "data": {}
}
```

Failures set the MCP error flag and return:

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "status": 401,
    "message": "authentication required",
    "retryable": false
  }
}
```

Use `structuredContent` when the client exposes it; do not parse prose around
the JSON text. `get_artifact_url` also returns an MCP resource link for the
same immutable HTTPS artifact. Resource reads return typed JSON or Markdown
content directly rather than the tool envelope.

## Recommended Workflow

1. Call `list_projects` and select an existing project, or call
   `create_project` with a unique lowercase slug.
2. Call `update_project` when its public name or description needs revision.
3. Call `set_params` with dimensions and clearances. Build scripts should read
   the resulting versioned `params.json` rather than embed changing values.
4. Call `put_source` for `build.py` and any helper modules. Treat the returned
   version, SHA-256, and size as the saved revision identity.
5. Call `list_source_history` and `get_source(version=...)` when reviewing or
   restoring an older revision. Saving edited old content creates a new head;
   it never changes history.
6. Call `run_build` with `printer_profile: {x, y, z}` and a fresh idempotency
   key. Record the returned canonical `build_id` immediately.
7. Poll `get_build` about every 15 seconds until `verified`, `failed`, or
   `cancelled`. A transport timeout or disconnect is not cancellation.
8. Inspect `source_manifest`, exact settings, attempts, archive state,
   `report_json`, per-STL warnings, and failure code.
9. Call `list_artifacts` until its cursor is absent. Use
   `get_artifact_url` only for paths found in that authoritative inventory.
10. Optionally call `verify_target` for an overall X, Y, or Z extent, or
    `measure` for bounds, extents, watertightness, volume, and triangles.
11. Write `specification`, `instructions`, `bom`, or `page` Markdown with
    `put_doc`, optionally associating the canonical build ID.

## Minimal CadQuery Project

First call `set_params`:

```json
{
  "slug": "agent-box-example",
  "params": {
    "width": 40,
    "depth": 30,
    "height": 12
  }
}
```

Then call `put_source` with `path: "build.py"` and this complete content:

```python
import json
import math
import os

import cadquery as cq


with open("params.json", encoding="utf-8") as handle:
    params = json.load(handle)

width = float(params["width"])
depth = float(params["depth"])
height = float(params["height"])
assert all(math.isfinite(value) and value > 0 for value in (width, depth, height))

# centered=False places the part in positive X/Y with its bottom at Z=0.
part = cq.Workplane("XY").box(
    width,
    depth,
    height,
    centered=(False, False, False),
)

bounds = part.val().BoundingBox()
assert abs(bounds.xlen - width) <= 0.01
assert abs(bounds.ylen - depth) <= 0.01
assert abs(bounds.zlen - height) <= 0.01

os.makedirs("stl", exist_ok=True)
os.makedirs("asm", exist_ok=True)
cq.exporters.export(part, "stl/box.stl")
cq.exporters.export(part, "asm/box.stl")
```

Queue it with:

```json
{
  "slug": "agent-box-example",
  "entry": "build.py",
  "timeout_s": 600,
  "printer_profile": {"x": 180, "y": 180, "z": 180},
  "idempotency_key": "agent-box-example-build-1"
}
```

`stl/*.stl` files are checked as print-oriented meshes. `asm/*.stl` files are
preferred for standard front and side render generation but do not replace the
required `stl/*.stl` output.

## Pagination Rules

For `list_projects`, `list_builds`, and `list_source_history`, request a `limit`
from 1 through 100 and omit `cursor` on the first call. If the response data has
a cursor, pass that exact opaque string to the next call with the same logical
query. Stop when no cursor is present.

`list_artifacts` uses a fixed page size of at most 100 and accepts only
`cursor`. Never decode, edit, sort, or compare cursor strings. Protect against a
repeated cursor and stop rather than loop forever.

## Idempotency Rules

`run_build` and `retry_build` accept `idempotency_key`, 1 to 128 visible ASCII
characters without spaces. The key is project-scoped and hashed at rest.

- Create one key for one logical queue request.
- If delivery is uncertain, repeat the same call with the same key.
- A replay returns the existing build and `idempotent_replay: true`, even if
  the build is now terminal or cancelled.
- Do not reuse the key after changing source, parameters, printer profile,
  timeout, entry, or intent. kiln does not compare the new payload with the old
  payload before replaying the build.
- Use a new key when calling `retry_build`.

## Polling, Cancellation, and Retry

Terminal statuses are `verified`, `failed`, and `cancelled`. Poll every 15
seconds under normal conditions; do not busy-loop. A build may make automatic
Workflow attempts under the same build ID. The `attempt` and heartbeat fields
show progress.

Call `cancel_build` only for `queued` or `running`. The database cancellation
is authoritative; `workflow_terminated` only reports whether the best-effort
platform termination call succeeded. Calling cancel again on the same
cancelled build is safe. Other terminal builds reject cancellation.

Call `retry_build` only for a terminal build. It creates a new canonical ID
using the old exact source versions and SHA-256 values, exact parameter text,
entry, timeout, and printer profile. If provenance is missing or any source no
longer matches its manifest, the service refuses the retry. This is different
from an automatic Workflow attempt, which reuses the existing ID.

## Error and Retry Rules

- Read `error.code`, `error.status`, and `error.retryable` from structured
  output.
- Fix `400`, `401`, `403`, `404`, `409`, `413`, `415`, and `422` causes before
  retrying. Do not loop on authentication or validation failures.
- Back off on `429`; reduce concurrency if the active-build quota is reached.
- Retry a structured `retryable: true` failure with capped exponential backoff
  and jitter.
- If a queue call loses its response, retry with the same idempotency key and
  then poll the returned build ID.
- A `failed` build is terminal. Inspect `failure_code`, report notes, script
  exit, timeout, preflight warnings, and archive state before deciding whether
  an exact retry can help.
- Treat tool transport errors separately from build status. Query the known
  build ID before assuming the Workflow stopped.

## Verification Rules

Inspect every `stl_reports` entry and warning. The engine checks watertightness,
configured-volume placement, whether each disconnected component reaches the
bed, and a low-confidence sloped-overhang area budget. These checks can produce
false positives and false negatives.

`verify_target` and `measure` re-read finalized archived bytes. They do not
inspect source intent, local feature dimensions, tolerances, slicer behavior,
printer calibration, shrinkage, material properties, or loads. Always preserve
the archive manifest and artifact SHA-256 with any downstream review so the
review can identify the exact bytes it covered.
