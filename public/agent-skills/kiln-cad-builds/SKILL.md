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
2. Set dimensions with `set_params`; build scripts read the versioned
   `params.json` file from the workspace.
3. Write source with `put_source`.
4. Queue `run_build`; it is asynchronous and may outlive a client timeout.
5. Poll `get_build` until it is `verified` or `failed`.
6. Call `list_artifacts` for the authoritative archive inventory, then
   retrieve selected immutable artifacts with `get_artifact_url`.
7. Write build-associated `specification`, `instructions`, or `bom` Markdown
   with `put_doc` when the part is ready to hand off.

Keep dimensions parametric, assert critical measurements, and export parts
at the print bed origin. A verified build checks watertightness, bed fit,
placement, and overhangs; inspect warnings before treating a part as ready to
print. A verified build with `asm/*.stl` attempts standard front and side
preview PNGs; use `stl/*.stl` exports for print-oriented verification and
target checks.
