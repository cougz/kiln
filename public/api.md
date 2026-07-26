# kiln REST API

kiln is a public, unauthenticated API for versioned CadQuery projects and
asynchronous verified builds. Use the remote MCP endpoint at `/mcp` when an
MCP client is available.

## Discovery

- OpenAPI: `/.well-known/openapi.json`
- API catalog: `/.well-known/api-catalog`
- Health: `GET /api/health`

## Projects

- `GET /api/projects` lists projects.
- `POST /api/projects` creates a project with `slug`, `name`, and optional
  `description`.
- `GET /api/projects/:slug` returns project sources and recent builds.
- `PUT /api/projects/:slug/source` writes a versioned source with `path` and
  `content`.
- `GET /api/projects/:slug/source/:path` reads the latest source version.
- `GET /api/projects/:slug/params` reads the current versioned parameter
  object. `PUT` accepts `{ "params": { ... } }`; builds receive it as
  `params.json` and retain it in their build record.
- `GET /api/projects/:slug/docs` lists project documents.
- `GET /api/projects/:slug/docs/:kind` retrieves a document. Supported kinds
  are `specification`, `instructions`, `bom`, and `page`.
- `PUT /api/projects/:slug/docs/:kind` creates or updates Markdown with
  `markdown` and an optional associated `build_id`.

## Builds

- `POST /api/projects/:slug/builds` queues a build and returns HTTP 202.
  Optional JSON fields are `entry`, `timeout_s`, and `bed`.
- `GET /api/projects/:slug/builds` lists builds.
- `GET /api/projects/:slug/builds/:buildId` returns status and verification
  report. Poll until the status is `verified` or `failed`.
- `GET /api/projects/:slug/builds/:buildId/artifacts` lists the immutable
  archived artifacts. Pass an opaque `cursor` query parameter to continue a
  paginated result.
- `GET /api/projects/:slug/builds/:buildId/artifacts/:path` downloads an
  immutable build artifact.
- `POST /api/projects/:slug/builds/:buildId/verify` independently measures an
  STL extent against a target. Send `path`, axis (`x`, `y`, or `z`),
  `expected`, and non-negative `tolerance`; the response contains `passed`.

Build source uses CadQuery/Python and is executed in a sandboxed Cloudflare
Container. Reports include watertightness, printer-bed fit, placement, and
overhang checks.
