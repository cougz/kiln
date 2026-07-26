# Operations

## Prerequisites

- Node.js 22.18 or newer and npm.
- Wrangler authentication for the target Cloudflare account.
- A D1 database, R2 bucket, Workflow binding, and Durable Object migrations as
  declared in `wrangler.jsonc`.
- Docker for local engine execution and container builds.
- Python 3.12 plus `engine/requirements.txt` for engine tests outside Docker.
- A long random production `KILN_API_KEY` stored as a Worker secret.

The repository's D1 ID and bucket name refer to the existing production
deployment. Forks must create resources and update their Wrangler bindings.

## Validation

```sh
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r engine/requirements.txt
npm run validate
```

`npm run validate` runs TypeScript checking, 15 Worker/MCP integration tests,
30 Python engine tests, and a Wrangler dry run with no container rollout. The
CI workflow adds JavaScript syntax checks, a moderate-severity production
dependency audit, Python compilation, an engine image build, and migration
testing from a clean local D1 database.

## Provisioning

For a new environment:

```sh
npx wrangler r2 bucket create kiln-artifacts
npx wrangler d1 create kiln
npx wrangler secret put KILN_API_KEY
```

Put the returned D1 `database_id` in the target Wrangler configuration. Do not
commit the secret. For local development, use the git-ignored `.dev.vars` file.

Optionally set `ALLOWED_ORIGINS` to a comma-separated list of exact browser
origins for cross-origin MCP. Values may be only complete `http` or `https`
origins such as `https://agent.example`; paths, queries, credentials, `null`,
and wildcards are not accepted. Same-origin MCP needs no configuration.

## Migrations

Apply migrations before deployment:

```sh
npx wrangler d1 migrations list kiln --remote
npx wrangler d1 migrations apply kiln --remote
```

Test the full migration sequence locally from the configured local state:

```sh
npx wrangler d1 migrations apply kiln --local
```

The Worker calls `ensureDatabaseSchema` before MCP, sitemap, health, project API,
and negotiated project requests, and scheduled maintenance calls it too. The
gate creates Wrangler's migration table if needed and applies the additive
`0003_build_provenance.sql` statements once when that migration is absent.
It resets its in-isolate readiness promise after failure so a later request can
retry.

The runtime gate exists because a Worker deployment does not itself run D1
migrations. It is not a bootstrap mechanism: a new database still needs the
initial migrations, and explicit operator application remains the supported
rollout path. Do not edit or replay an already-applied migration to change
production data.

## Deploy

```sh
npm run deploy
```

The deploy builds and publishes the Python engine image with the Worker. The
production configuration allows three basic engine instances: two dedicated
no-egress build containers plus one health/measurement utility. It keeps
utility instances warm for ten minutes after use and schedules maintenance
every ten minutes.

For GitHub, the checked-in CI runs on pushes to `main` and pull requests.
Cloudflare Workers Builds can separately deploy pushes to `main`; its account,
repository connection, and secret values are external configuration.

## Health Checks

```sh
curl --fail-with-body https://kiln.timcf.workers.dev/api/health
curl --fail-with-body 'https://kiln.timcf.workers.dev/api/health?deep=1'
curl --fail-with-body https://kiln.timcf.workers.dev/api/engine/healthz
```

The shallow response checks D1, R2, Workflow binding configuration, version,
and whether write authentication is configured. `deep=1` also starts and probes
the engine and can incur a cold start. Health responses are not cached.

Require all of these before enabling writers:

- `ok: true`
- `version: "0.3.0"`
- `d1: true`
- `r2: true`
- `workflow_configured: true`
- `write_auth_configured: true`
- Deep `engine.ok: true`

## Smoke Tests

Use the complete unique-slug smoke flow in [README.md](../README.md). It checks
public health and Markdown, authentication, project creation, source versioning,
asynchronous queueing with `printer_profile.x/y/z`, terminal polling, and the
artifact inventory.

Also inspect discovery after a deploy:

```sh
curl --fail-with-body https://kiln.timcf.workers.dev/server.json
curl --fail-with-body https://kiln.timcf.workers.dev/.well-known/api-catalog
curl --fail-with-body https://kiln.timcf.workers.dev/.well-known/openapi.json
curl -I https://kiln.timcf.workers.dev/.well-known/mcp/server-card.json
```

The final request should show deprecation and a canonical link to
`/server.json`; it is a compatibility test, not the preferred discovery URL.

## Monitoring

Worker request logs are structured JSON and include a request ID, normalized
path, status, and duration. Sensitive project path components are replaced in
the top-level request log. API errors return the same request identifier in
`X-Request-Id` and the JSON `request_id` field.

Scheduled maintenance logs its cron expression, scheduled time, reconciled
build count, deleted rate-limit count, duration, and success. Alert on:

- Health `503` or dependency booleans becoming false.
- `BUILD_DISPATCH_FAILED` or Workflow provisioning failures.
- `INPUT_INTEGRITY_FAILED`.
- `INVALID_ENGINE_RESPONSE`.
- `ARTIFACT_INTEGRITY_FAILED` or `ARCHIVE_FAILED`.
- Repeated `STALE_BUILD` reconciliation.
- Sustained `BUILD_QUOTA_EXCEEDED` or `RATE_LIMITED` responses.
- An unexpected `write_auth_configured: false`.

## Lifecycle Operations

Queueing is asynchronous. A request returning `202` means that the canonical
build ID and Workflow dispatch were created, not that geometry passed. Poll at
approximately 15-second intervals. Client disconnects do not stop a build.

Use the protected cancel endpoint for a queued or running build. Database state
is authoritative even if Workflow termination reports false; cancellation also
attempts to destroy the dedicated container and delete partial archive state.
Use exact retry only for a terminal build with complete provenance; it creates
a new build ID from the original pinned inputs.

Automatic Workflow attempts reuse the same ID and clear partial archive state.
Scheduled reconciliation marks builds stale after 30 minutes without progress.
If reconciliation repeatedly affects healthy long builds, investigate engine,
Workflow, D1, and R2 latency before changing the threshold.

## Key Rotation

Version 0.3.0 accepts one active shared key and has no overlap mechanism:

1. Stop or coordinate all writers and MCP clients.
2. Generate a new long random key.
3. Run `npx wrangler secret put KILN_API_KEY` and enter the new value.
4. Wait for the secret deployment to become active.
5. Verify the old key receives `401` and the new key succeeds.
6. Update clients through their secret stores, not source control or URLs.
7. Resume writers and clear old browser tab storage.

If a key is exposed in a public project, rotate it first. Source history is
immutable and public, so rotation is required even if another presentation
layer later hides the offending revision.

## Incident Notes

- D1 unavailable: reads and writes backed by project data fail; health is
  degraded. Do not dispatch new builds until D1 is stable.
- R2 unavailable: health is degraded and archive finalization or downloads can
  fail. Workflow retries may recover; do not label output finalized manually.
- Engine unavailable: shallow health may pass. Use deep health, expect cold
  start, and inspect Workflow retry/failure codes.
- Workflow unavailable: queue requests fail before a usable asynchronous run.
- Archive mismatch: preserve logs and metadata, do not bypass digest checks,
  and retry from exact pinned inputs after finding the storage or transport
  cause.
- Stale build: reconciliation has made the row terminal. Use exact retry rather
  than editing the old row.
- Lost key: replace it; there is no recovery or OAuth flow.

## External Constraints

Cloudflare account bindings, Workers Builds repository linkage, Worker secrets,
custom DNS records, and DNSSEC are not stored in this repository. Their actual
state must be verified in Cloudflare and the authoritative DNS provider.
