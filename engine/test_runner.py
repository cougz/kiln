"""Unit tests for runner.py (stdlib unittest — no extra deps).

Run from the repo root:  python3 -m unittest discover -s engine -p 'test_*.py'

run_build executes the entry script with the host interpreter, so these
tests need trimesh importable locally (it is in the engine image and on
the dev box).
"""
import os
import shutil
import tempfile
import unittest

import runner

GOOD_SCRIPT = """\
import os
import trimesh

os.makedirs("stl", exist_ok=True)
m = trimesh.creation.box(extents=[10, 10, 10])
m.apply_translation([0, 0, 5])  # sit at Z=0
m.export("stl/cube.stl")
with open("NOTES.md", "w") as f:
    f.write("# test part\\n")
print("built ok")
"""

FAILING_SCRIPT = "raise SystemExit('assertion failed: dimension off target')\n"


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
        self.assertTrue(r["ok"])

    def test_failing_script_fails_build(self):
        r = runner.run_build({"build.py": FAILING_SCRIPT}, "build.py", 60, 180.0)
        self.assertNotEqual(r["exit_code"], 0)
        self.assertFalse(r["ok"])
        self.assertIn("assertion failed", r["log"])

    def test_no_stl_output_is_not_verified(self):
        r = runner.run_build({"build.py": "print('nothing exported')"}, "build.py", 60, 180.0)
        self.assertEqual(r["exit_code"], 0)
        self.assertFalse(r["ok"])
        self.assertTrue(any("no stl" in n for n in r["notes"]))

    def test_timeout_kills_build(self):
        r = runner.run_build({"build.py": "import time; time.sleep(30)"}, "build.py", 1, 180.0)
        self.assertTrue(r["timed_out"])
        self.assertFalse(r["ok"])


class TestArtifactPath(unittest.TestCase):
    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):
            runner.artifact_path("abc123", "../../etc/passwd")

    def test_bad_build_id_rejected(self):
        with self.assertRaises(ValueError):
            runner.artifact_path("../oops", "stl/x.stl")


if __name__ == "__main__":
    unittest.main()
