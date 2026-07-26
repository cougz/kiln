---
name: kiln-cad-builds
description: Create versioned CadQuery projects and queue verified print-ready builds with kiln.
---

# kiln CAD builds

Use kiln to execute CadQuery source in the cloud and verify the resulting
print-ready artifacts.

## Connection

- MCP endpoint: `/mcp` (public Streamable HTTP; no authentication)
- Server card: `/.well-known/mcp/server-card.json`
- REST documentation: `/api.md`

## Workflow

1. Create or select a project.
2. Write source with `put_source`.
3. Queue `run_build`; it is asynchronous and may outlive a client timeout.
4. Poll `get_build` until it is `verified` or `failed`.
5. Inspect the report and retrieve immutable artifacts with
   `get_artifact_url`.

Keep dimensions parametric, assert critical measurements, and export parts
at the print bed origin. A verified build checks watertightness, bed fit,
placement, and overhangs; inspect warnings before treating a part as ready to
print.
