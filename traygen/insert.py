"""Build the soft TPU crush-rib insert for a single glass piece."""

from __future__ import annotations

from dataclasses import dataclass

import trimesh
from shapely.geometry import Point, Polygon

from . import geometry as geo
from . import mesh3d
from .params import Params


@dataclass
class InsertResult:
    mesh: trimesh.Trimesh
    outer_2d: Polygon        # insert outer wall (for pocket sizing / preview)
    cavity_2d: Polygon       # cavity void with ribs subtracted (preview)
    ribs: list[geo.Rib]
    height: float


def build_insert(glass_outline: Polygon, glass_height: float,
                 p: Params) -> InsertResult:
    """Generate the TPU insert mesh.

    Cross-section (bottom to top): a ``insert_floor`` solid pad, then walls of
    ``insert_wall`` around a cavity that captures ``capture_frac`` of the glass
    height. Crush ribs protrude inward; optional over-lips retain from above; a
    finger notch is cut into the rim.
    """
    cavity = geo.cavity_polygon(glass_outline, p.cavity_clearance)
    ribs = geo.place_ribs(cavity, p)
    cav_ribs = geo.cavity_with_ribs(cavity, ribs, resolution=24)
    outer = cavity.buffer(p.insert_wall, join_style=1)
    if outer.geom_type == "MultiPolygon":
        outer = max(outer.geoms, key=lambda g: g.area)

    capture_h = p.capture_height(glass_height)
    insert_h = p.insert_floor + capture_h

    # Solid body minus the (ribbed) cavity, leaving the floor pad intact.
    solid = mesh3d.extrude(outer, insert_h)
    cavity_cut = mesh3d.extrude(cav_ribs, capture_h + 0.02, z=p.insert_floor)
    mesh = mesh3d.difference(solid, cavity_cut, engine=p.boolean_engine)

    # Finger notch cut into the top of the rim.
    if p.notch_width > 0:
        notch = geo.notch_polygon(outer, p.notch_width, p.notch_angle_deg)
        notch_depth = capture_h * p.notch_depth_frac + 0.02
        notch_cut = mesh3d.extrude(notch, notch_depth, z=insert_h - notch_depth + 0.01)
        mesh = mesh3d.difference(mesh, notch_cut, engine=p.boolean_engine)

    # Optional over-lip bumps: extra material at the very top that overhangs the
    # glass for top retention.
    lip_solids = []
    for rib in ribs:
        if not rib.is_lip:
            continue
        wx, wy = rib.wall_pt
        nx, ny = rib.normal
        # Bump centred so its inner edge protrudes `lip_proud` past the wall.
        cx = wx - nx * (p.lip_bump_r - p.lip_proud)
        cy = wy - ny * (p.lip_bump_r - p.lip_proud)
        lip_poly = Point(cx, cy).buffer(p.lip_bump_r, resolution=24)
        lh = min(p.lip_height, capture_h)
        lip_solids.append(mesh3d.extrude(lip_poly, lh, z=insert_h - lh))
    if lip_solids:
        mesh = mesh3d.union([mesh] + lip_solids, engine=p.boolean_engine)

    mesh = mesh3d.make_watertight(mesh)
    return InsertResult(
        mesh=mesh, outer_2d=outer, cavity_2d=cav_ribs, ribs=ribs, height=insert_h
    )
