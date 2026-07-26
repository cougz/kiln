# kiln

kiln 0.3.0 is a Cloudflare-hosted workspace for versioned CadQuery projects,
asynchronous CAD builds, immutable artifacts, and bounded geometry preflight.
It serves three audiences:

- People author source, parameters, project metadata, and Markdown documents in
  the browser, start from a CadQuery template, inspect build history and
  renders, and orbit archived STL files in the built-in 3D viewer.
- Agents use the Streamable HTTP MCP endpoint or the REST API. Public reads do
  not require credentials; every write and compute operation does.
- Operators deploy one Worker, isolated Python engine containers, a Workflow,
  D1, R2, and Durable Objects from this repository.

Production: <https://kiln.timcf.workers.dev>

## Important Limits

A kiln `verified` build means the script completed, the configured bounded
geometry checks passed, and the artifact archive was hash-verified. The checks
are preflight heuristics. They do not establish that a model is printable,
needs no supports, fits a physical mating part, has adequate strength, is safe,
or complies with a manufacturing or regulatory requirement. Inspect the model,
slice it for the actual machine and material, and validate critical dimensions
and loads independently.

All project metadata, source, parameters, documents, build reports, and
artifacts are public. Never submit secrets or private designs.

## Access Model

| Surface | Public | API key required |
|---|---|---|
| REST | Health, projects, source history, parameters, documents, builds, artifacts | Create or edit data, queue/retry/cancel builds, measure or verify geometry |
| MCP | Read tools, five resource templates, one prompt | Write and compute tools |
| Engine | `GET /api/engine/healthz` | No other engine route is exposed through the Worker |

Set `KILN_API_KEY` as a Worker secret. Send its value in either header:

```http
Authorization: Bearer <key>
X-Kiln-API-Key: <key>
```

If both headers are sent, they must match. Do not put a key in a URL, source
file, parameter, document, or artifact. There is no OAuth service or token
exchange in 0.3.0; see [public/auth.md](public/auth.md).

## Interfaces

- Browser application: <https://kiln.timcf.workers.dev/>
- MCP endpoint: <https://kiln.timcf.workers.dev/mcp>
- MCP Registry metadata: <https://kiln.timcf.workers.dev/server.json>
- REST guide: <https://kiln.timcf.workers.dev/api.md>
- Canonical OpenAPI: <https://kiln.timcf.workers.dev/.well-known/openapi.json>
- API catalog: <https://kiln.timcf.workers.dev/.well-known/api-catalog>
- Standalone agent skill:
  <https://kiln.timcf.workers.dev/agent-skills/kiln-cad-builds/SKILL.md>

MCP exposes 20 tools, five URI resource templates, and the `cad-discipline`
prompt. Tool results include structured output envelopes, stable errors,
behavior annotations, and artifact resource links. See
[public/llms.txt](public/llms.txt) for the compact inventory.

## Local Development

Requirements are Node.js 22.18 or newer, npm, Python 3.12 with the engine
requirements, and Docker for local container execution.

```sh
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r engine/requirements.txt
npx wrangler d1 migrations apply kiln --local
npm run validate
npm run dev
```

For protected local operations, create the git-ignored `.dev.vars` file:

```dotenv
KILN_API_KEY=replace-with-a-long-random-development-key
```

`npm run validate` type-checks the Worker and test suite, runs 15 Worker/MCP
integration tests and 30 engine tests, and performs a Wrangler dry run. GitHub
Actions also checks browser script syntax, production dependencies, Python
compilation, the engine Docker image, and a clean local migration apply.

## Deployment

The checked-in Wrangler configuration names the production D1 database and R2
bucket. A new deployment must create its own resources and replace the D1 ID in
`wrangler.jsonc` before deploying.

```sh
npx wrangler r2 bucket create kiln-artifacts
npx wrangler d1 create kiln
npx wrangler secret put KILN_API_KEY
npx wrangler d1 migrations apply kiln --remote
npm run deploy
```

Always run the explicit migration command. As a deployment safety gate, the
Worker and Workflow also check migration `0003_build_provenance.sql` before
database-backed work and apply that additive migration once if it is missing.
The runtime gate does not replace initial schema setup or an operator-reviewed
migration rollout.

`ALLOWED_ORIGINS` is an optional comma-separated list of exact `http` or
`https` origins allowed to make browser-origin MCP requests. Same-origin MCP is
always accepted. It does not configure REST CORS.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for rollout, health, migration,
reconciliation, and incident procedures.

## Smoke Test

The write smoke test is permanent public data because kiln has no project
delete operation. Use a unique, non-sensitive slug. The example needs `jq` and
assumes Bash:

```sh
export KILN_ORIGIN=https://kiln.timcf.workers.dev
export KILN_API_KEY='replace-with-the-deployment-key'
SLUG="smoke-$(date +%s)-${RANDOM}"
AUTH=(-H "Authorization: Bearer ${KILN_API_KEY}")

curl --fail-with-body -sS "${KILN_ORIGIN}/api/health"
curl --fail-with-body -sS "${KILN_ORIGIN}/api/engine/healthz"
curl --fail-with-body -sS \
  -H 'Accept: text/markdown' "${KILN_ORIGIN}/"

curl --fail-with-body -sS -X POST \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  --data "{\"slug\":\"${SLUG}\",\"name\":\"Deployment smoke test\"}" \
  "${KILN_ORIGIN}/api/projects"

SOURCE='import cadquery as cq
import os

part = cq.Workplane("XY").box(20, 16, 4, centered=(False, False, False))
os.makedirs("stl", exist_ok=True)
cq.exporters.export(part, "stl/smoke-box.stl")
'

curl --fail-with-body -sS -X PUT \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  --data "$(jq -n --arg path build.py --arg content "${SOURCE}" \
    '{path:$path,content:$content}')" \
  "${KILN_ORIGIN}/api/projects/${SLUG}/source"

QUEUED=$(curl --fail-with-body -sS -X POST \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-build-${SLUG}" \
  --data '{"entry":"build.py","timeout_s":600,"printer_profile":{"x":180,"y":180,"z":180}}' \
  "${KILN_ORIGIN}/api/projects/${SLUG}/builds")
BUILD_ID=$(jq -r .build_id <<<"${QUEUED}")

while :; do
  BUILD=$(curl --fail-with-body -sS \
    "${KILN_ORIGIN}/api/projects/${SLUG}/builds/${BUILD_ID}")
  STATUS=$(jq -r .status <<<"${BUILD}")
  printf '%s %s\n' "${BUILD_ID}" "${STATUS}"
  case "${STATUS}" in verified|failed|cancelled) break;; esac
  sleep 15
done

curl --fail-with-body -sS \
  "${KILN_ORIGIN}/api/projects/${SLUG}/builds/${BUILD_ID}/artifacts"
```

Also verify protected routes reject a missing key:

```sh
curl -i -X POST -H 'Content-Type: application/json' -d '{}' \
  "${KILN_ORIGIN}/api/projects/${SLUG}/builds"
```

The expected status is `401`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Build contract](docs/BUILD-CONTRACT.md)
- [Operations](docs/OPERATIONS.md)
- [Current plan](docs/PLAN.md)
- [Roadmap](docs/ROADMAP.md)
- [Changelog](docs/CHANGELOG.md)
- [REST API](public/api.md)
- [Authentication](public/auth.md)
