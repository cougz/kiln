# kiln REST API

Version 0.3.0 provides public reads for versioned CadQuery projects and
immutable build archives. Creating or changing data and all compute operations
require a validated Cloudflare Access identity or the transition API key.

Production base URL: `https://kiln.timcf.workers.dev`

Canonical machine-readable contract:
<https://kiln.timcf.workers.dev/.well-known/openapi.json>

API catalog: <https://kiln.timcf.workers.dev/.well-known/api-catalog>

## Authentication

Browser clients authenticate through the Cloudflare Access application
protecting the studio hostname. The browser sends the HTTP-only Access session
cookie automatically; it does not read or forward a token in JavaScript.

RFC 8707-capable non-browser clients use Cloudflare Access Managed OAuth.
Cloudflare handles OAuth discovery, authorization code with PKCE, opaque access
tokens, and refresh. The origin receives a signed `Cf-Access-Jwt-Assertion` for
both browser and Managed OAuth requests.

Existing automation and local development may use the optional `KILN_API_KEY`
fallback in one of these headers:

```http
Authorization: Bearer <key>
```

```http
X-Kiln-API-Key: <key>
```

If both key headers are present, their values must match. Credentials in query
parameters are not accepted. Missing or invalid credentials receive `401` with
`WWW-Authenticate: Bearer`. See [auth.md](./auth.md).

Public reads remain available without authentication on the public hostname.
Missing Access configuration and an absent fallback key do not make protected
routes public; those routes continue to return `401`.

## Request Rules

- JSON bodies require `Content-Type: application/json` or another `+json`
  media type and valid UTF-8.
- Unknown JSON fields are rejected on documented request objects.
- URL-encode each segment of a source or artifact path while preserving `/`
  separators.
- API JSON and errors use `Cache-Control: no-store`. Finalized artifact bytes
  use immutable one-year caching and an ETag.
- Returned database timestamps are UTC ISO 8601 strings.
- Do not submit secrets. All stored project data and artifacts are public.

## Endpoint Summary

| Method and path | Access | Purpose |
|---|---|---|
| `GET /api/health` | Public | Check D1, R2, Workflow, version, and authentication configuration; `?deep=1` also probes the engine |
| `GET /api/engine/healthz` | Public | Probe the internal engine health endpoint; this is the only raw engine route exposed |
| `GET /api/session` | Public | Read sanitized authentication method, email, and permissions for the current request |
| `GET /api/projects` | Public | List project summaries |
| `POST /api/projects` | Write | Create a project |
| `GET /api/projects/{slug}` | Public | Read metadata, source heads, documents, and ten recent builds |
| `PATCH /api/projects/{slug}` | Write | Edit public name or description |
| `PUT /api/projects/{slug}/source` | Write | Append or deduplicate an immutable source version |
| `GET /api/projects/{slug}/source/{path}` | Public | Read latest or `?version=N`; `?history=1` returns history |
| `GET /api/projects/{slug}/params` | Public | Read current versioned `params.json` object |
| `PUT /api/projects/{slug}/params` | Write | Canonicalize and version a JSON parameter object |
| `GET /api/projects/{slug}/docs` | Public | List authored documents |
| `GET /api/projects/{slug}/docs/{kind}` | Public | Read `specification`, `instructions`, `bom`, or `page` Markdown |
| `PUT /api/projects/{slug}/docs/{kind}` | Write | Create or replace a document, optionally linked to a build |
| `GET /api/projects/{slug}/builds` | Public | List build summaries |
| `POST /api/projects/{slug}/builds` | Compute | Queue an asynchronous build |
| `GET /api/projects/{slug}/builds/{buildId}` | Public | Read lifecycle, pinned inputs, settings, and report |
| `POST /api/projects/{slug}/builds/{buildId}/cancel` | Write | Cancel an active build |
| `POST /api/projects/{slug}/builds/{buildId}/retry` | Compute | Queue a new build from exact pinned inputs |
| `POST /api/projects/{slug}/builds/{buildId}/verify` | Compute | Compare one STL extent with a target and tolerance |
| `GET /api/projects/{slug}/builds/{buildId}/artifacts` | Public | List finalized archive metadata |
| `GET /api/projects/{slug}/builds/{buildId}/artifacts/{path}` | Public | Download an immutable artifact; supports `If-None-Match` |

There is no public REST endpoint for raw engine build, render, artifact, or
measurement calls.

## Project and Source Example

The examples use the transition API key so they work in a terminal without a
browser OAuth implementation. Use a unique slug because 0.3.0 has no delete
operation:

```sh
ORIGIN=https://kiln.timcf.workers.dev
SLUG="api-example-$(date +%s)-${RANDOM}"

curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${KILN_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data "{\"slug\":\"${SLUG}\",\"name\":\"API example\",\"description\":\"Public example project\"}" \
  "${ORIGIN}/api/projects"
```

Response:

```json
{
  "id": "a1b2c3d4e5f6",
  "slug": "api-example-1722000000-12345"
}
```

Edit project metadata without changing the slug:

```http
PATCH /api/projects/{slug}
Content-Type: application/json
Authorization: Bearer <key>

{"name":"Revised example","description":"The public description changed"}
```

Append source:

```http
PUT /api/projects/{slug}/source
Content-Type: application/json
Authorization: Bearer <key>

{
  "path": "build.py",
  "content": "import cadquery as cq\n"
}
```

The response identifies the immutable version and content digest:

```json
{
  "path": "build.py",
  "version": 1,
  "sha256": "c79cf0ae5b6c8d43fc1bf64b41abc73594799dec510adff78101c684bd80470f",
  "size": 22,
  "deduplicated": false
}
```

Writing byte-identical content to the current head returns the existing version
with `deduplicated: true`. To inspect immutable history:

```sh
curl "${ORIGIN}/api/projects/${SLUG}/source/build.py?history=1&limit=25"
curl "${ORIGIN}/api/projects/${SLUG}/source/build.py?version=1"
```

## Parameters and Documents

Parameters must be a JSON object. kiln sorts object keys, writes canonical
`params.json` text, versions it as source, and pins its exact content into every
subsequent build.

```http
PUT /api/projects/{slug}/params
Content-Type: application/json
Authorization: Bearer <key>

{"params":{"clearance":0.25,"height":12,"width":40}}
```

Documents support exactly `specification`, `instructions`, `bom`, and `page`:

```http
PUT /api/projects/{slug}/docs/instructions
Content-Type: application/json
Authorization: Bearer <key>

{"markdown":"# Instructions\n\nInspect before use.\n","build_id":"a1b2c3d4e5f6"}
```

The optional `build_id` must identify a build in the same project.

## Queue and Poll

```http
POST /api/projects/{slug}/builds
Content-Type: application/json
Authorization: Bearer <key>
Idempotency-Key: bracket-build-v1

{
  "entry": "build.py",
  "timeout_s": 600,
  "printer_profile": {"x": 220, "y": 220, "z": 250}
}
```

Response status is `202`:

```json
{
  "build_id": "7f31a9bc428d",
  "status": "queued",
  "note": "build runs in the background; poll get_build until it reaches a terminal status"
}
```

Poll `GET /api/projects/{slug}/builds/{buildId}` about every 15 seconds. Public
states are `queued`, `running`, `verified`, `failed`, and `cancelled`. A client
timeout or disconnect does not cancel the Workflow.

For current builds, the detail response includes exact `source_manifest`
entries with path, version, SHA-256, and size; `params_content`; parsed `params`;
entry, timeout, printer profile, attempt, retry parent, heartbeat and archive
fields; and the engine report. Builds created before provenance support report
`provenance_status: legacy_unavailable`, expose unknown settings as `null`, and
cannot be retried exactly. The Worker-selected build ID is canonical across D1,
Workflow, the engine, R2, reports, and manifests.

`verified` means the bounded geometry preflight passed and the archive was
hash-verified. It is not a printability, support, manufacturing, fit, strength,
regulatory, or safety certification.

## Idempotency, Cancellation, and Retry

`Idempotency-Key` is optional, project-scoped, 1 to 128 visible ASCII
characters, and stored only as a hash. Repeating a key returns the existing
build with `idempotent_replay: true`, even if that build is terminal. Use a key
for only one logical request; the service does not reject a changed payload
under an old key.

Cancellation and retry require an explicit empty JSON object:

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${KILN_API_KEY}" \
  -H 'Content-Type: application/json' -d '{}' \
  "${ORIGIN}/api/projects/${SLUG}/builds/${BUILD_ID}/cancel"
```

Only queued or running builds can be cancelled. Database cancellation is
authoritative; Workflow termination is best effort.

Exact retry accepts a terminal build and creates a new build ID from the
original source versions and hashes, exact parameter content, entry, timeout,
and printer profile. If complete provenance is absent or fails an integrity
check, retry returns `409` rather than using current source. Supply a new
idempotency key for the retry request.

## Artifacts and Target Checks

Finalized current archive pages contain path, size, upload time, ETag, and
SHA-256. Legacy archives remain readable with `archive_status: legacy`, but do
not claim source provenance, artifact digests, or archive verification. Current
archives also include `_kiln/archive-manifest.json`, which
records the canonical build ID, source manifest, settings, parameter-content
SHA-256, and artifact manifest. The archive manifest's own SHA-256 is in build
report metadata and the artifact inventory.

```sh
curl "${ORIGIN}/api/projects/${SLUG}/builds/${BUILD_ID}/artifacts"
curl -o part.stl \
  "${ORIGIN}/api/projects/${SLUG}/builds/${BUILD_ID}/artifacts/stl/part.stl"
```

Conditional download:

```http
GET /api/projects/{slug}/builds/{buildId}/artifacts/stl/part.stl
If-None-Match: "recorded-sha256"
```

A match returns `304`.

The protected target check only accepts `stl/*.stl` paths:

```http
POST /api/projects/{slug}/builds/{buildId}/verify
Content-Type: application/json
Authorization: Bearer <key>

{"path":"stl/part.stl","axis":"x","expected":42,"tolerance":0.1}
```

It measures the overall STL bounding-box extent and returns `actual`, `delta`,
`passed`, and the measurement report. It is a geometry convenience check, not
physical metrology or certification.

## Pagination

Cursors are opaque. Return them unchanged and stop when `cursor` is absent.

- `GET /api/projects` and project build lists return a legacy array of at most
  100 items when neither `cursor` nor `limit` is supplied.
- Supplying either pagination parameter returns `{projects, cursor}` or
  `{builds, cursor}`. Default page size is 25; maximum is 100.
- Source history always returns `{path, versions, cursor}` with the same page
  sizes.
- Artifact inventory returns `{artifacts, cursor}` in pages of at most 100 and
  accepts `cursor` but not `limit`.

Do not decode, edit, compare, or persist assumptions about cursor contents.

## Errors

REST errors have a stable envelope and request correlation ID:

```json
{
  "error": "authentication required",
  "code": "AUTH_REQUIRED",
  "request_id": "7d6f2a8c-5cb6-48bb-a0d6-bc39b25449cc"
}
```

The same ID is returned in `X-Request-Id`. Common statuses:

| Status | Meaning |
|---|---|
| `400` | Invalid path, query, JSON body shape, settings, cursor, or idempotency key |
| `401` | Missing or invalid Access assertion or transition API key |
| `403` | Authenticated context lacks permission, or an Access browser write is cross-origin |
| `404` | Route, project, source, document, build, or artifact not found |
| `405` | Method not allowed; inspect `Allow` |
| `409` | Slug conflict, terminal lifecycle conflict, unavailable archive, or missing/failed exact provenance |
| `413` | Request body exceeds 6 MiB |
| `415` | JSON media type required |
| `422` | STL measurement failed |
| `429` | Rate or active-build quota exceeded; REST rate errors include `Retry-After` |
| `500` | Internal failure with no implementation detail exposed |
| `502` | Invalid or failed engine response |
| `503` | Build admission, dispatch, engine, or dependency unavailable |

Retry `429` according to `Retry-After`. Retry `5xx` with capped exponential
backoff and jitter. Do not retry validation, authentication, permission, or
lifecycle conflicts unchanged. When queue delivery is uncertain, repeat the
same request with the same idempotency key before creating a new key.

## Limits

| Limit | Value |
|---|---:|
| JSON request body | 6 MiB |
| Source file | 500,000 UTF-8 bytes |
| Current source files per project | 128 |
| Aggregate current source | 5 MiB |
| Source path | 160 characters |
| Document Markdown | 250,000 UTF-8 bytes |
| Canonical parameter JSON | 50,000 UTF-8 bytes |
| Build timeout | 30 to 900 seconds |
| Printer dimension | greater than 0 and at most 1000 mm per axis |
| Active builds | 2 per project, 2 globally |
| Engine artifact count | 256 |
| Engine artifact size | 16 MiB each, 64 MiB aggregate |
| Retained build log | final 20,000 bytes |
| REST read rate | 180 per 60 seconds per client identity |
| Mutation rate | 60 per 60 seconds per authenticated identity |
| Compute rate | 10 per 60 seconds per authenticated identity |
| MCP transport rate | 240 requests per 60 seconds per client identity |

Cloudflare platform limits can apply in addition to these application limits.

## Discovery and Markdown

- `GET /.well-known/openapi.json` is the canonical OpenAPI 3.1.1 description.
- `GET /.well-known/api-catalog` is the API catalog linkset.
- `GET /server.json` is MCP Registry metadata, not a REST schema.
- `GET /` with `Accept: text/markdown` returns an agent-oriented summary when
  Markdown is preferred over HTML.
- `GET /projects/{slug}` with the same header returns a Markdown project
  summary; browser requests are redirected to the SPA route.
