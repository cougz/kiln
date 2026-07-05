"""Build runner: execute a project's CadQuery build script in an isolated
working directory and collect + verify what it produced.

Contract (ported from the parametric-cad-stl skill):
  - the script exports print-oriented STLs to  stl/  (slicer-ready)
  - assembly-coordinate copies go to           asm/  (render/verify input)
  - it may also write renders to img/ and docs (*.md)
  - it exits non-zero if its own assertions fail
The engine independently re-verifies every stl/*.stl (watertight, bed
fit, support scan) — a build is only 'verified' if both the script's own
run and the engine's checks pass.
"""
import os
import shutil
import subprocess
import sys
import uuid

from checks import check_stl

BUILDS_DIR = "/builds"
MAX_LOG = 20_000
MAX_ARTIFACT_MB = 50
COLLECT_EXT = {".stl", ".png", ".md", ".json", ".svg"}


def _safe_join(root: str, rel: str) -> str:
    p = os.path.normpath(os.path.join(root, rel))
    if not p.startswith(root + os.sep):
        raise ValueError(f"unsafe path: {rel}")
    return p


def run_build(files: dict[str, str], entry: str, timeout_s: int, bed: float) -> dict:
    if entry not in files:
        raise ValueError(f"entry {entry!r} not among provided files")
    build_id = uuid.uuid4().hex[:12]
    wd = os.path.join(BUILDS_DIR, build_id)
    os.makedirs(wd)
    inputs = set()
    for rel, content in files.items():
        p = _safe_join(wd, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        inputs.add(os.path.normpath(rel))

    try:
        proc = subprocess.run(
            [sys.executable, entry],
            cwd=wd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env={**os.environ, "MPLBACKEND": "Agg"},
        )
        exit_code, timed_out = proc.returncode, False
        log = (proc.stdout + "\n--- stderr ---\n" + proc.stderr)[-MAX_LOG:]
    except subprocess.TimeoutExpired as exc:
        exit_code, timed_out = -1, True
        log = ((exc.stdout or "") + "\n--- stderr ---\n" + (exc.stderr or ""))[-MAX_LOG:]

    artifacts: list[str] = []
    for root, dirs, names in os.walk(wd):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, wd)
            if rel in inputs or os.path.splitext(name)[1].lower() not in COLLECT_EXT:
                continue
            if os.path.getsize(full) > MAX_ARTIFACT_MB * 1024 * 1024:
                continue
            artifacts.append(rel)
    artifacts.sort()

    stl_reports = {
        rel: check_stl(os.path.join(wd, rel), bed=bed)
        for rel in artifacts
        if rel.startswith("stl/") and rel.endswith(".stl")
    }
    checks_ok = all(r["ok"] for r in stl_reports.values()) if stl_reports else False
    return {
        "build_id": build_id,
        "ok": exit_code == 0 and checks_ok,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "log": log,
        "artifacts": artifacts,
        "stl_reports": stl_reports,
        "notes": [] if stl_reports else ["no stl/*.stl produced — nothing to verify"],
    }


def artifact_path(build_id: str, rel: str) -> str:
    if not build_id.isalnum():
        raise ValueError("bad build id")
    return _safe_join(os.path.join(BUILDS_DIR, build_id), rel)


def cleanup(build_id: str) -> None:
    if build_id.isalnum():
        shutil.rmtree(os.path.join(BUILDS_DIR, build_id), ignore_errors=True)
