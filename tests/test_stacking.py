"""Tests for the stackable modular tray system.

Run with: python -m pytest -q tests/test_stacking.py
"""

from __future__ import annotations

import os
import tempfile

import pytest
import trimesh

from traygen.stacking.builder import build_baseplate, build_stack_tray
from traygen.stacking.layout import pack
from traygen.stacking.params import (
    IN,
    StackParams,
    TraySpec,
    demo_specs,
    parse_tray_spec,
)
from traygen.stacking.pipeline import build_stack


def test_grid_math_defaults():
    p = StackParams()
    assert p.unit == pytest.approx(38.1)
    assert p.grid_cells() == (6, 4)          # 9x6in pocket, 1.5in unit
    w, l = p.tray_outer(2, 1)
    assert w == pytest.approx(2 * 38.1 - 0.5)
    assert l == pytest.approx(38.1 - 0.5)
    # foot fits a socket/lip with stack_clearance of play per side
    assert p.socket_size - p.foot_pad_size == pytest.approx(
        2 * p.stack_clearance)


def test_parse_tray_specs():
    p = StackParams()
    s = parse_tray_spec("9x6", p)
    assert (s.gx, s.gy, s.qty) == (6, 4, 1)
    assert s.height == pytest.approx(p.default_height)
    s = parse_tray_spec("3x1.5x0.75:4", p)
    assert (s.gx, s.gy, s.qty) == (2, 1, 4)
    assert s.height == pytest.approx(0.75 * IN)
    s_mm = parse_tray_spec("76.2x38.1x30", p, inches=False)
    assert (s_mm.gx, s_mm.gy) == (2, 1)
    assert s_mm.height == pytest.approx(30.0)
    with pytest.raises(ValueError):
        parse_tray_spec("2x2", p)            # not a multiple of 1.5in
    with pytest.raises(ValueError):
        parse_tray_spec("3x3:0", p)


def test_demo_set_tiles_pocket_exactly():
    p = StackParams()
    specs = demo_specs(p)
    nx, ny = p.grid_cells()
    cells = sum(s.gx * s.gy * s.qty for s in specs)
    assert cells == nx * ny
    layout = pack(specs, p)
    assert layout.unplaced == []
    assert sum(pl.spec.gx * pl.spec.gy for pl in layout.placed) == nx * ny


def _stack_overlap(lower, lower_top: float, upper, dx=0.0, dy=0.0) -> float:
    """Overlap volume when `upper` rests its underside on `lower`'s top ring."""
    p = StackParams()
    m = upper.mesh.copy()
    m.apply_translation([dx, dy, lower_top - p.foot_height])
    inter = trimesh.boolean.intersection([lower.mesh, m], engine="manifold")
    return 0.0 if inter.is_empty else inter.volume


def test_trays_stack_and_register():
    p = StackParams()
    one = build_stack_tray(TraySpec(1, 1, p.default_height), p)
    two = build_stack_tray(TraySpec(2, 1, p.default_height), p)
    assert one.mesh.is_watertight and two.mesh.is_watertight

    # Same footprint stacks without interference.
    assert _stack_overlap(one, one.total_height, one) == pytest.approx(0.0)
    # Mixed sizes: a 1x1 on one cell of a 2x1.
    assert _stack_overlap(two, two.total_height, one,
                          dx=-p.unit / 2) == pytest.approx(0.0)
    # Feet tips end flush with the lower rim (lip_height == foot_height).
    assert p.lip_height == pytest.approx(p.foot_height)


def test_baseplate_registration():
    p = StackParams(pocket_w=3 * IN, pocket_l=3 * IN)  # small 2x2 plate
    plate = build_baseplate(p)
    assert plate.mesh.is_watertight
    assert (plate.nx, plate.ny) == (2, 2)

    one = build_stack_tray(TraySpec(1, 1, p.default_height), p)
    cx = -(plate.nx - 1) / 2 * p.unit
    cy = -(plate.ny - 1) / 2 * p.unit

    def overlap(dx):
        m = one.mesh.copy()
        m.apply_translation([cx + dx, cy, plate.total_height - p.foot_height])
        inter = trimesh.boolean.intersection([plate.mesh, m],
                                             engine="manifold")
        return 0.0 if inter.is_empty else inter.volume

    # Seated on a cell: no interference; past the clearance: collides.
    assert overlap(0.0) == pytest.approx(0.0)
    assert overlap(2 * p.stack_clearance + 0.1) > 0.0


def test_build_stack_writes_artifacts():
    p = StackParams(pocket_w=3 * IN, pocket_l=3 * IN)
    specs = [TraySpec(1, 1, p.default_height, qty=2),
             TraySpec(2, 1, p.default_height)]
    with tempfile.TemporaryDirectory() as d:
        out = build_stack(specs, p, d)
        assert out.warnings == []
        assert len(out.tray_paths) == 2          # deduplicated by size
        assert out.tray_qty == [2, 1]
        assert all(os.path.exists(pth) for pth in out.tray_paths)
        assert os.path.exists(out.baseplate_path)
        assert os.path.exists(out.preview_path)


if __name__ == "__main__":
    test_grid_math_defaults()
    test_parse_tray_specs()
    test_demo_set_tiles_pocket_exactly()
    test_trays_stack_and_register()
    test_baseplate_registration()
    test_build_stack_writes_artifacts()
    print("all stacking tests passed")
