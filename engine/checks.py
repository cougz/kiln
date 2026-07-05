"""Geometry verification — the parametric-cad-stl skill's non-negotiables,
applied to every exported STL:
  - watertight
  - bed fit (extents within the printer bed, part sitting at Z=0)
  - support-free scan (sloped overhangs above the first layer, with a
    small budgeted allowance for horizontal bores; steep-flat ceilings
    count as bridges and are allowed)
"""
import numpy as np
import trimesh

DEFAULT_BED = 180.0          # Bambu A1 mini
OVERHANG_BUDGET_MM2 = 120.0  # tolerated sloped-overhang area per part
FIRST_LAYER = 0.3            # ignore faces this close to the bed
SIN45 = np.sin(np.pi / 4)


def support_scan(mesh: trimesh.Trimesh) -> dict:
    z0 = float(mesh.bounds[0][2])
    normals, faces = mesh.face_normals, mesh.faces
    centers_z = mesh.vertices[faces].mean(axis=1)[:, 2]
    sloped = (
        (normals[:, 2] < -SIN45)
        & (normals[:, 2] > -0.98)          # ≤ -0.98 = flat ceiling → bridge
        & (centers_z > z0 + FIRST_LAYER)
    )
    area = float(mesh.area_faces[sloped].sum())
    zs = sorted({round(float(z), 1) for z in centers_z[sloped]})
    return {
        "sloped_overhang_mm2": round(area, 1),
        "overhang_z": zs[:24],
        "within_budget": area <= OVERHANG_BUDGET_MM2,
    }


def check_stl(path: str, bed: float = DEFAULT_BED) -> dict:
    mesh = trimesh.load(path)
    extents = [round(float(v), 2) for v in mesh.extents]
    z_min = float(mesh.bounds[0][2])
    bed_fit = bool(all(float(e) <= bed for e in mesh.extents))
    on_bed = abs(z_min) < 0.01
    scan = support_scan(mesh)
    ok = bool(mesh.is_watertight and bed_fit and on_bed and scan["within_budget"])
    return {
        "extents": extents,
        "watertight": bool(mesh.is_watertight),
        "bed_fit": bed_fit,
        "on_bed": on_bed,
        "triangles": int(len(mesh.faces)),
        "support_scan": scan,
        "ok": ok,
    }
