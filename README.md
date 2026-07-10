# kiln

Agentic parametric-CAD platform on Cloudflare: an LLM writes CadQuery
code and documentation; kiln executes, measures, verifies, renders, and
publishes the results (STLs, isometric previews, instructions, BOM) —
exposed to agents over remote MCP.

**Status: P0-P4 done.** Live at https://kiln.timcf.workers.dev.
Roadmap and architecture: [docs/PLAN.md](docs/PLAN.md).

- ✅ **P0** — Worker + engine container scaffold, CI/CD via Workers Builds
- ✅ **P1** — CAD engine (cadquery 2.8/OCCT + trimesh + manifold3d +
  matplotlib), REST API for projects / versioned sources / builds, R2
  artifact archive, D1 metadata
- ✅ **P2** — MCP server (`/mcp`, 9 tools, server card at
  `/.well-known/mcp.json`). **Public, no auth.** Cloudflare Access
  managed OAuth was fully implemented and server-side verified, but
  every client-side connection path dead-ended (see `docs/PLAN.md` §7)
  — removed rather than carried as unused complexity. Milestone proven:
  an agent drove a full build end-to-end through the MCP tools alone.
- ✅ **P3** — Frontend: vanilla-JS hash-routed SPA (`public/app.js`) over
  the REST API — project gallery, project detail, build page (report,
  renders, artifact downloads, inline docs). No bundler (CI doesn't run
  one); Kumo/React deferred until that changes.
- ✅ **P4** — Agent-ready polish: `/sitemap.xml`, `/.well-known/api-catalog`,
  markdown-negotiated `/projects/:slug`, refreshed robots.txt/llms.txt.
- ⬜ P5 (later: copilot, x402, WebMCP, three.js viewer)

## Stack

- **Worker** (`src/`, TypeScript): REST API (`src/api.ts`, `src/core.ts`),
  MCP server (`src/mcp.ts`, `McpAgent`), build pipeline Workflow
  (`src/workflow.ts` — builds are queued and run asynchronously),
  `.well-known/*` discovery, static assets.
- **Engine container** (`engine/`, Python/FastAPI): `/build` (run a
  project's script, collect + verify artifacts), `/measure`, `/render`,
  `/artifact`, `/healthz`.
- **Frontend** (`public/`): reads live status from `/api/health`;
  project gallery + build pages over the REST API.
- **R2** (`kiln-artifacts`): immutable per-build artifacts. **D1**
  (`kiln`): projects, versioned sources, builds, docs (`migrations/`).

## Setup (one-time, already done for this deployment)

1. **Workers Builds:** Cloudflare dash → Workers & Pages → `kiln` →
   connected to `cougz/kiln`; build command `npm ci`, deploy command
   `npx wrangler deploy` (default). Every push to `main` builds
   `engine/Dockerfile`, pushes it to the integrated registry, and deploys
   the Worker.
2. **R2 + D1** already created and bound (see `wrangler.jsonc`):
   ```sh
   npx wrangler r2 bucket create kiln-artifacts
   npx wrangler d1 create kiln
   npx wrangler d1 migrations apply kiln --remote
   ```
3. **MCP auth:** none. `/mcp` is intentionally open — see
   `docs/PLAN.md` §7.

## Local dev

Wrangler 4 needs Node 22+; if the system Node is older, install one
locally and prefix `PATH` (no Docker locally → validate with `--dry-run
--containers-rollout=none`, real container builds happen in Workers
Builds):

```sh
npm ci
npm run check                                          # typecheck
npm run test:engine                                    # engine unit tests (needs python3 + trimesh)
npx wrangler deploy --dry-run --containers-rollout=none # validate config
npm run dev                                             # needs local Docker
```

## Smoke test

```sh
curl https://kiln.timcf.workers.dev/api/health
curl https://kiln.timcf.workers.dev/api/engine/healthz    # cold start: a few seconds
curl -X POST --data-binary @part.stl https://kiln.timcf.workers.dev/api/engine/measure

# create a project, add a build script, queue a build (202 — async),
# then poll the returned build_id until 'verified'/'failed'
curl -X POST https://kiln.timcf.workers.dev/api/projects \
     -H 'content-type: application/json' -d '{"slug":"demo","name":"demo"}'
curl -X PUT https://kiln.timcf.workers.dev/api/projects/demo/source \
     -H 'content-type: application/json' \
     -d '{"path":"build.py","content":"..."}'
curl -X POST https://kiln.timcf.workers.dev/api/projects/demo/builds
curl https://kiln.timcf.workers.dev/api/projects/demo/builds/<build_id>

# MCP (public, no auth required)
curl -X POST https://kiln.timcf.workers.dev/mcp \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```
