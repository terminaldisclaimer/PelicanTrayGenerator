"""2D geometry: cavity offset, crush-rib placement, finger notch.

The interesting bit is :func:`place_ribs`, which chooses rib locations at
*strong* regions of an arbitrary outline (wide, low-curvature spots) and avoids
thin necks and sharp/delicate features.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from .params import Params


@dataclass
class Rib:
    """A single crush rib placed on the cavity wall."""

    center: tuple[float, float]   # bump circle centre (in cavity-local coords)
    bump_r: float                 # bump radius
    normal: tuple[float, float]   # inward unit normal at the wall
    wall_pt: tuple[float, float]  # the point on the cavity wall
    is_lip: bool = False          # whether this rib also carries an over-lip

    def polygon(self, resolution: int = 24) -> Polygon:
        return Point(self.center).buffer(self.bump_r, resolution=resolution)


# --------------------------------------------------------------------------- cavity
def cavity_polygon(glass_outline: Polygon, clearance: float) -> Polygon:
    """The rib-free cavity: glass outline grown by the clearance."""
    cav = glass_outline.buffer(clearance, join_style=1)
    if cav.geom_type == "MultiPolygon":
        cav = max(cav.geoms, key=lambda g: g.area)
    return orient(cav, sign=1.0)  # CCW: interior on the left of travel


# ---------------------------------------------------------------- boundary sampling
def _resample_ring(poly: Polygon, n: int) -> np.ndarray:
    ext = poly.exterior
    length = ext.length
    return np.array(
        [ext.interpolate(length * i / n).coords[0] for i in range(n)]
    )


def _inward_normals(pts: np.ndarray, poly: Polygon) -> np.ndarray:
    """Unit inward normals at each sampled boundary point."""
    nxt = np.roll(pts, -1, axis=0)
    prv = np.roll(pts, 1, axis=0)
    tang = nxt - prv
    tang /= np.linalg.norm(tang, axis=1, keepdims=True) + 1e-12
    # Left normal of the tangent; for a CCW ring this points inward.
    normals = np.column_stack([-tang[:, 1], tang[:, 0]])
    # Verify against the polygon and flip any that point outward.
    eps = 1e-3
    for i, (p, nvec) in enumerate(zip(pts, normals)):
        if not poly.contains(Point(p + nvec * eps)):
            normals[i] = -nvec
    return normals


def _local_widths(pts: np.ndarray, normals: np.ndarray, poly: Polygon,
                  max_reach: float) -> np.ndarray:
    """How far the shape extends inward from each boundary point.

    Approximated by intersecting an inward ray with the polygon and taking the
    length of the run that starts at the wall. Small values == thin neck.
    """
    widths = np.zeros(len(pts))
    eps = 1e-3
    for i, (p, nvec) in enumerate(zip(pts, normals)):
        start = p + nvec * eps
        end = p + nvec * max_reach
        inter = LineString([start, end]).intersection(poly)
        if inter.is_empty:
            widths[i] = 0.0
        elif inter.geom_type == "LineString":
            widths[i] = inter.length
        else:  # MultiLineString: take the segment nearest the wall
            best = 0.0
            best_d = np.inf
            for g in inter.geoms:
                d = Point(g.coords[0]).distance(Point(p))
                if d < best_d:
                    best_d, best = d, g.length
            widths[i] = best
    return np.clip(widths, 0.0, max_reach)


def _curvature(pts: np.ndarray, window: int) -> np.ndarray:
    """Absolute turning angle over a window (radians). High == sharp feature."""
    nxt = np.roll(pts, -window, axis=0)
    prv = np.roll(pts, window, axis=0)
    v1 = pts - prv
    v2 = nxt - pts
    a1 = np.arctan2(v1[:, 1], v1[:, 0])
    a2 = np.arctan2(v2[:, 1], v2[:, 0])
    d = np.abs(np.arctan2(np.sin(a2 - a1), np.cos(a2 - a1)))
    return d


def place_ribs(cavity: Polygon, p: Params) -> list[Rib]:
    """Choose crush-rib locations at strong regions of the cavity wall.

    Ribs are spread roughly evenly around the perimeter (one per angular bin)
    but snapped to the locally strongest point in each bin, where "strong" means
    wide (not a thin neck) and low-curvature (not a sharp/delicate feature).
    """
    count = max(1, int(p.rib_count))
    n = max(count * 40, 240)
    pts = _resample_ring(cavity, n)
    normals = _inward_normals(pts, cavity)

    minx, miny, maxx, maxy = cavity.bounds
    max_reach = max(maxx - minx, maxy - miny)
    widths = _local_widths(pts, normals, cavity, max_reach)
    window = max(2, n // 60)
    curv = _curvature(pts, window)

    # Strength: reward width, penalise curvature; forbid thin necks.
    w_norm = widths / (widths.max() + 1e-9)
    strength = w_norm * np.exp(-2.5 * curv)
    strength[widths < p.rib_min_width] = -1.0

    # Pick one rib per contiguous perimeter bin (even angular spread).
    bins = np.array_split(np.arange(n), count)
    chosen: list[int] = []
    for b in bins:
        idx = b[int(np.argmax(strength[b]))]
        chosen.append(int(idx))

    # Decide which ribs also carry an over-lip (evenly spaced subset).
    lip_set: set[int] = set()
    if p.over_lip and p.lip_count > 0:
        step = max(1, len(chosen) // p.lip_count)
        lip_set = {ci for ci in range(0, len(chosen), step)}

    ribs: list[Rib] = []
    for k, i in enumerate(chosen):
        p_wall = pts[i]
        nvec = normals[i]
        # Centre the bump outside the wall so its inner edge protrudes
        # `rib_proud` into the cavity (rounded "speed bump").
        center = p_wall - nvec * (p.bump_r - p.rib_proud)
        ribs.append(
            Rib(
                center=(float(center[0]), float(center[1])),
                bump_r=p.bump_r,
                normal=(float(nvec[0]), float(nvec[1])),
                wall_pt=(float(p_wall[0]), float(p_wall[1])),
                is_lip=(k in lip_set),
            )
        )
    return ribs


def ribs_union(ribs: list[Rib], resolution: int = 24) -> Polygon:
    return unary_union([r.polygon(resolution) for r in ribs])


def cavity_with_ribs(cavity: Polygon, ribs: list[Rib],
                     resolution: int = 24) -> Polygon:
    """Cavity void reduced by the crush ribs (ribs remain as solid TPU)."""
    if not ribs:
        return cavity
    return cavity.difference(ribs_union(ribs, resolution))


# --------------------------------------------------------------------------- notch
def notch_polygon(outer: Polygon, width: float,
                  angle_deg: Optional[float],
                  center: Optional[tuple[float, float]] = None) -> Polygon:
    """A finger-notch slot cut from the rim toward the piece centre.

    ``angle_deg`` sets the outward direction of the slot; if ``None`` it points
    from the piece centroid toward its nearest wall along -Y (front).
    """
    cx, cy = center if center is not None else (outer.centroid.x, outer.centroid.y)
    if angle_deg is None:
        angle = -np.pi / 2.0  # point toward the front (-Y)
    else:
        angle = np.radians(angle_deg)
    d = np.array([np.cos(angle), np.sin(angle)])
    perp = np.array([-d[1], d[0]])

    minx, miny, maxx, maxy = outer.bounds
    reach = max(maxx - minx, maxy - miny) + width
    c = np.array([cx, cy])
    # Slot spans from just behind centre out past the rim, `width` wide.
    a = c - d * 2.0
    b = c + d * reach
    corners = [a + perp * width / 2, b + perp * width / 2,
               b - perp * width / 2, a - perp * width / 2]
    return Polygon([tuple(pt) for pt in corners])
