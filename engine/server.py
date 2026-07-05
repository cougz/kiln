"""kiln-engine P1: geometry execution service.

Endpoints:
  GET  /healthz                    stack versions (cadquery imported lazily)
  POST /measure                    raw STL bytes -> extents/bounds/watertight
  POST /build                      {files, entry, timeout_s?, bed?} -> run +
                                   collect + verify (see runner.py contract)
  GET  /artifact/{build_id}/{path} stream one produced file
  DELETE /build/{build_id}         drop a build's working directory
  POST /render                     {build_id, paths, views?, title?} -> PNGs
                                   (base64) rendered from asm/ meshes
"""
import base64
import io
import sys

import numpy as np
import trimesh
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

import runner
from render import render_views

app = FastAPI(title="kiln-engine", version="0.1.0")

PHASE = "P1"


@app.get("/healthz")
def healthz():
    versions = {
        "python": sys.version.split()[0],
        "trimesh": trimesh.__version__,
        "numpy": np.__version__,
    }
    try:
        import cadquery  # deferred: OCCT import costs seconds on cold start

        versions["cadquery"] = cadquery.__version__
    except Exception as exc:  # pragma: no cover
        versions["cadquery"] = f"IMPORT FAILED: {exc}"
    return {"ok": "IMPORT FAILED" not in str(versions), "phase": PHASE, **versions}


@app.post("/measure")
async def measure(request: Request):
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body; send raw STL bytes")
    try:
        mesh = trimesh.load(io.BytesIO(body), file_type="stl")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"unparseable STL: {exc}")
    if mesh.is_empty:
        raise HTTPException(status_code=422, detail="mesh is empty")
    return {
        "extents": [round(float(v), 4) for v in mesh.extents],
        "bounds": [[round(float(v), 4) for v in row] for row in mesh.bounds],
        "watertight": bool(mesh.is_watertight),
        "volume": round(float(mesh.volume), 4) if mesh.is_watertight else None,
        "triangles": int(len(mesh.faces)),
    }


class BuildRequest(BaseModel):
    files: dict[str, str]
    entry: str = "build.py"
    timeout_s: int = 600
    bed: float = 180.0


@app.post("/build")
def build(req: BuildRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="no files provided")
    try:
        return runner.run_build(req.files, req.entry, min(req.timeout_s, 900), req.bed)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/artifact/{build_id}/{path:path}")
def artifact(build_id: str, path: str):
    try:
        full = runner.artifact_path(build_id, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    import os

    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="no such artifact")
    return FileResponse(full)


@app.delete("/build/{build_id}")
def delete_build(build_id: str):
    runner.cleanup(build_id)
    return {"ok": True}


class RenderRequest(BaseModel):
    build_id: str
    paths: list[str]
    views: list[str] = ["front", "side"]
    title: str = ""


@app.post("/render")
def render(req: RenderRequest):
    try:
        files = [runner.artifact_path(req.build_id, p) for p in req.paths]
        images = render_views(files, req.views, req.title)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"render failed: {exc}")
    return {view: base64.b64encode(png).decode() for view, png in images.items()}
