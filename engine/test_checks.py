"""Unit tests for checks.py (stdlib unittest — no extra deps).

Run from the repo root:  python3 -m unittest discover -s engine -p 'test_*.py'
"""
import os
import tempfile
import unittest

import numpy as np
import trimesh

from checks import check_stl, support_scan, OVERHANG_BUDGET_MM2


def box_on_bed(extent: float = 20.0) -> trimesh.Trimesh:
    m = trimesh.creation.box(extents=[extent, extent, extent])
    m.apply_translation([0, 0, extent / 2])  # sit at Z=0
    return m


def write_stl(mesh: trimesh.Trimesh) -> str:
    fd, path = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    mesh.export(path)
    return path


class TestSupportScan(unittest.TestCase):
    def test_plain_box_is_support_free(self):
        scan = support_scan(box_on_bed())
        self.assertEqual(scan["sloped_overhang_mm2"], 0.0)
        self.assertTrue(scan["within_budget"])

    def test_inverted_pyramid_is_flagged(self):
        # Apex on the bed, 60x60 base 20mm up: side faces overhang at
        # ~34 degrees from horizontal (normal z ~= -0.83) — well past the
        # 45-degree rule but not steep enough to count as a bridge ceiling.
        pts = np.array([
            [0, 0, 0],
            [30, 30, 20], [30, -30, 20], [-30, 30, 20], [-30, -30, 20],
        ])
        pyramid = trimesh.convex.convex_hull(pts)
        scan = support_scan(pyramid)
        self.assertGreater(scan["sloped_overhang_mm2"], OVERHANG_BUDGET_MM2)
        self.assertFalse(scan["within_budget"])

    def test_flat_ceiling_counts_as_bridge(self):
        # A box top face is z-up; its bottom is on the first layer. A box
        # floating above the bed exposes a flat ceiling (normal (0,0,-1)),
        # which the scan must treat as a bridge, not a sloped overhang.
        m = trimesh.creation.box(extents=[20, 20, 5])
        m.apply_translation([0, 0, 10])
        scan = support_scan(m)
        self.assertEqual(scan["sloped_overhang_mm2"], 0.0)


class TestCheckStl(unittest.TestCase):
    def check(self, mesh, bed=180.0):
        path = write_stl(mesh)
        try:
            return check_stl(path, bed=bed)
        finally:
            os.unlink(path)

    def test_good_part_verifies(self):
        r = self.check(box_on_bed())
        self.assertTrue(r["watertight"])
        self.assertTrue(r["bed_fit"])
        self.assertTrue(r["on_bed"])
        self.assertTrue(r["support_scan"]["within_budget"])
        self.assertTrue(r["ok"])

    def test_floating_part_fails_on_bed(self):
        m = box_on_bed()
        m.apply_translation([0, 0, 5])
        r = self.check(m)
        self.assertFalse(r["on_bed"])
        self.assertFalse(r["ok"])

    def test_oversized_part_fails_bed_fit(self):
        r = self.check(box_on_bed(200.0))
        self.assertFalse(r["bed_fit"])
        self.assertFalse(r["ok"])

    def test_part_larger_than_custom_bed(self):
        r = self.check(box_on_bed(100.0), bed=80.0)
        self.assertFalse(r["bed_fit"])

    def test_open_mesh_fails_watertight(self):
        box = box_on_bed()
        holed = trimesh.Trimesh(vertices=box.vertices, faces=box.faces[:-1])
        r = self.check(holed)
        self.assertFalse(r["watertight"])
        self.assertFalse(r["ok"])


if __name__ == "__main__":
    unittest.main()
