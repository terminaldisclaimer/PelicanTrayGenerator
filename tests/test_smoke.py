"""Smoke tests for the traygen pipeline.

Run with: python -m pytest -q   (or: python tests/test_smoke.py)
"""

from __future__ import annotations

import os
import tempfile

import numpy as np

from traygen import geometry as geo
from traygen.params import Params
from traygen.pipeline import build, demo_pieces
from traygen.vectors import demo_outline


def test_demo_meshes_are_watertight():
    p = Params()
    pieces = demo_pieces(p)
    with tempfile.TemporaryDirectory() as d:
        out = build(pieces, p, d)
        assert out.tray.mesh.is_watertight
        assert all(ins.mesh.is_watertight for ins in out.inserts)
        assert out.warnings == []
        assert os.path.exists(out.tray_path)
        assert os.path.exists(out.preview_path)
        assert len(out.insert_paths) == 1


def test_rib_squeeze_matches_spec():
    """Ribs must protrude rib_proud past the cavity wall (=> ~0.8mm squeeze)."""
    p = Params()
    glass = demo_outline(80, 192)          # radius 40
    cavity = geo.cavity_polygon(glass, p.cavity_clearance)  # radius 40.4
    ribs = geo.place_ribs(cavity, p)
    assert len(ribs) == p.rib_count
    cav_ribs = geo.cavity_with_ribs(cavity, ribs)
    radii = [np.hypot(x, y) for x, y in cav_ribs.exterior.coords]
    crest = min(radii)
    # protrusion past the 40.4mm cavity wall
    assert abs((40.4 - crest) - p.rib_proud) < 0.05
    # squeeze on the 40mm glass edge
    assert abs((40.0 - crest) - (p.rib_proud - p.cavity_clearance)) < 0.05


def test_ribs_avoid_thin_necks():
    """A high rib_min_width must exclude the narrow neck of a teardrop."""
    from shapely.geometry import Point
    from shapely.ops import unary_union

    # body + a thin neck sticking up
    body = Point(0, 0).buffer(20, resolution=64)
    neck = Point(0, 24).buffer(3, resolution=32)
    shape = unary_union([body, neck]).buffer(0)
    p = Params().merged({"rib_count": 4, "rib_min_width": 12.0})
    cavity = geo.cavity_polygon(shape, p.cavity_clearance)
    ribs = geo.place_ribs(cavity, p)
    # No rib should land on the thin neck region (y well above the body).
    assert all(r.wall_pt[1] < 22 for r in ribs)


def test_multi_piece_nesting_fits_pelican():
    p = Params().merged({"pelican_w": 300.0, "pelican_h": 200.0})
    pieces = demo_pieces(p)
    # duplicate the demo piece three times
    pieces = pieces * 3
    with tempfile.TemporaryDirectory() as d:
        out = build(pieces, p, d)
        assert len(out.insert_paths) == 3
        x0, y0, x1, y1 = out.layout.footprint.bounds
        assert x1 - x0 <= p.pelican_w + 1e-6
        assert y1 - y0 <= p.pelican_h + 1e-6


if __name__ == "__main__":
    test_demo_meshes_are_watertight()
    test_rib_squeeze_matches_spec()
    test_ribs_avoid_thin_necks()
    test_multi_piece_nesting_fits_pelican()
    print("all smoke tests passed")
