"""Build the rigid PETG tray: a footprint with press-fit pockets and notches."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import trimesh
from shapely.geometry import Polygon

from . import geometry as geo
from . import mesh3d
from .insert import InsertResult
from .nesting import Layout
from .params import Params


@dataclass
class TrayResult:
    mesh: trimesh.Trimesh
    footprint_2d: Polygon
    pockets_2d: list[Polygon]
    height: float


def build_tray(layout: Layout, inserts: list[InsertResult], p: Params) -> TrayResult:
    """Generate the PETG tray mesh for a nested set of inserts.

    The tray floor is ``tray_floor`` thick; each pocket is the insert outer plus
    ``pocket_clearance`` and is as deep as the corresponding insert is tall. Each
    pocket rim gets a chamfered lead-in and a finger notch aligned outward.
    """
    # Deepest pocket sets the tray height (all pockets share the floor plane).
    pocket_depth = max(ins.height for ins in inserts)
    tray_h = p.tray_floor + pocket_depth

    footprint = layout.footprint
    tray_centroid = np.array([footprint.centroid.x, footprint.centroid.y])

    mesh = mesh3d.extrude(footprint, tray_h)

    pockets_2d: list[Polygon] = []
    cut_meshes: list[trimesh.Trimesh] = []

    for piece, ins in zip(layout.pieces, inserts):
        pocket = piece.placed(ins.outer_2d).buffer(p.pocket_clearance, join_style=1)
        if pocket.geom_type == "MultiPolygon":
            pocket = max(pocket.geoms, key=lambda g: g.area)
        pockets_2d.append(pocket)

        depth = ins.height + 0.02
        cut_meshes.append(
            mesh3d.extrude(pocket, depth, z=tray_h - ins.height)
        )

        # Chamfered lead-in at the pocket rim.
        if p.chamfer > 0:
            top = pocket.buffer(p.chamfer, join_style=1)
            try:
                cham = mesh3d.chamfer_frustum(
                    pocket, tray_h - p.chamfer, top, tray_h + 0.01
                )
                cut_meshes.append(cham)
            except Exception:
                pass

        # Finger notch aligned outward from the tray centre.
        if p.notch_width > 0:
            pc = piece.placed(ins.outer_2d).centroid
            direction = np.array([pc.x, pc.y]) - tray_centroid
            if np.linalg.norm(direction) < 1e-6:
                angle = p.notch_angle_deg if p.notch_angle_deg is not None else -90.0
            else:
                angle = np.degrees(np.arctan2(direction[1], direction[0]))
            notch = geo.notch_polygon(
                pocket, p.notch_width, angle, center=(pc.x, pc.y)
            )
            notch_depth = ins.height * p.notch_depth_frac + 0.02
            cut_meshes.append(
                mesh3d.extrude(notch, notch_depth, z=tray_h - notch_depth + 0.01)
            )

    # Subtract everything in one pass for robustness.
    all_cuts = mesh3d.union(cut_meshes, engine=p.boolean_engine)
    mesh = mesh3d.difference(mesh, all_cuts, engine=p.boolean_engine)
    mesh = mesh3d.make_watertight(mesh)

    return TrayResult(
        mesh=mesh, footprint_2d=footprint, pockets_2d=pockets_2d, height=tray_h
    )
