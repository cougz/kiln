"""Isometric preview renders — the skill's front/side pair, flat-shaded,
design orientation. Input: mesh file path(s); output: PNG bytes."""
import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

VIEWS = {"front": (16, -88), "side": (14, -4), "top": (55, -60)}


def render_views(paths: list[str], views: list[str], title: str = "") -> dict[str, bytes]:
    meshes = [trimesh.load(p) for p in paths]
    lo = np.min([m.bounds[0] for m in meshes], axis=0)
    hi = np.max([m.bounds[1] for m in meshes], axis=0)
    out: dict[str, bytes] = {}
    for view in views:
        if view not in VIEWS:
            raise ValueError(f"unknown view {view!r}; options: {sorted(VIEWS)}")
        elev, azim = VIEWS[view]
        fig = plt.figure(figsize=(11, 9))
        ax = fig.add_subplot(111, projection="3d")
        for m in meshes:
            ax.add_collection3d(Poly3DCollection(
                m.vertices[m.faces], facecolor="#9ab8d8",
                edgecolor=(0, 0, 0, 0.12), linewidths=0.07, alpha=0.95))
        ax.set_xlim(lo[0] - 20, hi[0] + 20)
        ax.set_ylim(lo[1] - 20, hi[1] + 20)
        ax.set_zlim(lo[2] - 20, hi[2] + 20)
        ax.set_box_aspect((hi[0] - lo[0] + 40, hi[1] - lo[1] + 40, hi[2] - lo[2] + 40))
        ax.view_init(elev=elev, azim=azim)
        if title:
            ax.set_title(f"{title} — {view.upper()}", weight="bold", fontsize=13)
        ax.set_xlabel("X"); ax.set_ylabel("Y"); ax.set_zlabel("Z")
        buf = io.BytesIO()
        plt.tight_layout()
        plt.savefig(buf, format="png", dpi=120)
        plt.close(fig)
        out[view] = buf.getvalue()
    return out
