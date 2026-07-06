# kiln — agentic parametric-CAD platform on Cloudflare

> Plan v1 (2026-07-05).
> Naming note: "kiln" collides with kiln.fi (ETH staking) and the retired
> FogBugz Kiln — fine for a GitHub repo under your namespace; if the
> `kiln.workers.dev` subdomain is taken, fall back to `kiln-cad` for the
> Worker name only.

## 1. Vision

A place where an AI agent (or a human) turns parametric CAD code into
printed-part deliverables: STLs, isometric/side renders, instructions,
BOM, and a published project page — the workflow proven by the mini-ITX
rack project, lifted off one Linux box onto Cloudflare's edge.

The platform ships **empty** (zero built-in projects). The mini-ITX blade
rack is imported afterward as the first project and the public success
story. The LLM does the heavy lifting (writing CadQuery code, docs, BOM
prose); kiln provides deterministic tools: geometry execution,
measurement, verification, rendering, artifact storage, publishing.

**MCP-first:** the webapp performs no inference. Any agent connects over
remote MCP and brings its own model. A later phase can add an optional
in-app copilot (Workers AI / AI Gateway) without changing the core.

## 2. Feasibility findings (researched 2026-07-05)

| Question | Verdict |
|---|---|
| CadQuery/OpenCASCADE on Workers? | **No** — Python Workers are Pyodide; no native OCCT. Must run in **Cloudflare Containers**. |
| Containers capable enough? | **Yes** — up to 4 vCPU / 12 GiB / 20 GB disk (custom instance types GA since 2026-01), scale-to-zero, per-request wake. The rack build needs ~1 vCPU/1 GiB for ~2 min. |
| CI/CD on git push incl. container image? | **Yes** — Workers Builds' GitHub integration runs `wrangler deploy`, which **builds the Dockerfile and pushes to the integrated Cloudflare registry** automatically. Monorepo supported (per-Worker root dirs). |
| Remote MCP on Workers? | **Yes** — Agents SDK `McpAgent`: Streamable HTTP + legacy SSE, OAuth 2.1, Durable Object per session, WebSocket hibernation. |
| MCP Server Card | Real, ratified standard (SEP-1649, 2025-11-25): JSON at `/.well-known/mcp.json`. |
| Kumo | `@cloudflare/kumo` on npm, MIT, React + Base UI + Phosphor icons, docs at kumo-ui.com. Public — no employee-only blockers. |
| x402 / Monetization Gateway | Edge-enforced payment rules (dashboard/API/Terraform) on any route incl. MCP tools; stablecoin settlement; Web Bot Auth agent identity. **Deferred** (service starts private) but the architecture leaves the seam. |

## 3. Architecture

```
GitHub repo "kiln"  ──push──▶  Workers Builds (CI/CD, builds Dockerfile too)
                                     │ deploys
        ┌────────────────────────────┴───────────────────────────┐
        │  Worker: kiln  (TypeScript)                             │
        │  ├─ Frontend: React + @cloudflare/kumo (Workers Assets) │
        │  ├─ REST API (typed, OpenAPI → /.well-known/api-catalog)│
        │  ├─ MCP server (McpAgent, Streamable HTTP, OAuth 2.1)   │
        │  ├─ /.well-known/mcp.json (server card) + OAuth PRM     │
        │  ├─ robots.txt · llms.txt · md content negotiation      │
        │  └─ Workflows: build pipeline orchestration             │
        │        │ container binding (Durable Object)             │
        │  Container: kiln-engine (Python 3.12 image)             │
        │  ├─ cadquery 2.8 + trimesh + manifold3d + matplotlib    │
        │  ├─ POST /build   run project build script, emit stl/   │
        │  ├─ POST /measure bounds/extents/watertight/sections    │
        │  ├─ POST /render  front+side isometric PNGs (asm coords)│
        │  └─ POST /verify  bed-fit, overlap, collision, targets  │
        └──────────────┬───────────────────┬──────────────────────┘
                       │                   │
                 R2: artifacts        D1: metadata
                 (stl/img/docs,       (projects, builds,
                  immutable per-build) params, tool audit log)
```

- **One Worker, one wrangler.jsonc** — the container is declared in the
  same config (`containers` + `image: ./engine/Dockerfile`), so a single
  `wrangler deploy` (and thus a single git push) ships everything.
- **Build pipeline as a Workflow:** `run_build` → engine container
  (build + verify + support-scan) → artifacts to R2 → render pass →
  status in D1. Durable, retryable, survives container restarts —
  matches the multi-minute CAD build reality.
- **Artifacts are immutable per build** (R2 keys
  `projects/<id>/builds/<n>/stl/…`), which kills the entire class of
  stale-deploy bugs we hit on nginx: the page always references a build
  id, never "latest files in a folder".

## 4. Data model (D1)

- **project**: id, slug, name, description, created_by
- **source**: project_id, path, content, version (the CadQuery scripts +
  params — versioned like a tiny VCS; git remains upstream truth for the
  platform code, D1 holds *user project* code)
- **build**: id, project_id, source_version, params_json, status
  (queued/running/verified/failed), report_json (extents, watertight,
  support scan, assertions), r2_prefix, created_at
- **doc**: project_id, kind (spec/instructions/bom/page), markdown,
  html (rendered), build_id it describes

## 5. MCP tools (the parametric-cad-stl skill, as an API)

Project: `create_project`, `list_projects`, `get_project`
Source:  `put_source`, `get_source`, `set_params`
Geometry: `run_build` (async → build id), `get_build` (status+report),
          `measure` (ad-hoc: bounds/extents/watertight on any artifact),
          `verify_target` (assert measured value vs target ± tol)
Artifacts: `list_artifacts`, `get_artifact_url` (signed R2 URL),
           `render_views` (re-render specific parts/views)
Docs/publish: `put_doc` (LLM writes SPECIFICATION/INSTRUCTIONS/BOM),
              `publish` (make build the project's public page)

MCP **prompts** ship the skill's rules (no floating parts, solve free
dimensions, print-oriented exports, coupon-first gates) so any connecting
agent inherits the discipline. MCP **resources** expose build reports and
docs read-only.

## 6. Agent-ready checklist → implementation

| isitagentready category | kiln implementation |
|---|---|
| Discoverability | robots.txt (AI-bot rules + sitemap), sitemap.xml, `Link` headers, DNS-AID TXT record |
| Content accessibility | Markdown content negotiation (`Accept: text/markdown` on every project/doc page returns the source md), llms.txt |
| Bot access control | Cloudflare Bot Management + Web Bot Auth (employee account), Content Signals in robots.txt |
| Protocol discovery | MCP Server Card `/.well-known/mcp.json`, OAuth discovery + Protected Resource Metadata (RFC 9728), `/.well-known/api-catalog` from the OpenAPI spec |
| WebMCP | Frontend registers `navigator.modelContext` tools (browse projects, trigger builds) for in-browser agents — thin wrappers over the same API |
| Commerce | None at launch (private). Seam: x402 via Monetization Gateway rules on `/mcp` + artifact routes when/if opened up. |

## 7. Auth

- **`/mcp` is public and unauthenticated.** Cloudflare Access managed
  OAuth (the "customer-managed custom MCP server" pattern) was fully
  implemented and independently verified server-side — RFC 9728
  protected-resource metadata, legacy AS discovery, dynamic client
  registration, JWT validation against the team JWKS — but every
  client-side connection path dead-ended (dashboard sync step, and a
  localhost-redirect/network-topology mismatch for a real MCP client).
  Rather than carry that machinery unused, it was removed on
  2026-07-06: `src/access.ts` deleted, the well-known OAuth/PRM routes
  dropped, `MCP_PUBLIC`/`TEAM_DOMAIN`/`POLICY_AUD` vars removed from
  `wrangler.jsonc`. See the P2 status log for the full history.
- The rest of the surface (web UI, REST, artifact downloads) has no
  auth either at this stage — kiln is a small, low-stakes public
  service; the container is the sandbox (scale-to-zero, no secrets
  inside, R2 access only via the Worker).
- If real auth is needed later (monetization, multi-user), redo it as
  a Worker-side OAuth provider (`workers-oauth-provider`) rather than
  depending on an identity platform's own MCP-connector UI — that's
  the piece that failed, not OAuth itself.

## 8. Phases

- **P0 — Scaffold (aligns us):** repo layout below, wrangler.jsonc with
  Worker + container + R2 + D1 + DO bindings, hello-world engine
  (`/measure` on an uploaded STL), Workers Builds connected, deploys on
  push. *Exit: git push → live at kiln.<your>.workers.dev.*
- **P1 — Engine:** full container image (cadquery/trimesh/manifold3d/
  matplotlib), generic build-runner protocol (project scripts declare
  parts + asserts, engine enforces watertight/bed-fit/support scans),
  R2 artifact layout, Workflow pipeline, build reports.
- **P2 — MCP:** McpAgent with the §5 toolset, server card, public (no
  auth — see §7). *Exit: an agent runs a build end-to-end through the
  MCP tools alone.* ✅ done 2026-07-06.
- **P3 — Frontend:** project gallery, build page (renders, report,
  artifact downloads, inline docs). ✅ core done 2026-07-06 as a
  vanilla-JS hash-routed SPA over the REST API (no bundler — Workers
  Builds' CI only runs `npm ci` + `wrangler deploy`, so `public/` is
  served as-is). Deferred: swap in Kumo/React if/when a build step is
  added to CI; param diff between builds; the nginx publish template's
  richer per-part layout.
- **P4 — Agent-ready polish:** ✅ core done 2026-07-06 — sitemap.xml,
  `/.well-known/api-catalog`, markdown content negotiation on
  `/projects/:slug`, robots.txt/llms.txt refreshed. Deferred: WebMCP
  (`navigator.modelContext`) tools, Content Signals, DNS-AID TXT
  record, Web Bot Auth — all real §6 gaps, none blocking.
- **P5 — Success story:** import the rodless blade rack (sources, tuned
  params incl. DT_CLR=0.16 and the F-hole fix, docs, photos) as the
  first project + a case-study page.
- **P6 — Later:** in-app copilot (Workers AI/AI Gateway), x402 metering,
  multi-user, STL web viewer (three.js) alongside PNG renders.

## 9. Repo layout (monorepo, single deploy)

```
kiln/
├─ wrangler.jsonc          # worker + containers + r2 + d1 + do bindings
├─ package.json
├─ src/                    # Worker: api/, mcp/, wellknown/, workflows/
├─ web/                    # React + @cloudflare/kumo (Workers Assets)
├─ engine/                 # Container: Dockerfile, server.py, runner/
│                          #   (port of the parametric-cad-stl skill)
├─ migrations/             # D1
└─ docs/PLAN.md            # this file
```

## 10. Risks & mitigations

- **Engine image size** (OCCT wheels ≈ 1 GB): trim to python-slim +
  cadquery + headless matplotlib; registry and 20 GB disk are fine with
  this; cold start of a few seconds is irrelevant next to 2-min builds.
- **Arbitrary Python from agents:** the container *is* the sandbox
  (scale-to-zero, no secrets inside, R2 access only via the Worker).
  Since `/mcp` and the REST API are public and unauthenticated, this
  containment is the actual security boundary, not a policy layer —
  worth revisiting before any monetization or PII enters the picture.
- **Kumo churn:** young library (v2.6, June 2026); pin versions, keep UI
  thin over the REST API.
- **WebMCP maturity:** still early-stage; implement as progressive
  enhancement, not a dependency.
- **Standards drift (server card / x402):** both are edge/metadata
  concerns, isolated in `src/wellknown/` — cheap to track spec changes.

## 11. Status log

**P0 (2026-07-05):** scaffold shipped — Worker + `KilnEngine` container,
Workers Builds connected, deploys on push. Verified: `/api/health`,
engine `/healthz`.

**P1 (2026-07-05):** full engine (cadquery 2.8/OCCT + trimesh +
manifold3d + matplotlib), `/build` `/measure` `/render` `/artifact` on
the container; REST core (`src/core.ts`, `src/api.ts`) for projects,
versioned sources, builds; R2 (`kiln-artifacts`) + D1 (`kiln`) bound.
**Verified end-to-end**: a part built via the API on the cloud engine
was downloaded and re-measured locally with identical extents/
watertightness — the core loop (write CAD code → cloud build → verified
artifact) works.

**P2 (2026-07-05): MCP server built.**
`src/mcp.ts` — `KilnMcp` (`McpAgent`) at `/mcp`, Streamable HTTP, 9 tools
wrapping the REST core + a `cad-discipline` prompt carrying the
parametric-cad-stl skill's rules. Server card at `/.well-known/mcp.json`
(SEP-1649).

*Auth saga (2026-07-05 → 2026-07-06), concluded: removed.* Per user
request, `/mcp` initially used Cloudflare Access managed OAuth (the
"customer-managed custom MCP server" pattern), not a Worker-side OAuth
provider. Everything server-side was implemented and independently
verified with curl:
- RFC 9728 protected-resource metadata at
  `/.well-known/oauth-protected-resource` pointing at
  `https://cougz.cloudflareaccess.com` as the authorization server.
- A legacy-discovery shim (`/.well-known/oauth-authorization-server`)
  proxying the team's AS metadata, for clients that don't follow the 401
  `WWW-Authenticate: resource_metadata=` pointer.
- Dynamic client registration against the team AS — confirmed working
  by registering a throwaway client directly with curl.
- JWT validation (`src/access.ts`): verifies `Cf-Access-Jwt-Assertion` or
  a Bearer token against the team JWKS, issuer, and `POLICY_AUD`.
  Rejected attempts were logged to D1 (`auth_log`, migration `0002`).
- A secondary path, a shared-secret header (`MCP_SHARED_SECRET`,
  header `x-kiln-mcp-key`), existed for Access's own dashboard
  sync/connect step, which authenticates upstream via Custom Headers
  rather than OAuth.

*What didn't work — the client side, not kiln:*
- The Access dashboard's "Save and connect" sync step (Authentication
  type = OAuth) failed with an opaque "Invalid oauth credentials. Could
  not connect to upstream" and no detail reached our logs — the request
  apparently never got past the connector's own client-credential
  check, which looks like it expects a statically-configured OAuth
  client rather than using DCR.
- Note: the Access "MCP server" app type shows **no AUD tag** when you
  pick Authentication type = OAuth from scratch. The AUD only becomes
  visible on the plain Access application Access creates in the
  background for the app — open that to find `POLICY_AUD`.
- A real MCP client (Claude Code) got further — it discovered Access via
  RFC 9728, and presumably could register/authorize — but its OAuth
  callback listens on `localhost`, and Claude Code was running on a
  different network machine than the browser doing the login, so the
  redirect never reached the listener. This is a deployment-topology
  problem, not an Access or kiln bug.
- A claude.ai custom connector (Settings → Connectors → add the
  `/mcp` URL directly) was the last untried option, staying entirely in
  one browser to sidestep both failure modes above. **Decision: not
  pursued.** Per user direction on 2026-07-06, the whole Access-OAuth
  path was removed instead of chased further — `src/access.ts` deleted,
  well-known OAuth/PRM routes and `MCP_PUBLIC`/`TEAM_DOMAIN`/
  `POLICY_AUD` dropped from `wrangler.jsonc`/`src/index.ts`. `/mcp` is
  now plainly public; see §7. The `auth_log` D1 table (migration
  `0002`) is unused but left in place rather than reverting an applied
  migration.

**Milestone proven (2026-07-06):** an agent (this session) drove a
complete build through the MCP tools alone — no REST fallback —
against the live public `/mcp`: `create_project` → `put_source`
(CadQuery build script, project `mcp-milestone-coupon`) → `run_build`
→ `get_build` (verified report: watertight, bed-fit, support-free) →
`measure` (independent re-check of extents) → `get_artifact_url`
(confirmed downloadable with a plain `curl`, no auth). The build script
itself follows the parametric-cad-stl discipline the `cad-discipline`
prompt carries: the keyhole slot's Y-position is solved algebraically
from the plate's *measured* extents, not a hand-picked constant, and
asserted before export.

Two operational findings from the real run:
- `run_build` on a real (non-trivial) build took long enough that the
  **MCP client call itself timed out** (`-32001: Request timed out`)
  even though `timeout_s=300` was passed as the *build's* budget, not
  the transport's. The build kept running server-side regardless
  (Durable Object survives the dropped connection) and was recovered
  by polling `get_project`/`get_build` for the build id. Worth noting
  in tool descriptions: a `run_build` timeout on the wire does not
  mean the build failed — always poll before assuming so.
- The engine image has no fonts installed: `cadquery`'s `.text()`
  (font-based glyph extrusion, via OCCT's font manager) throws
  `AttributeError: 'NoneType' object has no attribute 'FontName'`
  rather than a clear "no font found" error. Noted for anyone hitting
  the same wall — either install a font package in
  `engine/Dockerfile` or avoid `.text()` until then.

**P3 + P4 (2026-07-06):** frontend and agent-ready polish landed in the
same session as the OAuth removal and milestone proof, per user
direction to "proceed with frontend and everything else."

- **P3:** `public/app.js` + `public/style.css` — a hash-routed
  (`#/p/:slug`, `#/p/:slug/b/:id`) vanilla-JS single-page app over the
  existing REST API, no bundler. Gallery (list + create), project
  detail (sources, recent builds), build detail (verification report,
  renders, artifact downloads, inline `.md` docs fetched and rendered
  as plain text). Chose vanilla JS over Kumo/React deliberately: CI
  (Workers Builds) only runs `npm ci` + `wrangler deploy`, no bundler
  step, so a React/Kumo frontend would need its own build pipeline
  wired in first — deferred, not blocking. Verified live against the
  real `mcp-milestone-coupon` project data.
- **P4:** `GET /sitemap.xml` (D1-backed, home + one entry per project),
  `GET /.well-known/api-catalog` (linked-resources pointing at the REST
  collection, `/mcp`, the server card, llms.txt, the sitemap),
  `GET /projects/:slug` content-negotiated on `Accept: text/markdown`
  (plain summary for agents) vs. a 302 into the SPA's `#/p/:slug` route
  for browsers. `robots.txt`/`llms.txt` refreshed to drop the stale
  "private during buildout" framing and advertise all of the above.
  All four endpoints curl-verified live post-deploy.
- Both phases deployed via the existing Workers Builds CI/CD (git push
  → build → deploy), not local `wrangler deploy` — confirmed working
  by polling `/api/health`'s `phase` field until it flipped after each
  push.

**Not done this session (explicitly deferred, not forgotten):**
- **P5 — Success story:** importing the rodless blade rack project
  (sources live at `/home/admin-ts/mini-itx-rack-mount-design` and
  `/var/www/3d-projects/mini-itx-rack-mount-design`) as kiln's first
  real published project + case study. This is a substantial content
  migration (multiple parts, tuned params, docs, photos) that deserves
  its own session rather than being rushed alongside the OAuth/P3/P4
  work.
- **P6 — Later:** in-app copilot, x402 metering, multi-user, three.js
  STL viewer. Unchanged from the original plan — genuinely later-stage.
- **P4 remainder:** WebMCP (`navigator.modelContext`) tools, Content
  Signals in robots.txt, DNS-AID TXT record, Web Bot Auth. Real gaps
  against §6, none blocking current usage.
```
