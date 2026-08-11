"""Mesh builders for the stackable modular tray system.

Vertical anatomy of a tray (z up, z=0 at the foot tips)::

        ___________________________          __
       | lead-in flare               \\        | lip_height
       | lip (inner face = socket)   |       __|  <- rim
       |------------------------------|        |
       |  cavity                      |        | body height
       |  floor                       |       __|
       |__[foot]___[foot]___[foot]____|        | foot_height
          \\__/     \\__/     \\__/             __|

    One chamfered foot per grid cell. The lip's inner face sits
    ``stack_clearance`` outside a foot face, so the tray above drops in and
    its flat underside rests on the lip's top ring. With the default
    ``lip_height == foot_height`` the upper tray's foot tips end up flush
    with the lower tray's rim — nothing intrudes into the cavity below.

The baseplate is the same interface flipped into a plate: a socket lattice at
grid pitch, one opening per cell, so trays register inside the Pelican pocket.
"""

from __future__ import annotations

from dataclasses import dataclass

import trimesh
from shapely import affinity
from shapely.geometry import Polygon

from .. import mesh3d
from .params import StackParams, TraySpec

_EPS = 0.01


def rounded_rect(w: float, l: float, r: float,
                 cx: float = 0.0, cy: float = 0.0) -> Polygon:
    """An axis-aligned rounded rectangle centred on (cx, cy)."""
    r = max(0.0, min(r, w / 2.0 - 1e-6, l / 2.0 - 1e-6))
    core = Polygon([
        (cx - w / 2 + r, cy - l / 2 + r), (cx + w / 2 - r, cy - l / 2 + r),
        (cx + w / 2 - r, cy + l / 2 - r), (cx - w / 2 + r, cy + l / 2 - r),
    ])
    if r <= 0:
        return Polygon([
            (cx - w / 2, cy - l / 2), (cx + w / 2, cy - l / 2),
            (cx + w / 2, cy + l / 2), (cx - w / 2, cy + l / 2),
        ])
    return core.buffer(r, join_style=1, quad_segs=16)


def cell_centers(gx: int, gy: int, unit: float) -> list[tuple[float, float]]:
    """Centres of a gx x gy cell grid, relative to the grid centre."""
    x0 = -(gx - 1) * unit / 2.0
    y0 = -(gy - 1) * unit / 2.0
    return [(x0 + i * unit, y0 + j * unit)
            for j in range(gy) for i in range(gx)]


def _lip_cuts(outer: Polygon, inner_wall: Polygon, z_rim: float,
              p: StackParams) -> list[trimesh.Trimesh]:
    """Cutters that carve the stacking lip out of a solid rim extension.

    The lip inner face ends up ``lip_inset`` from the nominal grid edge (the
    same offset as the baseplate sockets), reached from the wall inner face via
    a 45-degree under-chamfer, with a flared lead-in at the very top.
    """
    lip_inner_off = p.lip_inset - p.tray_gap   # from the *actual* outer face
    z_top = z_rim + p.lip_height
    inner_lip = outer.buffer(-lip_inner_off, join_style=1)

    cuts: list[trimesh.Trimesh] = []
    t1 = max(lip_inner_off - p.wall, 0.0)
    if t1 > 1e-6:
        # 45-degree transition from the cavity wall out to the lip face.
        cuts.append(mesh3d.chamfer_frustum(
            inner_wall, z_rim - _EPS, inner_lip, z_rim + t1))
    z_straight = z_rim + t1
    lead = min(p.lip_lead, p.lip_height - t1 - 0.1)
    lead = max(lead, 0.0)
    straight_h = (z_top - lead) - z_straight
    if straight_h > 1e-6:
        cuts.append(mesh3d.extrude(inner_lip, straight_h + _EPS,
                                   z=z_straight - _EPS))
    if lead > 1e-6:
        cuts.append(mesh3d.chamfer_frustum(
            inner_lip, z_top - lead - _EPS,
            inner_lip.buffer(lead, join_style=1), z_top + _EPS))
    return cuts


@dataclass
class StackTrayResult:
    mesh: trimesh.Trimesh
    spec: TraySpec
    outer_2d: Polygon
    total_height: float   # feet + body + lip


def build_stack_tray(spec: TraySpec, p: StackParams) -> StackTrayResult:
    """Build one stackable tray: feet + open box + stacking lip."""
    U = p.unit
    w, l = p.tray_outer(spec.gx, spec.gy)
    z_body = p.foot_height
    z_rim = z_body + spec.height
    z_top = z_rim + p.lip_height

    outer = rounded_rect(w, l, p.corner_radius)
    inner_wall = outer.buffer(-p.wall, join_style=1)

    solids: list[trimesh.Trimesh] = [
        # Body and lip blank in one piece (lip is carved by the cuts below).
        mesh3d.extrude(outer, spec.height + p.lip_height, z=z_body),
    ]

    # One foot per grid cell.
    pad0 = rounded_rect(p.foot_pad_size, p.foot_pad_size, p.foot_corner_radius)
    tip0 = pad0.buffer(-p.foot_chamfer, join_style=1)
    for cx, cy in cell_centers(spec.gx, spec.gy, U):
        pad = affinity.translate(pad0, cx, cy)
        tip = affinity.translate(tip0, cx, cy)
        solids.append(mesh3d.chamfer_frustum(tip, 0.0, pad, p.foot_chamfer))
        solids.append(mesh3d.extrude(
            pad, z_body - p.foot_chamfer + _EPS, z=p.foot_chamfer - _EPS))

    cuts: list[trimesh.Trimesh] = [
        # Cavity: from the floor top to the rim.
        mesh3d.extrude(inner_wall, (z_rim - (z_body + p.floor)) + _EPS,
                       z=z_body + p.floor),
    ]
    cuts.extend(_lip_cuts(outer, inner_wall, z_rim, p))

    solid = mesh3d.union(solids, engine=p.boolean_engine)
    mesh = mesh3d.difference(solid, mesh3d.union(cuts, engine=p.boolean_engine),
                             engine=p.boolean_engine)
    mesh = mesh3d.make_watertight(mesh)
    return StackTrayResult(mesh=mesh, spec=spec, outer_2d=outer,
                           total_height=z_top)


@dataclass
class BaseplateResult:
    mesh: trimesh.Trimesh
    outer_2d: Polygon
    nx: int
    ny: int
    total_height: float


def build_baseplate(p: StackParams) -> BaseplateResult:
    """Build the pocket baseplate: a socket lattice at grid pitch.

    The plate outer follows the pocket (minus ``plate_clearance``); the socket
    grid is centred, one opening per whole cell that fits.
    """
    U = p.unit
    nx, ny = p.grid_cells()
    pw = p.pocket_w - 2.0 * p.plate_clearance
    pl = p.pocket_l - 2.0 * p.plate_clearance
    height = p.plate_floor + p.socket_depth

    outer = rounded_rect(pw, pl, p.plate_corner_radius)
    solid = mesh3d.extrude(outer, height)

    # Socket corners get a slightly larger radius than the foot pads so tray
    # corners never bind.
    s = p.socket_size
    r_s = p.foot_corner_radius + p.stack_clearance
    sock0 = rounded_rect(s, s, r_s)
    cuts: list[trimesh.Trimesh] = []
    for cx, cy in cell_centers(nx, ny, U):
        sock = affinity.translate(sock0, cx, cy)
        cuts.append(mesh3d.extrude(sock, p.socket_depth + _EPS,
                                   z=p.plate_floor))
        if p.lip_lead > 1e-6:
            cuts.append(mesh3d.chamfer_frustum(
                sock, height - p.lip_lead - _EPS,
                sock.buffer(p.lip_lead, join_style=1), height + _EPS))

    mesh = mesh3d.difference(solid, mesh3d.union(cuts, engine=p.boolean_engine),
                             engine=p.boolean_engine)
    mesh = mesh3d.make_watertight(mesh)
    return BaseplateResult(mesh=mesh, outer_2d=outer, nx=nx, ny=ny,
                           total_height=height)
