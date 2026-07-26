"""Unit tests for the deterministic STL preview renderer."""
import os
import tempfile
import unittest

import trimesh

from render import render_views


class TestRenderViews(unittest.TestCase):
    def test_generates_png_for_requested_views(self):
        fd, path = tempfile.mkstemp(suffix=".stl")
        os.close(fd)
        try:
            mesh = trimesh.creation.box(extents=[20, 10, 5])
            mesh.export(path)
            images = render_views([path], ["front", "side"], "preview test")
            self.assertEqual(set(images), {"front", "side"})
            for image in images.values():
                self.assertTrue(image.startswith(b"\x89PNG\r\n\x1a\n"))
        finally:
            os.unlink(path)
