# Roadmap

This roadmap describes priorities, not commitments or dates. The current
release contract is version 0.3.0.

## Current: Operate 0.3.x

- Keep public reads and API-key-protected writes/compute stable across REST and
  MCP.
- Preserve exact source and artifact provenance and canonical build IDs.
- Keep the OpenAPI description, API guide, skill, MCP metadata, and browser UI
  synchronized with implementation changes.
- Exercise migrations, unique-slug smoke builds, cancellation, exact retry, and
  stale reconciliation on every production rollout.
- Treat all geometry results as bounded preflight heuristics.

## Next: Test and Operate

- Expand the 15 Worker/MCP integration tests into build quotas, lifecycle races,
  conditional artifact reads, authenticated compute execution, and resource-read
  coverage with deterministic engine and Workflow fakes.
- Add an R2 archive audit command and operational metrics for queue age,
  attempt count, archive failures, cancellations, and stale reconciliation.
- Design a key-rotation overlap mechanism or a short maintenance procedure for
  the current single-key model.
- Add source/build comparison views without weakening immutable history.

## Later: Product Boundaries

- Private projects, accounts, and multi-user authorization only after a clear
  tenancy and data-retention design exists.
- A real OAuth provider only when delegated clients and scoped access are
  required; no OAuth metadata should be published before then.
- Optional model-assisted authoring only as a separate layer over the existing
  deterministic REST/MCP contract.
- On-demand rendering and richer assembly inspection if resource accounting
  and archive semantics remain bounded.
- Project deletion and retention only with explicit artifact, history,
  idempotency, and audit semantics.

## Not Claimed

kiln is not a slicer, printer controller, manufacturing service, structural
analysis package, metrology system, or certification authority. Those are not
roadmap shortcuts; they require different evidence and controls.
