# kiln

Agentic parametric-CAD platform on Cloudflare: an LLM writes CadQuery
code and documentation; kiln executes, measures, verifies, renders, and
publishes the results (STLs, isometric previews, instructions, BOM) —
exposed to agents over remote MCP.

**Status: P2 built.** Live at https://kiln.timcf.workers.dev.
Roadmap and architecture: [docs/PLAN.md](docs/PLAN.md).

- ✅ **P0** — Worker + engine container scaffold, CI/CD via Workers Builds
- ✅ **P1** — CAD engine (cadquery 2.8/OCCT + trimesh + manifold3d +
  matplotlib), REST API for projects / versioned sources / builds, R2
  artifact archive, D1 metadata
- ✅ **P2** — MCP server (`/mcp`, 9 tools, server card at
  `/.well-known/mcp.json`). **Auth is temporarily open**
  (`MCP_PUBLIC=true` in `wrangler.jsonc`): the full Cloudflare Access
  OAuth stack is implemented and server-side verified (discovery,
  dynamic client registration, JWT validation), but every client-side
  path hit a dead end on 2026-07-05 — see `docs/PLAN.md` §11 for the
  saga and the next thing to try (a claude.ai custom connector).
- ⬜ P3 (Kumo React frontend), P4 (agent-ready polish), P5 (import the
  rodless blade rack as the first project), P6 (later: copilot, x402)

## Stack

- **Worker** (`src/`, TypeScript): REST API (`src/api.ts`, `src/core.ts`),
  MCP server (`src/mcp.ts`, `McpAgent`), Access auth (`src/access.ts`),
  `.well-known/*` discovery, static assets.
- **Engine container** (`engine/`, Python/FastAPI): `/build` (run a
  project's script, collect + verify artifacts), `/measure`, `/render`,
  `/artifact`, `/healthz`.
- **Frontend** (`public/` placeholder): reads live status from
  `/api/health`; replaced in P3 by React +
  [@cloudflare/kumo](https://github.com/cloudflare/kumo).
- **R2** (`kiln-artifacts`): immutable per-build artifacts. **D1**
  (`kiln`): projects, versioned sources, builds, docs, auth debug log
  (`migrations/`).

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
3. **MCP auth (Access):** `TEAM_DOMAIN` / `POLICY_AUD` vars point at the
   Access "MCP server" application (see `src/access.ts` for the two
   accepted auth paths). Currently bypassed via `MCP_PUBLIC=true` — flip
   to `"false"` (or remove) to re-enforce.

## Local dev

Wrangler 4 needs Node 22+; if the system Node is older, install one
locally and prefix `PATH` (no Docker locally → validate with `--dry-run
--containers-rollout=none`, real container builds happen in Workers
Builds):

```sh
npm ci
npm run check                                          # typecheck
npx wrangler deploy --dry-run --containers-rollout=none # validate config
npm run dev                                             # needs local Docker
```

## Smoke test

```sh
curl https://kiln.timcf.workers.dev/api/health
curl https://kiln.timcf.workers.dev/api/engine/healthz    # cold start: a few seconds
curl -X POST --data-binary @part.stl https://kiln.timcf.workers.dev/api/engine/measure

# create a project, add a build script, run it
curl -X POST https://kiln.timcf.workers.dev/api/projects \
     -H 'content-type: application/json' -d '{"slug":"demo","name":"demo"}'
curl -X PUT https://kiln.timcf.workers.dev/api/projects/demo/source \
     -H 'content-type: application/json' \
     -d '{"path":"build.py","content":"..."}'
curl -X POST https://kiln.timcf.workers.dev/api/projects/demo/builds

# MCP (currently open, no auth required)
curl -X POST https://kiln.timcf.workers.dev/mcp \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```
