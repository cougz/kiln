"""FastAPI surface for bounded CAD builds, measurement, and rendering."""
import base64
import io
import sys
from typing import Annotated, Literal

import numpy as np
import trimesh
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

import runner
from render import render_views

MAX_BUILD_REQUEST_BYTES = 32 * 1024 * 1024
MAX_MEASURE_REQUEST_BYTES = runner.MAX_ARTIFACT_BYTES
MAX_RENDER_REQUEST_BYTES = 256 * 1024
MAX_RENDER_PATHS = 32


class RequestSizeLimitMiddleware:
    """Reject oversized fixed or streamed bodies before model processing."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = {
            ("POST", "/build"): MAX_BUILD_REQUEST_BYTES,
            ("POST", "/measure"): MAX_MEASURE_REQUEST_BYTES,
            ("POST", "/render"): MAX_RENDER_REQUEST_BYTES,
        }.get((scope["method"], scope["path"]))
        if limit is None:
            await self.app(scope, receive, send)
            return

        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > limit:
                        await JSONResponse(
                            status_code=413,
                            content={"detail": f"request body exceeds {limit} bytes"},
                        )(scope, receive, send)
                        return
                except ValueError:
                    pass

        received = 0
        response_started = False

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise RequestTooLarge(limit)
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except RequestTooLarge as exc:
            if response_started:
                raise
            await JSONResponse(
                status_code=413,
                content={"detail": f"request body exceeds {exc.limit} bytes"},
            )(scope, receive, send)


class RequestTooLarge(Exception):
    def __init__(self, limit: int):
        self.limit = limit


app = FastAPI(title="kiln-engine", version="0.3.0")
app.add_middleware(RequestSizeLimitMiddleware)

PHASE = "engine-v2"


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
        mesh = trimesh.load(io.BytesIO(body), file_type="stl", force="mesh")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"unparseable STL: {exc}") from exc
    if not isinstance(mesh, trimesh.Trimesh) or mesh.is_empty:
        raise HTTPException(status_code=422, detail="mesh is empty")
    return {
        "extents": [round(float(value), 4) for value in mesh.extents],
        "bounds": [[round(float(value), 4) for value in row] for row in mesh.bounds],
        "watertight": bool(mesh.is_watertight),
        "volume": round(float(mesh.volume), 4) if mesh.is_watertight else None,
        "triangles": int(len(mesh.faces)),
    }


Dimension = Annotated[float, Field(gt=0, le=1000)]
SourcePath = Annotated[str, Field(min_length=1, max_length=512)]
ArtifactPath = Annotated[str, Field(min_length=1, max_length=512)]


class PrinterVolume(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    x: Dimension
    y: Dimension
    z: Dimension


class BuildRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    files: dict[SourcePath, str] = Field(min_length=1, max_length=runner.MAX_SOURCE_FILES)
    entry: SourcePath = "build.py"
    timeout_s: int = Field(default=600, ge=1, le=900)
    bed: Dimension | PrinterVolume = 180.0
    printer_volume: PrinterVolume | None = None
    build_id: str | None = Field(default=None, pattern=runner.BUILD_ID_RE.pattern)

    @model_validator(mode="after")
    def validate_source_bytes(self):
        size = sum(len(content.encode("utf-8")) for content in self.files.values())
        if size > runner.MAX_SOURCE_BYTES:
            raise ValueError(f"source content exceeds {runner.MAX_SOURCE_BYTES} aggregate bytes")
        return self


@app.post("/build")
def build(req: BuildRequest):
    selected_volume = req.printer_volume or req.bed
    if isinstance(selected_volume, PrinterVolume):
        selected_volume = selected_volume.model_dump()
    try:
        return runner.run_build(
            req.files,
            req.entry,
            req.timeout_s,
            selected_volume,
            build_id=req.build_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/artifact/{build_id}/{path:path}")
def artifact(build_id: str, path: str):
    try:
        full = runner.artifact_path(build_id, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    import os

    if not os.path.isfile(full) or os.path.islink(full):
        raise HTTPException(status_code=404, detail="no such artifact")
    return FileResponse(full)


@app.delete("/build/{build_id}")
def delete_build(build_id: str):
    runner.cleanup(build_id)
    return {"ok": True}


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    build_id: str = Field(pattern=runner.BUILD_ID_RE.pattern)
    paths: list[ArtifactPath] = Field(min_length=1, max_length=MAX_RENDER_PATHS)
    views: list[Literal["front", "side", "top"]] = Field(
        default_factory=lambda: ["front", "side"],
        min_length=1,
        max_length=3,
    )
    title: str = Field(default="", max_length=200)


@app.post("/render")
def render(req: RenderRequest):
    try:
        files = [runner.artifact_path(req.build_id, path) for path in req.paths]
        images = render_views(files, req.views, req.title)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"render failed: {exc}") from exc
    return {view: base64.b64encode(png).decode() for view, png in images.items()}
