# Security

## Security Model

kiln 0.3.0 intentionally separates public data access from protected changes:

- REST and MCP reads are public.
- Writes and compute require the single shared `KILN_API_KEY`.
- Missing server configuration does not open writes. Protected operations
  still return `401` when `KILN_API_KEY` is absent.
- The Worker accepts `Authorization: Bearer <key>` or
  `X-Kiln-API-Key: <key>`. If both are present, they must match.
- There is no OAuth, account system, private-project mode, delegated scope, or
  token issuance endpoint.

The API key grants all mutation and compute permissions. It is not a tenant
boundary. Store it as a Cloudflare Worker secret, distribute it out of band,
and rotate it immediately if exposed. Version 0.3.0 accepts one active key, so
rotation is a coordinated cutover rather than an overlap window.

## Public Data Warning

Every project name, description, source revision, parameter value, document,
build setting, build log and report, source manifest, and archived artifact can
be read without a key. A key protects modification and compute consumption; it
does not make submitted data private.

Do not submit:

- API keys, credentials, cookies, tokens, or private endpoints.
- Proprietary source or models that cannot be public.
- Personal data or regulated data.
- Secrets encoded in parameters, generated documents, logs, images, or STL
  metadata.

## Execution Boundary

Submitted Python runs as an unprivileged user inside the engine container with
a minimal process environment. The runner:

- Validates source and artifact paths against traversal and control characters.
- Bounds source count and bytes, request bytes, timeout, output tree entries,
  artifact count and bytes, and retained logs.
- Runs the script in a separate process group and terminates descendants that
  remain in that group after normal completion or timeout.
- Rejects symlink and non-regular-file artifacts.
- Copies outputs into a read-only snapshot before serving them.
- Runs each build in its own no-egress container and destroys that container
  after Workflow collection or cancellation, also terminating escaped children.

The container is the native-code execution boundary. Outbound internet access
is disabled for the engine class, and each build receives project source and
settings but not the Worker API key or R2 credentials. Do not embed credentials
in submitted data: all project inputs and outputs remain public, and platform
configuration must still be verified after deployment.

## Engine Exposure

The Worker no longer provides a general engine proxy. The only direct public
engine route is `GET /api/engine/healthz`. Build execution, artifact collection,
rendering, and measurement reach internal engine endpoints only through Worker
or Workflow code.

Geometry re-measurement remains a protected compute operation through the MCP
`measure` tool. REST exposes the narrower protected target check at the build
`/verify` endpoint.

## Build Integrity

At queue time kiln records each source path, exact version, byte size, and
SHA-256. The Workflow verifies those bytes before execution. The engine hashes
every collected output. The Workflow checks size and SHA-256 before upload,
reads each R2 object back, hashes it again, records immutable artifact metadata,
and writes an archive manifest. Artifacts are unavailable until archive
finalization succeeds.

Archives created before this integrity contract are explicitly marked `legacy`.
They remain readable for compatibility but do not claim exact source provenance,
artifact SHA-256 verification, or an archive manifest.

This protects provenance and detects accidental or adversarial changes within
the pipeline. It does not prove that source behavior is benign or that geometry
is suitable for physical use.

## Geometry Disclaimer

The engine checks loaded mesh properties and configured-envelope placement,
then runs a low-confidence overhang-area heuristic. Results may have false
positives or false negatives. A passing result does not establish printability,
support requirements, orientation quality, dimensional accuracy, tolerances,
material behavior, structural strength, fatigue life, thermal behavior,
electrical safety, food or medical suitability, legal compliance, or general
safety.

`verify_target` compares one STL bounding-box extent with a numeric target and
tolerance. It is not metrology and does not evaluate local features or physical
process error.

## Abuse Controls

- REST limits public reads to 180 requests per 60-second window per client
  identity, mutations to 60 per key identity, and compute to 10 per key
  identity.
- MCP applies a 240-per-minute transport limit plus the same 60-per-minute
  mutation and 10-per-minute compute limits. Credentials are checked on every
  protected tool call rather than trusted from session state.
- At most two builds per project and two globally may be queued or running.
- Request and data limits are documented in [public/api.md](../public/api.md).
- Rate-limit identities are SHA-256 values; raw IP addresses and keys are not
  stored in the rate-limit table.
- A scheduled job removes expired rate-limit rows and fails stale builds.

Platform-level Cloudflare limits and controls can still apply independently of
these application limits.

## Browser and Origin Controls

The Worker emits a restrictive Content Security Policy, frame denial,
`nosniff`, no-referrer, permissions restrictions, and HSTS on HTTPS responses.
Artifact paths are encoded before use in URLs. Markdown is rendered by a small
conservative renderer rather than inserted as trusted HTML.

Browser-origin MCP requests are accepted from the current origin or exact
origins in `ALLOWED_ORIGINS`. Null, malformed, credential-bearing, path-bearing,
and non-HTTP origins are rejected. Non-browser MCP clients generally omit the
`Origin` header.

The browser stores a user-entered key in tab-scoped `sessionStorage`. This is a
convenience, not a hardware-backed secret store. Clear it on shared machines
and close the tab after use.

## Operational Checks

After every deployment:

1. Confirm `/api/health` reports version `0.3.0` and
   `write_auth_configured: true`.
2. Confirm a protected request without a key returns `401`.
3. Confirm the same request with the expected key succeeds.
4. Run a unique-slug build and inspect source and artifact SHA-256 manifests.
5. Review Worker logs for authentication failures, rate limits, dispatch
   failures, stale builds, and archive integrity errors without logging keys or
   request bodies.

See [OPERATIONS.md](OPERATIONS.md) for commands and incident procedures.
