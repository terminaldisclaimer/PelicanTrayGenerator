"""Import 2D glass outlines from SVG / DXF into shapely Polygons.

The strategy is deliberately format-agnostic: every entity is flattened into
straight line segments, then :func:`shapely.ops.polygonize` reassembles closed
faces. This handles single closed polylines as well as drawings built from many
disjoint LINE/ARC segments.
"""

from __future__ import annotations

import os
from typing import Iterable

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union


# --------------------------------------------------------------------------- demo
def demo_outline(diameter: float = 80.0, resolution: int = 192) -> Polygon:
    """A round glass piece for ``--demo`` mode."""
    return Point(0.0, 0.0).buffer(diameter / 2.0, resolution=resolution)


# ------------------------------------------------------------------ polygon build
def _polygons_from_segments(
    segments: Iterable[LineString], scale: float
) -> list[Polygon]:
    """Reassemble line segments into closed polygons (largest first)."""
    merged = unary_union(list(segments))
    polys = list(polygonize(merged))
    if not polys:
        raise ValueError("no closed outline could be assembled from the vectors")
    if scale != 1.0:
        polys = [_scale(p, scale) for p in polys]
    # Drop tiny artefacts and keep the largest outlines first.
    polys = [p for p in polys if p.area > 1e-6]
    polys.sort(key=lambda p: p.area, reverse=True)
    return [_clean(p) for p in polys]


def _scale(poly: Polygon, s: float) -> Polygon:
    from shapely.affinity import scale as _sc

    return _sc(poly, xfact=s, yfact=s, origin=(0, 0))


def _clean(poly: Polygon) -> Polygon:
    poly = poly.buffer(0)  # fix self-touching / orientation
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return poly


# --------------------------------------------------------------------------- SVG
def load_svg(path: str, scale: float = 1.0, resolution: int = 192) -> list[Polygon]:
    """Load closed paths from an SVG file as polygons.

    SVG's y-axis points down; we flip it so the preview/mesh use standard maths
    orientation. ``scale`` converts user units to millimetres.
    """
    from svgpathtools import svg2paths

    paths, _attrs = svg2paths(path)
    segments: list[LineString] = []
    samples_per_seg = max(2, resolution // 8)
    for path_obj in paths:
        pts: list[tuple[float, float]] = []
        for seg in path_obj:
            for i in range(samples_per_seg + 1):
                t = i / samples_per_seg
                z = seg.point(t)
                pts.append((z.real, -z.imag))  # flip y
        if len(pts) >= 2:
            segments.append(LineString(pts))
    return _polygons_from_segments(segments, scale)


# --------------------------------------------------------------------------- DXF
def load_dxf(path: str, scale: float = 1.0, resolution: int = 192) -> list[Polygon]:
    """Load closed outlines from a DXF modelspace as polygons.

    Every drawable entity is flattened to line segments then reassembled, so
    polylines, circles, arcs, ellipses and splines all work.
    """
    import ezdxf

    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    segments: list[LineString] = []
    # sagitta controls arc flattening accuracy (mm); tie loosely to resolution.
    sag = max(0.01, 1.0 / max(resolution, 1))

    def _xy(p):
        return (float(p[0]), float(p[1]))

    def _closed(pts, is_closed):
        if is_closed and pts and pts[0] != pts[-1]:
            pts = pts + [pts[0]]
        return pts

    for e in msp:
        dxftype = e.dxftype()
        try:
            if dxftype == "LINE":
                a, b = e.dxf.start, e.dxf.end
                segments.append(LineString([(a.x, a.y), (b.x, b.y)]))
            elif dxftype == "LWPOLYLINE":
                pts = [_xy(v) for v in e.get_points("xy")]
                pts = _closed(pts, bool(e.closed))
                if len(pts) >= 2:
                    segments.append(LineString(pts))
            elif dxftype == "POLYLINE":
                pts = [_xy(v.dxf.location) for v in e.vertices]
                pts = _closed(pts, bool(e.is_closed))
                if len(pts) >= 2:
                    segments.append(LineString(pts))
            elif dxftype in ("CIRCLE", "ARC", "ELLIPSE", "SPLINE"):
                pts = [(v.x, v.y) for v in e.flattening(sag)]
                if len(pts) >= 2:
                    segments.append(LineString(pts))
        except Exception:
            # Skip anything we cannot flatten rather than aborting the import.
            continue

    return _polygons_from_segments(segments, scale)


# ------------------------------------------------------------------------- router
def load_outlines(path: str, scale: float = 1.0, resolution: int = 192) -> list[Polygon]:
    """Load glass outlines from an SVG or DXF file (dispatch by extension)."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".svg":
        return load_svg(path, scale=scale, resolution=resolution)
    if ext == ".dxf":
        return load_dxf(path, scale=scale, resolution=resolution)
    raise ValueError(f"unsupported vector format: {ext!r} (use .svg or .dxf)")
