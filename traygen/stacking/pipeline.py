"""End-to-end build for the stackable tray system: specs -> STL + preview."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

from .builder import (
    BaseplateResult,
    StackTrayResult,
    build_baseplate,
    build_stack_tray,
)
from .layout import GridLayout, pack
from .params import IN, StackParams, TraySpec, _fmt
from .preview import render_stack_layout


@dataclass
class StackBuildOutput:
    trays: list[StackTrayResult]         # one per unique (size, height)
    tray_paths: list[str]
    tray_qty: list[int]
    baseplate: Optional[BaseplateResult]
    baseplate_path: Optional[str]
    layout: GridLayout
    preview_path: str
    warnings: list[str] = field(default_factory=list)


def _tray_filename(spec: TraySpec, p: StackParams, inches: bool,
                   ext: str) -> str:
    scale = IN if inches else 1.0
    u = "in" if inches else "mm"
    return (f"tray_{_fmt(spec.gx * p.unit / scale)}x"
            f"{_fmt(spec.gy * p.unit / scale)}_h{_fmt(spec.height / scale)}"
            f"{u}.{ext}")


def build_stack(specs: list[TraySpec], p: StackParams, out_dir: str,
                fmt: str = "stl", baseplate: bool = True,
                inches: bool = True) -> StackBuildOutput:
    """Build every unique tray size once, plus the baseplate and a preview."""
    p.validate()
    os.makedirs(out_dir, exist_ok=True)
    ext = fmt.lower().lstrip(".")
    warnings: list[str] = []

    nx, ny = p.grid_cells()
    for s in specs:
        if s.gx > max(nx, ny) or s.gy > max(nx, ny) or \
                min(s.gx, s.gy) > min(nx, ny):
            warnings.append(
                f"tray {s.label(p, inches)} is larger than the "
                f"{nx}x{ny}-cell pocket grid")

    # Deduplicate: same size + height -> one mesh, summed quantity.
    unique: dict[tuple, TraySpec] = {}
    qty: dict[tuple, int] = {}
    for s in specs:
        k = s.key()
        unique.setdefault(k, TraySpec(s.gx, s.gy, s.height))
        qty[k] = qty.get(k, 0) + s.qty

    trays: list[StackTrayResult] = []
    tray_paths: list[str] = []
    tray_qty: list[int] = []
    for k, spec in unique.items():
        res = build_stack_tray(spec, p)
        path = os.path.join(out_dir, _tray_filename(spec, p, inches, ext))
        res.mesh.export(path)
        if not res.mesh.is_watertight:
            warnings.append(f"tray {spec.label(p, inches)} is not watertight")
        trays.append(res)
        tray_paths.append(path)
        tray_qty.append(qty[k])

    plate = None
    plate_path = None
    if baseplate:
        plate = build_baseplate(p)
        plate_path = os.path.join(out_dir, f"baseplate_{plate.nx}x{plate.ny}.{ext}")
        plate.mesh.export(plate_path)
        if not plate.mesh.is_watertight:
            warnings.append("baseplate is not watertight")

    layout = pack(specs, p)
    if layout.unplaced:
        labels = ", ".join(s.label(p, inches) for s in layout.unplaced)
        warnings.append(
            f"{len(layout.unplaced)} tray(s) do not fit in one layer "
            f"(stack them or print a second baseplate): {labels}")

    preview_path = os.path.join(out_dir, "stack_layout_preview.png")
    render_stack_layout(preview_path, layout, p, inches=inches)

    return StackBuildOutput(
        trays=trays, tray_paths=tray_paths, tray_qty=tray_qty,
        baseplate=plate, baseplate_path=plate_path,
        layout=layout, preview_path=preview_path, warnings=warnings,
    )
