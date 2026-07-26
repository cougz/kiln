# Changelog

## 0.3.0 - 2026-07-26

### Security

- Added fail-closed API-key authorization for every REST and MCP write or
  compute operation, accepting Bearer or `X-Kiln-API-Key` headers.
- Kept project, source, document, build, artifact, resource, and read-tool
  access public and documented the public-data boundary.
- Removed the public raw engine proxy except for
  `GET /api/engine/healthz`.
- Added request, source, output, path, log, artifact, rate, and active-build
  bounds; process-group cleanup; symlink rejection; and browser-origin MCP
  controls.
- Added restrictive response security headers and safer browser handling for
  artifact URLs and Markdown.

### Builds

- Added exact per-build source manifests with path, version, byte size, and
  SHA-256, plus exact parameter text and settings.
- Made the Worker-selected build ID canonical across D1, Workflow, engine, R2,
  reports, and archive manifests.
- Added engine artifact SHA-256 manifests, pre-upload and post-upload digest
  checks, D1 artifact metadata, and `_kiln/archive-manifest.json`.
- Added separate printer-profile `x`, `y`, and `z` dimensions.
- Added idempotent queueing, cancellation, exact terminal retry, heartbeats,
  attempt tracking, archive states, active quotas, and scheduled stale-build
  reconciliation.
- Isolated each build in a dedicated no-egress container and destroy it on
  completion or cancellation; bounded Workflow reports and artifact memory.
- Clarified that mesh and overhang checks are bounded preflight heuristics, not
  evidence of printability, support behavior, manufacturing quality, fit,
  strength, compliance, or safety.

### API and MCP

- Added project metadata editing and immutable source-history reads.
- Expanded MCP to 20 tools, five resource templates, and one prompt.
- Added structured MCP output and stable errors, behavior annotations, resource
  content, and artifact resource links.
- Published `/server.json` as MCP Registry metadata and deprecated old
  server-card-shaped compatibility URLs without making a ratified Server Card
  claim.
- Published a practical OpenAPI 3.1.1 description, API catalog linkset, and
  Markdown negotiation for the homepage and project summaries.
- Added explicit API-key documentation and stated that OAuth is not available.

### Browser and Operations

- Added full browser project creation, a CadQuery starter template, metadata,
  source-history and parameter authoring, document editing, build controls,
  report and artifact inspection, render previews, and an interactive bounded
  WebGL STL viewer.
- Added the provenance migration and runtime migration gate, while retaining an
  explicit Wrangler migration command as the supported deployment procedure.
- Expanded CI to Worker, engine, and migration jobs, including an engine image
  build; the suites contain 15 Worker/MCP integration tests and 30 engine tests.

This changelog begins with the first hardened public contract. Earlier
development notes are intentionally not retained as current product behavior.
