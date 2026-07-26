"""Conservative mesh and printer-envelope preflight checks.

Geometry and placement checks are deterministic for the loaded mesh. The
overhang check is intentionally reported as a low-confidence heuristic: a
result within its area budget does not determine whether supports are needed.
"""
from collections.abc import Mapping, Sequence
from numbers import Real

import numpy as np
import trimesh

DEFAULT_BED = 180.0          # Bambu A1 mini scalar compatibility
OVERHANG_BUDGET_MM2 = 120.0  # tolerated sloped-overhang area per part
FIRST_LAYER = 0.3            # ignore faces this close to the bed
PLACEMENT_TOLERANCE = 0.01
SIN45 = np.sin(np.pi / 4)
CHECKER_VERSION = "2.0.0"
MAX_COMPONENT_REPORTS = 4
MAX_FLOATING_COMPONENTS = 16


def normalize_printer_volume(
    bed: float | Mapping[str, float] | Sequence[float] = DEFAULT_BED,
) -> dict[str, float]:
    """Return X/Y/Z dimensions while accepting the legacy scalar bed size."""
    if isinstance(bed, Real) and not isinstance(bed, bool):
        values = (float(bed),) * 3
    elif isinstance(bed, Mapping):
        try:
            values = tuple(float(bed[axis]) for axis in ("x", "y", "z"))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("printer volume must contain numeric x, y, and z dimensions") from exc
    elif isinstance(bed, Sequence) and not isinstance(bed, (str, bytes)) and len(bed) == 3:
        try:
            values = tuple(float(value) for value in bed)
        except (TypeError, ValueError) as exc:
            raise ValueError("printer volume dimensions must be numeric") from exc
    else:
        raise ValueError("bed must be a positive scalar or an x/y/z printer volume")

    if not all(np.isfinite(value) and value > 0 for value in values):
        raise ValueError("printer volume dimensions must be finite and positive")
    return dict(zip(("x", "y", "z"), values))


def support_scan(mesh: trimesh.Trimesh) -> dict:
    z0 = float(mesh.bounds[0][2])
    normals, faces = mesh.face_normals, mesh.faces
    centers_z = mesh.vertices[faces].mean(axis=1)[:, 2]
    sloped = (
        (normals[:, 2] < -SIN45)
        & (normals[:, 2] > -0.98)          # near-flat downward faces are bridges
        & (centers_z > z0 + FIRST_LAYER)
    )
    area = float(mesh.area_faces[sloped].sum())
    zs = sorted({round(float(z), 1) for z in centers_z[sloped]})
    within_budget = area <= OVERHANG_BUDGET_MM2
    return {
        "sloped_overhang_mm2": round(area, 1),
        "overhang_z": zs[:24],
        "within_budget": within_budget,
        "assessment": "within_heuristic_budget" if within_budget else "over_heuristic_budget",
        "confidence": "low",
        "warning": "overhang analysis is heuristic and cannot determine whether supports are required",
    }


def _rounded_vector(values) -> list[float]:
    return [round(float(value), 2) for value in values]


def check_stl(
    path: str,
    bed: float | Mapping[str, float] | Sequence[float] = DEFAULT_BED,
) -> dict:
    volume = normalize_printer_volume(bed)
    mesh = trimesh.load(path, force="mesh")
    if not isinstance(mesh, trimesh.Trimesh) or mesh.is_empty:
        raise ValueError("STL does not contain a non-empty mesh")
    if not np.isfinite(mesh.bounds).all():
        raise ValueError("STL contains non-finite geometry")

    bounds = mesh.bounds
    extents = _rounded_vector(mesh.extents)
    dimensions = np.array([volume[axis] for axis in ("x", "y", "z")])
    dimensions_fit = bool(np.all(mesh.extents <= dimensions + PLACEMENT_TOLERANCE))
    xy_origin_ok = bool(np.all(bounds[0, :2] >= -PLACEMENT_TOLERANCE))
    xy_envelope_ok = bool(np.all(bounds[1, :2] <= dimensions[:2] + PLACEMENT_TOLERANCE))
    z_envelope_ok = bool(
        bounds[0, 2] >= -PLACEMENT_TOLERANCE
        and bounds[1, 2] <= dimensions[2] + PLACEMENT_TOLERANCE
    )

    components = list(mesh.split(only_watertight=False))
    if not components:
        components = [mesh]
    component_reports = []
    floating = []
    on_bed = True
    for index, component in enumerate(components):
        component_z_min = float(component.bounds[0, 2])
        component_on_bed = abs(component_z_min) <= PLACEMENT_TOLERANCE
        on_bed = on_bed and component_on_bed
        if not component_on_bed and len(floating) < MAX_FLOATING_COMPONENTS:
            floating.append(index)
        if index < MAX_COMPONENT_REPORTS:
            component_reports.append({
                "component": index,
                "bounds": [_rounded_vector(row) for row in component.bounds],
                "extents": _rounded_vector(component.extents),
                "triangles": int(len(component.faces)),
                "z_min": round(component_z_min, 4),
                "on_bed": component_on_bed,
            })

    bed_fit = dimensions_fit and xy_origin_ok and xy_envelope_ok and z_envelope_ok
    scan = support_scan(mesh)
    watertight = bool(mesh.is_watertight)
    ok = bool(watertight and bed_fit and on_bed and scan["within_budget"])

    warnings = [scan["warning"]]
    if not watertight:
        warnings.append("mesh is not watertight")
    if not dimensions_fit:
        warnings.append("mesh extents exceed the configured printer volume")
    if not xy_origin_ok:
        warnings.append("mesh extends below the X or Y origin")
    if not xy_envelope_ok:
        warnings.append("mesh extends beyond the X or Y printer envelope")
    if not z_envelope_ok:
        warnings.append("mesh extends outside the Z printer envelope")
    if floating:
        suffix = " (sample)" if len(components) > len(component_reports) else ""
        warnings.append(f"components not on the bed{suffix}: {floating}")
    if not scan["within_budget"]:
        warnings.append("sloped overhang area exceeds the heuristic budget")

    return {
        "checker_version": CHECKER_VERSION,
        "confidence": "medium",
        "confidence_details": {
            "mesh_and_placement": "high",
            "overhang": "low",
        },
        "printer_volume": volume,
        "bounds": [_rounded_vector(row) for row in bounds],
        "extents": extents,
        "watertight": watertight,
        "bed_fit": bed_fit,
        "on_bed": on_bed,
        "components": component_reports,
        "component_count": len(components),
        "components_truncated": len(components) > len(component_reports),
        "placement": {
            "dimensions_fit": dimensions_fit,
            "xy_origin_ok": xy_origin_ok,
            "xy_envelope_ok": xy_envelope_ok,
            "xy_placement_ok": xy_origin_ok and xy_envelope_ok,
            "z_envelope_ok": z_envelope_ok,
        },
        "triangles": int(len(mesh.faces)),
        "support_scan": scan,
        "warnings": warnings,
        "ok": ok,
    }
