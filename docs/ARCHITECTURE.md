# Architecture

## System Shape

```text
Browser, REST client, or MCP client
                 |
                 v
Cloudflare Worker (TypeScript)
  |-- static browser application
  |-- REST routing and authorization
  |-- Streamable HTTP MCP server
  |-- discovery and negotiated Markdown
  |-- D1 migration gate and scheduled maintenance
  |
  |-- D1: projects, source versions, builds, manifests, docs, rate limits
  |-- R2: immutable per-build artifact bytes
  |-- Workflow: durable asynchronous build orchestration
  |       |
  |       v
  |   Engine container (Python 3.12, CadQuery, trimesh)
  |       |-- execute bounded project source
  |       |-- snapshot bounded output files
  |       |-- produce geometry-preflight reports and SHA-256 manifests
  |       `-- render standard previews
  |
  `-- Durable Objects: engine and MCP session bindings
```

One `wrangler deploy` ships the Worker and the engine image. Static assets are
bound through Workers Assets with `run_worker_first`, so the Worker handles API,
MCP, discovery, content negotiation, and security headers before asset fallback.

## Public Routing

The Worker exposes:

- `/api/projects...` for REST project, source, parameter, document, build, and
  artifact operations.
- `/mcp` for MCP Streamable HTTP sessions.
- `/api/health` for D1, R2, Workflow, version, and key-configuration health.
- `/api/engine/healthz` as the only public route that reaches the engine
  directly. A deep health check also probes the engine.
- `/.well-known/openapi.json`, `/.well-known/api-catalog`, `/server.json`, and
  the compatibility Agent Skills index for discovery.
- `/` and `/projects/{slug}` as browser pages or Markdown when the client
  explicitly prefers `text/markdown` over `text/html`.

There is no raw `/api/engine/*` proxy for build, measurement, rendering, or
artifact access. Those engine endpoints are internal calls made by trusted
Worker code.

## Data Model

- `project` holds the stable ID, public slug, public name and description.
- `source` is append-only by `(project_id, path, version)`. It includes content,
  SHA-256, byte size, and creation time.
- `build` stores queue and runtime state, exact settings, pinned parameters,
  source manifest, archive state, retry linkage, heartbeats, and reports.
- `build_input` links each build to every exact source path and version with its
  SHA-256 and size.
- `artifact` records each finalized R2 object path, SHA-256, size, and key.
- `doc` holds one public Markdown document per supported kind and project.
- `rate_limit` implements fixed-window limits without storing raw client or key
  identities.

Parameters are canonical JSON stored as the versioned source `params.json`.
Build rows also retain the parsed object and exact pinned text.

## Build Flow

1. The Worker validates the request, permission, quotas, paths, sizes, timeout,
   and `printer_profile` dimensions `x`, `y`, and `z`.
2. It snapshots every current source head, calculates SHA-256 and size, pins
   parameters and settings, and creates one canonical 12-character build ID.
3. D1 records the queued build and `build_input` rows. A Workflow instance is
   created with the same ID and returns control to the client immediately.
4. The Workflow checks the schema, marks the build running, increments
   `attempt`, clears partial output from a prior Workflow attempt, validates
   pinned source bytes, and starts a dedicated no-egress engine container named
   from the canonical ID.
5. The engine creates a private workspace, runs the selected Python entry in a
   process group, terminates descendants that remain in that group, snapshots
   allowed outputs, hashes every artifact, and applies checks to `stl/*.stl`.
6. The Workflow validates the engine response and every artifact digest,
   uploads bytes to the canonical R2 prefix, reads each object back and hashes
   it again, and optionally generates standard front and side previews.
7. It writes `_kiln/archive-manifest.json`, replaces D1 artifact metadata,
   marks the archive verified, then finalizes the build as `verified` or
   `failed` according to the engine preflight result.
8. The dedicated build container is destroyed in a `finally` path, terminating
   escaped child processes and deleting the workspace. Public artifact reads
   are allowed only after the archive is finalized.

The build ID selected by the Worker is authoritative across D1, Workflow, the
engine workspace and report, the R2 prefix, archive metadata, REST, and MCP.
An engine response with another ID is rejected.

See [BUILD-CONTRACT.md](BUILD-CONTRACT.md) for lifecycle and integrity details.

## MCP

The MCP server and REST API call the same operations in `src/core.ts`. The MCP
surface adds:

- Tool-level input and output schemas.
- Structured `{ok, data}` or `{ok, error}` result envelopes plus equivalent
  text content.
- Read-only, destructive, idempotent, and open-world behavior annotations.
- Five `kiln://` resource templates for projects, source, documents, builds,
  and artifact metadata.
- Resource links from `get_artifact_url`.
- The `cad-discipline` prompt.

Authorization and permission-specific rate limits are enforced by the Worker on
every protected MCP tool request before it reaches the stateful agent. Stored
session state and tool-supplied identity or permission fields are not trusted.

## Browser

The dependency-free hash-routed application reads the same REST API. On an
Access-protected studio hostname, Cloudflare authenticates the browser with its
HTTP-only application cookie and forwards a signed `Cf-Access-Jwt-Assertion`.
The Worker validates that assertion and `GET /api/session` exposes only a
sanitized identity summary to JavaScript. The application supports:

- Public project browsing and a protected project-creation template.
- Public project metadata with protected editing.
- Source authoring, immutable history selection, and new-version saves.
- Versioned JSON parameter editing.
- Build queueing with separate printer `x`, `y`, and `z`, live polling,
  cancellation, and exact retry.
- Public authored-document editing and conservative Markdown previews.
- Build reports, manifests, renders, artifact previews and downloads.
- A same-origin WebGL STL viewer bounded to 16 MiB and 250,000 triangles.

The optional browser `document.modelContext` integration registers only two
public read tools and never receives an Access assertion or transition API key.

## Authentication

Cloudflare Access is the primary interactive authentication boundary:

- Browser requests use the normal Access redirect, upstream SSO, and
  `CF_Authorization` application cookie.
- RFC 8707-capable MCP clients use Access Managed OAuth with authorization code
  and PKCE. Cloudflare keeps the opaque OAuth token out of the origin contract.
- Both flows arrive at the Worker as `Cf-Access-Jwt-Assertion`. The Worker
  verifies RS256, issuer, application audience, expiry, and application-token
  type against the team's rotating JWKS.
- Access user `sub` and service-token `common_name` become stable rate-limit and
  audit subjects. Access-authenticated browser writes must be same-origin.
- `KILN_API_KEY` remains an optional compatibility and local-development
  fallback; the browser no longer accepts or stores it.

One whole-host self-hosted Access application protects the browser, REST API,
and `/mcp`. Its domain has no path because Cloudflare rejects Managed OAuth on
path-scoped application domains. The browser and MCP flows therefore share one
application audience and policy; only their client authentication mechanisms
differ.

## Discovery Metadata

`/server.json` is MCP Registry `server.json` metadata for the production
Streamable HTTP endpoint. `/.well-known/mcp/server.json` returns the same shape.
The older `/.well-known/mcp.json`, `/.well-known/mcp/server-card.json`, and
`/.well-known/mcp/server-cards.json` paths are deprecated compatibility aliases
with a canonical link to `/server.json`; kiln makes no ratified Server Card
claim for them.

The REST API has an OpenAPI 3.1.1 description and an API catalog linkset.
`/.well-known/agent-skills/index.json` is explicitly a non-standard
compatibility index and does not claim a ratified discovery schema.
