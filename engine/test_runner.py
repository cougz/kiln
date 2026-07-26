"""Unit tests for runner.py (stdlib unittest — no extra deps).

Run from the repo root:  python3 -m unittest discover -s engine -p 'test_*.py'

run_build executes the entry script with the host interpreter, so these
tests need trimesh importable locally (it is in the engine image and on
the dev box).
"""
import hashlib
import importlib.util
import os
import re
import shutil
import tempfile
import time
import unittest

import runner

GOOD_SCRIPT = """\
import os
import trimesh

os.makedirs("stl", exist_ok=True)
m = trimesh.creation.box(extents=[10, 10, 10])
m.apply_translation([5, 5, 5])  # sit in the positive printer envelope at Z=0
m.export("stl/cube.stl")
with open("NOTES.md", "w") as f:
    f.write("# test part\\n")
print("built ok")
"""

FAILING_SCRIPT = "raise SystemExit('assertion failed: dimension off target')\n"

PARAMETERIZED_SCRIPT = """\
import json
import os
import trimesh

with open("params.json") as f:
    size = json.load(f)["size"]
os.makedirs("stl", exist_ok=True)
m = trimesh.creation.box(extents=[size, size, size])
m.apply_translation([size / 2, size / 2, size / 2])
m.export("stl/parameterized.stl")
"""

CADQUERY_SCRIPT = """\
import cadquery as cq
import os

os.makedirs("stl", exist_ok=True)
part = cq.Workplane("XY").box(10, 12, 4, centered=(False, False, False))
cq.exporters.export(part, "stl/cadquery-box.stl")
"""

SYMLINK_SCRIPT = """\
import os

os.makedirs("stl", exist_ok=True)
os.symlink("../build.py", "stl/not-an-artifact.stl")
"""

DESCENDANT_SCRIPT = """\
import subprocess
import sys
import time

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
print(f"child_pid={child.pid}", flush=True)
time.sleep(30)
"""

COMPLETION_DESCENDANT_SCRIPT = """\
import subprocess
import sys

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
print(f"child_pid={child.pid}", flush=True)
"""


class TestRunBuild(unittest.TestCase):
    def setUp(self):
        self._orig_builds_dir = runner.BUILDS_DIR
        runner.BUILDS_DIR = tempfile.mkdtemp(prefix="kiln-test-builds-")

    def tearDown(self):
        shutil.rmtree(runner.BUILDS_DIR, ignore_errors=True)
        runner.BUILDS_DIR = self._orig_builds_dir

    def test_missing_entry_rejected(self):
        with self.assertRaises(ValueError):
            runner.run_build({"other.py": "pass"}, "build.py", 60, 180.0)

    def test_unsafe_path_rejected(self):
        with self.assertRaises(ValueError):
            runner.run_build({"../evil.py": "pass", "build.py": "pass"}, "build.py", 60, 180.0)

    def test_successful_build_collects_and_verifies(self):
        r = runner.run_build({"build.py": GOOD_SCRIPT}, "build.py", 120, 180.0)
        self.assertEqual(r["exit_code"], 0)
        self.assertIn("stl/cube.stl", r["artifacts"])
        self.assertIn("NOTES.md", r["artifacts"])
        self.assertNotIn("build.py", r["artifacts"])  # inputs are not artifacts
        self.assertIn("built ok", r["log"])
        self.assertTrue(r["stl_reports"]["stl/cube.stl"]["ok"])
        artifact = runner.artifact_path(r["build_id"], "stl/cube.stl")
        with open(artifact, "rb") as artifact_file:
            content = artifact_file.read()
        self.assertEqual(
            r["artifact_manifest"]["stl/cube.stl"],
            {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)},
        )
        self.assertTrue(r["ok"])

    def test_caller_build_id_is_canonical(self):
        r = runner.run_build(
            {"build.py": GOOD_SCRIPT},
            "build.py",
            120,
            180.0,
            build_id="worker-123",
        )
        self.assertEqual(r["build_id"], "worker-123")
        self.assertTrue(os.path.isfile(runner.artifact_path("worker-123", "stl/cube.stl")))

    def test_failing_script_fails_build(self):
        r = runner.run_build({"build.py": FAILING_SCRIPT}, "build.py", 60, 180.0)
        self.assertNotEqual(r["exit_code"], 0)
        self.assertFalse(r["ok"])
        self.assertIn("assertion failed", r["log"])

    def test_build_script_receives_params_json(self):
        r = runner.run_build(
            {"build.py": PARAMETERIZED_SCRIPT, "params.json": '{"size": 12}'},
            "build.py",
            60,
            180.0,
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["stl_reports"]["stl/parameterized.stl"]["extents"], [12.0, 12.0, 12.0])

    @unittest.skipUnless(importlib.util.find_spec("cadquery"), "cadquery is not installed")
    def test_real_cadquery_build(self):
        result = runner.run_build(
            {"build.py": CADQUERY_SCRIPT},
            "build.py",
            120,
            {"x": 180, "y": 180, "z": 180},
        )
        self.assertTrue(result["ok"], result["log"])
        self.assertEqual(result["stl_reports"]["stl/cadquery-box.stl"]["extents"], [10.0, 12.0, 4.0])
        self.assertRegex(
            result["artifact_manifest"]["stl/cadquery-box.stl"]["sha256"],
            r"^[a-f0-9]{64}$",
        )

    def test_no_stl_output_is_not_verified(self):
        r = runner.run_build({"build.py": "print('nothing exported')"}, "build.py", 60, 180.0)
        self.assertEqual(r["exit_code"], 0)
        self.assertFalse(r["ok"])
        self.assertTrue(any("no stl" in n for n in r["notes"]))

    def test_timeout_kills_build(self):
        r = runner.run_build({"build.py": "import time; time.sleep(30)"}, "build.py", 1, 180.0)
        self.assertTrue(r["timed_out"])
        self.assertFalse(r["ok"])

    def test_timeout_log_retention_is_byte_bounded(self):
        script = "import os, time; os.write(1, b'x' * 100000); os.write(2, b'y' * 100000); time.sleep(30)"
        r = runner.run_build({"build.py": script}, "build.py", 1, 180.0)
        self.assertTrue(r["timed_out"])
        self.assertLessEqual(len(r["log"].encode("utf-8")), runner.MAX_LOG_BYTES)
        self.assertIn("y" * 100, r["log"])

    @unittest.skipUnless(os.path.isdir("/proc"), "process-state assertion requires /proc")
    def test_timeout_kills_descendants(self):
        r = runner.run_build({"build.py": DESCENDANT_SCRIPT}, "build.py", 1, 180.0)
        match = re.search(r"child_pid=(\d+)", r["log"])
        self.assertIsNotNone(match)
        child_pid = int(match.group(1))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and self._process_is_live(child_pid):
            time.sleep(0.02)
        self.assertFalse(self._process_is_live(child_pid))

    @unittest.skipUnless(os.path.isdir("/proc"), "process-state assertion requires /proc")
    def test_completion_kills_descendants(self):
        started = time.monotonic()
        r = runner.run_build({"build.py": COMPLETION_DESCENDANT_SCRIPT}, "build.py", 10, 180.0)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(r["exit_code"], 0)
        match = re.search(r"child_pid=(\d+)", r["log"])
        self.assertIsNotNone(match)
        child_pid = int(match.group(1))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and self._process_is_live(child_pid):
            time.sleep(0.02)
        self.assertFalse(self._process_is_live(child_pid))

    def test_symlink_artifact_is_rejected(self):
        r = runner.run_build({"build.py": SYMLINK_SCRIPT}, "build.py", 60, 180.0)
        self.assertFalse(r["ok"])
        self.assertNotIn("stl/not-an-artifact.stl", r["artifacts"])
        self.assertTrue(any("symlink artifact" in note for note in r["notes"]))

    def test_workspace_is_cleaned_when_checking_raises(self):
        script = "import os; os.makedirs('stl'); open('stl/bad.stl', 'wb').write(b'not an stl')"
        with self.assertRaises(Exception):
            runner.run_build(
                {"build.py": script},
                "build.py",
                60,
                180.0,
                build_id="bad-output",
            )
        self.assertFalse(os.path.exists(os.path.join(runner.BUILDS_DIR, "bad-output")))

    @staticmethod
    def _process_is_live(pid):
        try:
            with open(f"/proc/{pid}/stat", encoding="ascii") as process_stat:
                fields = process_stat.read().split()
            return len(fields) > 2 and fields[2] != "Z"
        except FileNotFoundError:
            return False


class TestArtifactPath(unittest.TestCase):
    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):
            runner.artifact_path("abc123", "../../etc/passwd")

    def test_bad_build_id_rejected(self):
        with self.assertRaises(ValueError):
            runner.artifact_path("../oops", "stl/x.stl")


if __name__ == "__main__":
    unittest.main()
