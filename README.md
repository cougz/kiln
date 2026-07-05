# kiln

Agentic parametric-CAD platform on Cloudflare: an LLM writes CadQuery
code and documentation; kiln executes, measures, verifies, renders, and
publishes the results (STLs, isometric previews, instructions, BOM) —
exposed to agents over remote MCP.

**Status: P0 scaffold.** Roadmap and architecture: [docs/PLAN.md](docs/PLAN.md).

## Stack

- **Worker** (`src/`, TypeScript): routing, static assets; later REST API,
  MCP server (`McpAgent`), Workflows, `.well-known/*` discovery.
- **Engine container** (`engine/`, Python): geometry execution. P0 is
  trimesh-only (`/measure`); P1 adds cadquery/OCCT, rendering, verify.
- **Frontend** (`public/` placeholder): replaced in P3 by React +
  [@cloudflare/kumo](https://github.com/cloudflare/kumo).
- R2 (artifacts) and D1 (metadata) bindings arrive in P1 — stubs are
  commented in `wrangler.jsonc`.

## Setup (one-time)

1. **Connect Workers Builds:** Cloudflare dash → Workers & Pages →
   Create → *Import a repository* → `cougz/kiln`.
   - Build command: `npm ci`
   - Deploy command: `npx wrangler deploy` (default)
   Every push to `main` then builds `engine/Dockerfile`, pushes it to the
   integrated registry, and deploys the Worker — no GitHub Actions needed.
2. **(P1)** create resources, then uncomment the bindings in
   `wrangler.jsonc`:
   ```sh
   npx wrangler r2 bucket create kiln-artifacts
   npx wrangler d1 create kiln
   ```

## Local dev

```sh
npm ci
npm run check        # typecheck
npm run dev          # needs Docker locally for the engine container
```

## Smoke test (after deploy)

```sh
curl https://kiln.<account>.workers.dev/api/health
curl https://kiln.<account>.workers.dev/api/engine/healthz   # cold start: a few seconds
curl -X POST --data-binary @part.stl \
     https://kiln.<account>.workers.dev/api/engine/measure
```
