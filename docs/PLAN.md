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

## 7. Auth (private-first)

- Everything behind **Cloudflare Access** (your employee account / org
  IdP): web UI, REST, artifact downloads.
- MCP: `workers-oauth-provider` with **Access as the upstream IdP** —
  agents do the standard OAuth 2.1 dance, you approve in browser once.
  Server card + PRM metadata advertise it, so this is the agent-ready
  OAuth story working end-to-end even while the service is private.
- Later public phases only change *policy* (Access rules, x402 rules at
  the edge), not code.

## 8. Phases

- **P0 — Scaffold (aligns us):** repo layout below, wrangler.jsonc with
  Worker + container + R2 + D1 + DO bindings, hello-world engine
  (`/measure` on an uploaded STL), Workers Builds connected, deploys on
  push. *Exit: git push → live at kiln.<your>.workers.dev.*
- **P1 — Engine:** full container image (cadquery/trimesh/manifold3d/
  matplotlib), generic build-runner protocol (project scripts declare
  parts + asserts, engine enforces watertight/bed-fit/support scans),
  R2 artifact layout, Workflow pipeline, build reports.
- **P2 — MCP:** McpAgent with the §5 toolset, OAuth via Access, server
  card, audit log. *Exit: Claude connects remotely and runs a coupon
  build end-to-end.*
- **P3 — Frontend:** Kumo UI — project gallery, build page (renders,
  report, artifact downloads, inline docs), param diff between builds.
  Port the nginx publish template as the default project page layout.
- **P4 — Agent-ready polish:** §6 table complete; WebMCP tools; llms.txt;
  markdown negotiation; API catalog.
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
  (scale-to-zero, no secrets inside, R2 access only via the Worker), and
  the service is private + OAuth'd + audit-logged.
- **Kumo churn:** young library (v2.6, June 2026); pin versions, keep UI
  thin over the REST API.
- **WebMCP maturity:** still early-stage; implement as progressive
  enhancement, not a dependency.
- **Standards drift (server card / x402):** both are edge/metadata
  concerns, isolated in `src/wellknown/` — cheap to track spec changes.
```
