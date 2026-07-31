# Current Plan

This is the execution plan for kiln 0.3.x. It describes current work and exit
criteria, not the history of how the service was built.

## Baseline

Version 0.3.0 provides:

- Public REST and MCP reads with Cloudflare Access browser sessions, Managed
  OAuth for compatible MCP clients, and a transition API-key fallback.
- Versioned sources, source history, parameters, project metadata, and four
  authored document kinds.
- Asynchronous, idempotent build queueing with cancellation, exact retries,
  heartbeat tracking, and scheduled stale-build reconciliation.
- Exact SHA-256 source and artifact manifests under one canonical build ID.
- Bounded Python/CadQuery execution and bounded geometry preflight heuristics.
- A browser authoring workspace, starter template, build inspection, artifact
  downloads, render previews, and an interactive STL viewer.
- Twenty MCP tools, five resource templates, one prompt, structured tool
  output, behavior annotations, and artifact resource links.
- API catalog, OpenAPI, Markdown negotiation, MCP Registry metadata, and a
  compatibility Agent Skills index.
- A runtime gate for the additive provenance migration, an explicit migration
  path, 17 Worker/MCP integration tests, 30 engine tests, and three CI jobs.

## Release Work

1. Apply every D1 migration explicitly in each environment.
2. Configure the Access team domain and application audiences, verify browser
   SSO and MCP Managed OAuth, and confirm unauthenticated writes receive `401`
   while public reads still succeed.
3. Deploy the Worker and engine image together with `wrangler deploy`.
4. Run deep health and a complete build smoke test with a new unique slug.
5. Verify the source manifest, artifact inventory, archive manifest, retry,
   cancellation, and stale reconciliation paths in production telemetry.
6. Publish the current skill digest in the Worker compatibility index whenever
   `SKILL.md` changes.

## Quality Gates

A 0.3.x change is releasable when:

- `npm run validate` succeeds with the engine dependencies installed.
- CI passes type checking, 17 Worker/MCP integration tests, dependency audit,
  browser script checks, all 30 engine tests, Python compilation, an engine
  image build, and a migration apply from an empty local database.
- `git diff --check` reports no whitespace errors.
- REST and MCP documentation match the implemented routes and tool schemas.
- Safety language describes checks as bounded preflight heuristics and makes no
  manufacturing, support, fit, strength, regulatory, or safety guarantee.
- Protected operations fail closed when Access and transition-key credentials
  are absent or invalid.

## Near-Term Engineering

- Extend Worker tests from discovery, authorization, source history, and MCP
  inventory into build idempotency, cancellation, exact retry, archive failure,
  and lifecycle-race scenarios with deterministic binding fakes.
- Extend protocol-level execution tests from authenticated writes into compute
  tools, structured error envelopes, and resource reads.
- Exercise Access signing-key rotation, OAuth refresh/revocation, service-token
  automation, and transition-key removal in an operator-tested procedure.
- Add archive audit tooling that re-hashes R2 objects against D1 metadata and
  `_kiln/archive-manifest.json` without invoking the CAD engine.
- Decide how to retire or migrate the unused historical `auth_log` table in a
  future migration; do not rewrite an already-applied migration.

## Boundaries

- The service does not offer accounts, tenant isolation, private projects,
  project deletion, slicing, printer control, or certification. OAuth is
  delegated to Cloudflare Access rather than implemented by kiln.
- Each build uses a dedicated engine container with outbound internet disabled;
  deployment smoke tests must still verify the platform boundary.
- Old server-card-shaped URLs are deprecated aliases for `/server.json`.
  kiln does not claim that those aliases implement a ratified Server Card
  protocol.
- External DNS and DNSSEC configuration are outside this repository.

Product sequencing beyond this release is in [ROADMAP.md](ROADMAP.md).
