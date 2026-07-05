"""kiln-engine P0: the measurement half of the CAD skill, as a service.

The measurement rules mirror the parametric-cad-stl workflow: never guess
geometry — load the mesh, report bounds/extents/watertightness, and let
the caller do algebra on real numbers.
"""
import io
import sys

import numpy as np
import trimesh
from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="kiln-engine", version="0.0.1")

PHASE = "P0"


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "phase": PHASE,
        "python": sys.version.split()[0],
        "trimesh": trimesh.__version__,
        "numpy": np.__version__,
    }


@app.post("/measure")
async def measure(request: Request):
    """Measure a mesh. Body: raw STL bytes."""
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
