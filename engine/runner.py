"""Execute a CAD build, snapshot bounded outputs, and verify print STLs.

The dedicated container is the isolation boundary and is configured without
internet egress by the Worker. This module also limits inputs, retained logs,
and outputs and tears down the build's process group before trusting output.
"""
import errno
import hashlib
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Mapping, Sequence

from checks import DEFAULT_BED, check_stl, normalize_printer_volume

BUILDS_DIR = "/builds"
MAX_SOURCE_FILES = 128
MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_LOG_BYTES = 20_000
MAX_LOG = MAX_LOG_BYTES  # retained for callers that imported the old constant
MAX_ARTIFACTS = 256
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_ENTRIES = 4096
MAX_COLLECTION_ERRORS = 24
PROCESS_TERM_GRACE_S = 0.5
COLLECT_EXT = {".stl", ".png", ".md", ".json", ".svg"}
BUILD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
WORK_DIRNAME = "work"
SNAPSHOT_DIRNAME = "artifacts"


class _TailBuffer:
    """Thread-safe-enough single-writer byte tail used by pipe readers."""

    def __init__(self, limit: int):
        self.limit = limit
        self.data = bytearray()

    def append(self, chunk: bytes) -> None:
        self.data.extend(chunk)
        overflow = len(self.data) - self.limit
        if overflow > 0:
            del self.data[:overflow]


def _safe_join(root: str, rel: str) -> str:
    root = os.path.abspath(root)
    path = os.path.abspath(os.path.normpath(os.path.join(root, rel)))
    if os.path.commonpath((root, path)) != root or path == root:
        raise ValueError(f"unsafe path: {rel}")
    return path


def _validate_build_id(build_id: str) -> str:
    if not isinstance(build_id, str) or not BUILD_ID_RE.fullmatch(build_id):
        raise ValueError("bad build id")
    return build_id


def _validate_sources(files: dict[str, str], entry: str) -> list[tuple[str, str, bytes]]:
    if not isinstance(files, dict) or not files:
        raise ValueError("no files provided")
    if len(files) > MAX_SOURCE_FILES:
        raise ValueError(f"too many source files (maximum {MAX_SOURCE_FILES})")
    if entry not in files:
        raise ValueError(f"entry {entry!r} not among provided files")

    validated = []
    normalized_paths: set[str] = set()
    total = 0
    placeholder_root = os.path.join(os.path.abspath(BUILDS_DIR), "source-validation")
    for rel, content in files.items():
        if not isinstance(rel, str) or not isinstance(content, str):
            raise ValueError("source paths and contents must be strings")
        path = _safe_join(placeholder_root, rel)
        normalized = os.path.relpath(path, placeholder_root)
        if rel != normalized or normalized in normalized_paths:
            raise ValueError(f"source path must be normalized and unique: {rel}")
        normalized_paths.add(normalized)
        encoded = content.encode("utf-8")
        total += len(encoded)
        if total > MAX_SOURCE_BYTES:
            raise ValueError(f"source content exceeds {MAX_SOURCE_BYTES} aggregate bytes")
        validated.append((normalized, content, encoded))
    return validated


def _minimal_environment(work_dir: str) -> dict[str, str]:
    temp_dir = os.path.join(work_dir, ".tmp")
    os.makedirs(temp_dir, mode=0o700)
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": work_dir,
        "TMPDIR": temp_dir,
        "MPLCONFIGDIR": temp_dir,
        "MPLBACKEND": "Agg",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "FONTCONFIG_PATH": "/etc/fonts",
        "FONTCONFIG_FILE": "/etc/fonts/fonts.conf",
    }


def _drain_pipe(pipe, target: _TailBuffer) -> None:
    try:
        while True:
            chunk = pipe.read(8192)
            if not chunk:
                break
            target.append(chunk)
    finally:
        pipe.close()


def _signal_process_group(process_group: int, sig: int) -> bool:
    try:
        os.killpg(process_group, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return False


def _process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _terminate_process_group(proc: subprocess.Popen) -> None:
    """Terminate the leader and descendants, including after leader exit."""
    process_group = proc.pid  # start_new_session makes the child its group leader
    if _signal_process_group(process_group, signal.SIGTERM):
        deadline = time.monotonic() + PROCESS_TERM_GRACE_S
        while time.monotonic() < deadline and _process_group_exists(process_group):
            time.sleep(0.02)
        _signal_process_group(process_group, signal.SIGKILL)
    if proc.poll() is None:
        try:
            proc.wait(timeout=PROCESS_TERM_GRACE_S)
        except subprocess.TimeoutExpired:
            _signal_process_group(process_group, signal.SIGKILL)
            proc.wait()


def _format_log(stdout: bytes, stderr: bytes) -> str:
    combined = stdout + b"\n--- stderr ---\n" + stderr
    if len(combined) > MAX_LOG_BYTES:
        combined = combined[-MAX_LOG_BYTES:]
    # Invalid subprocess bytes are omitted so the returned UTF-8 representation
    # cannot grow beyond the configured retained-byte limit.
    return combined.decode("utf-8", errors="ignore")


def _execute(entry: str, work_dir: str, timeout_s: int) -> tuple[int, bool, str]:
    stdout = _TailBuffer(MAX_LOG_BYTES)
    stderr = _TailBuffer(MAX_LOG_BYTES)
    proc = subprocess.Popen(
        [sys.executable, entry],
        cwd=work_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_minimal_environment(work_dir),
        start_new_session=True,
    )
    readers = [
        threading.Thread(target=_drain_pipe, args=(proc.stdout, stdout), daemon=True),
        threading.Thread(target=_drain_pipe, args=(proc.stderr, stderr), daemon=True),
    ]
    timed_out = False
    try:
        for reader in readers:
            reader.start()
        try:
            exit_code = proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_code = -1
    finally:
        # A successful leader can leave children holding pipes or mutating files.
        _terminate_process_group(proc)
        for reader in readers:
            if reader.ident is not None:
                reader.join(timeout=PROCESS_TERM_GRACE_S + 1)
    return exit_code, timed_out, _format_log(bytes(stdout.data), bytes(stderr.data))


def _record_error(errors: list[str], message: str) -> None:
    if len(errors) < MAX_COLLECTION_ERRORS:
        errors.append(message)
    elif len(errors) == MAX_COLLECTION_ERRORS:
        errors.append("additional artifact collection errors omitted")


def _artifact_candidates(work_dir: str, inputs: set[str]) -> tuple[list[str], list[str]]:
    candidates: list[str] = []
    errors: list[str] = []
    pending = [""]
    entries_seen = 0
    while pending:
        rel_dir = pending.pop()
        full_dir = work_dir if not rel_dir else _safe_join(work_dir, rel_dir)
        with os.scandir(full_dir) as entries:
            for entry in entries:
                rel = os.path.normpath(os.path.join(rel_dir, entry.name))
                if rel == ".tmp" or rel.startswith(f".tmp{os.sep}") or entry.name == "__pycache__":
                    continue
                entries_seen += 1
                if entries_seen > MAX_OUTPUT_ENTRIES:
                    _record_error(errors, f"output tree exceeds {MAX_OUTPUT_ENTRIES} entries")
                    return sorted(candidates), errors
                if rel in inputs:
                    continue
                if entry.is_symlink():
                    _record_error(errors, f"rejected symlink artifact: {rel}")
                    continue
                if entry.is_dir(follow_symlinks=False):
                    pending.append(rel)
                    continue
                extension = os.path.splitext(entry.name)[1].lower()
                if extension not in COLLECT_EXT:
                    continue
                if not entry.is_file(follow_symlinks=False):
                    _record_error(errors, f"rejected non-regular artifact: {rel}")
                    continue
                if len(candidates) >= MAX_ARTIFACTS:
                    _record_error(errors, f"artifact count exceeds {MAX_ARTIFACTS}")
                    continue
                candidates.append(rel)
    return sorted(candidates), errors


def _copy_artifact(source: str, destination: str, aggregate_remaining: int) -> tuple[int, str]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        source_fd = os.open(source, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ValueError("source became a symlink") from exc
        raise

    digest = hashlib.sha256()
    copied = 0
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError("source is not a regular file")
        if source_stat.st_size > MAX_ARTIFACT_BYTES:
            raise ValueError(f"file exceeds {MAX_ARTIFACT_BYTES} bytes")
        if source_stat.st_size > aggregate_remaining:
            raise ValueError(f"artifacts exceed {MAX_ARTIFACT_TOTAL_BYTES} aggregate bytes")

        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with os.fdopen(os.dup(source_fd), "rb") as source_file, open(destination, "xb") as output:
            while True:
                chunk = source_file.read(1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > MAX_ARTIFACT_BYTES:
                    raise ValueError(f"file exceeds {MAX_ARTIFACT_BYTES} bytes")
                if copied > aggregate_remaining:
                    raise ValueError(f"artifacts exceed {MAX_ARTIFACT_TOTAL_BYTES} aggregate bytes")
                digest.update(chunk)
                output.write(chunk)
        os.chmod(destination, 0o444)
    except BaseException:
        try:
            os.unlink(destination)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(source_fd)
    return copied, digest.hexdigest()


def _snapshot_artifacts(
    work_dir: str,
    snapshot_dir: str,
    inputs: set[str],
) -> tuple[list[str], dict[str, dict[str, int | str]], list[str]]:
    candidates, errors = _artifact_candidates(work_dir, inputs)
    if os.path.lexists(snapshot_dir):
        if os.path.islink(snapshot_dir) or not os.path.isdir(snapshot_dir):
            os.unlink(snapshot_dir)
        else:
            shutil.rmtree(snapshot_dir)
    os.mkdir(snapshot_dir, mode=0o700)
    artifacts: list[str] = []
    manifest: dict[str, dict[str, int | str]] = {}
    aggregate_size = 0
    for rel in candidates:
        source = _safe_join(work_dir, rel)
        destination = _safe_join(snapshot_dir, rel)
        try:
            size, sha256 = _copy_artifact(
                source,
                destination,
                MAX_ARTIFACT_TOTAL_BYTES - aggregate_size,
            )
        except (OSError, ValueError) as exc:
            _record_error(errors, f"rejected artifact {rel}: {exc}")
            continue
        aggregate_size += size
        artifacts.append(rel)
        manifest[rel] = {"sha256": sha256, "size": size}
    return artifacts, manifest, errors


def run_build(
    files: dict[str, str],
    entry: str,
    timeout_s: int,
    bed: float | Mapping[str, float] | Sequence[float] = DEFAULT_BED,
    build_id: str | None = None,
) -> dict:
    validated_sources = _validate_sources(files, entry)
    if not isinstance(timeout_s, (int, float)) or isinstance(timeout_s, bool) or timeout_s <= 0:
        raise ValueError("timeout_s must be positive")
    printer_volume = normalize_printer_volume(bed)
    build_id = _validate_build_id(build_id) if build_id is not None else uuid.uuid4().hex[:12]
    build_dir = os.path.join(os.path.abspath(BUILDS_DIR), build_id)
    work_dir = os.path.join(build_dir, WORK_DIRNAME)
    snapshot_dir = os.path.join(build_dir, SNAPSHOT_DIRNAME)

    os.makedirs(os.path.abspath(BUILDS_DIR), exist_ok=True)
    try:
        os.mkdir(build_dir, mode=0o700)
    except FileExistsError as exc:
        raise ValueError(f"build id already exists: {build_id}") from exc
    try:
        os.mkdir(work_dir, mode=0o700)
        inputs: set[str] = set()
        for rel, _content, encoded in validated_sources:
            path = _safe_join(work_dir, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "xb") as source_file:
                source_file.write(encoded)
            inputs.add(rel)

        exit_code, timed_out, log = _execute(_safe_join(work_dir, entry), work_dir, timeout_s)
        artifacts, artifact_manifest, collection_errors = _snapshot_artifacts(
            work_dir,
            snapshot_dir,
            inputs,
        )
        stl_reports = {
            rel: check_stl(_safe_join(snapshot_dir, rel), bed=printer_volume)
            for rel in artifacts
            if rel.startswith(f"stl{os.sep}") and rel.lower().endswith(".stl")
        }
        checks_ok = all(report["ok"] for report in stl_reports.values()) if stl_reports else False
        notes = list(collection_errors)
        if not stl_reports:
            notes.append("no stl/*.stl produced; nothing to verify")
        return {
            "build_id": build_id,
            "ok": exit_code == 0 and checks_ok and not collection_errors,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "log": log,
            "artifacts": artifacts,
            "artifact_manifest": artifact_manifest,
            "stl_reports": stl_reports,
            "notes": notes,
        }
    except BaseException:
        shutil.rmtree(build_dir, ignore_errors=True)
        raise


def artifact_path(build_id: str, rel: str) -> str:
    build_id = _validate_build_id(build_id)
    return _safe_join(os.path.join(os.path.abspath(BUILDS_DIR), build_id, SNAPSHOT_DIRNAME), rel)


def cleanup(build_id: str) -> None:
    try:
        build_id = _validate_build_id(build_id)
    except ValueError:
        return
    shutil.rmtree(os.path.join(os.path.abspath(BUILDS_DIR), build_id), ignore_errors=True)
