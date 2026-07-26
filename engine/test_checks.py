"""Unit tests for checks.py (stdlib unittest — no extra deps).

Run from the repo root:  python3 -m unittest discover -s engine -p 'test_*.py'
"""
import os
import tempfile
import unittest

import numpy as np
import trimesh

from checks import (
    CHECKER_VERSION,
    MAX_COMPONENT_REPORTS,
    OVERHANG_BUDGET_MM2,
    check_stl,
    support_scan,
)


def box_on_bed(extent: float = 20.0) -> trimesh.Trimesh:
    m = trimesh.creation.box(extents=[extent, extent, extent])
    m.apply_translation([extent / 2, extent / 2, extent / 2])
    return m


def write_stl(mesh: trimesh.Trimesh) -> str:
    fd, path = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    mesh.export(path)
    return path


class TestSupportScan(unittest.TestCase):
    def test_plain_box_is_within_heuristic_budget(self):
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
        self.assertEqual(r["checker_version"], CHECKER_VERSION)
        self.assertIn("confidence", r)
        self.assertTrue(r["warnings"])
        self.assertTrue(r["watertight"])
        self.assertTrue(r["bed_fit"])
        self.assertTrue(r["on_bed"])
        self.assertTrue(r["placement"]["xy_placement_ok"])
        self.assertTrue(r["support_scan"]["within_budget"])
        self.assertEqual(r["support_scan"]["assessment"], "within_heuristic_budget")
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

    def test_separate_xyz_printer_volume(self):
        mesh = trimesh.creation.box(extents=[90, 40, 120])
        mesh.apply_translation([45, 20, 60])
        fits = self.check(mesh, bed={"x": 100, "y": 50, "z": 130})
        too_short = self.check(mesh, bed={"x": 100, "y": 50, "z": 100})
        self.assertTrue(fits["bed_fit"])
        self.assertFalse(too_short["placement"]["z_envelope_ok"])
        self.assertFalse(too_short["bed_fit"])

    def test_negative_xy_origin_fails_placement(self):
        mesh = box_on_bed()
        mesh.apply_translation([-1, 0, 0])
        r = self.check(mesh)
        self.assertFalse(r["placement"]["xy_origin_ok"])
        self.assertFalse(r["bed_fit"])
        self.assertFalse(r["ok"])

    def test_xy_envelope_uses_position_not_only_extents(self):
        mesh = box_on_bed(20)
        mesh.apply_translation([170, 0, 0])
        r = self.check(mesh, bed={"x": 180, "y": 180, "z": 180})
        self.assertTrue(r["placement"]["dimensions_fit"])
        self.assertFalse(r["placement"]["xy_envelope_ok"])
        self.assertFalse(r["bed_fit"])

    def test_each_disconnected_component_must_touch_bed(self):
        grounded = box_on_bed(10)
        floating = box_on_bed(10)
        floating.apply_translation([20, 0, 10])
        r = self.check(trimesh.util.concatenate([grounded, floating]))
        self.assertEqual(len(r["components"]), 2)
        self.assertEqual([component["on_bed"] for component in r["components"]], [True, False])
        self.assertFalse(r["on_bed"])
        self.assertFalse(r["ok"])

    def test_component_detail_is_bounded(self):
        components = []
        for index in range(MAX_COMPONENT_REPORTS + 3):
            component = box_on_bed(5)
            component.apply_translation([index * 8, 0, 0])
            components.append(component)
        r = self.check(trimesh.util.concatenate(components))
        self.assertEqual(r["component_count"], MAX_COMPONENT_REPORTS + 3)
        self.assertEqual(len(r["components"]), MAX_COMPONENT_REPORTS)
        self.assertTrue(r["components_truncated"])

    def test_open_mesh_fails_watertight(self):
        box = box_on_bed()
        holed = trimesh.Trimesh(vertices=box.vertices, faces=box.faces[:-1])
        r = self.check(holed)
        self.assertFalse(r["watertight"])
        self.assertFalse(r["ok"])


if __name__ == "__main__":
    unittest.main()
