"""End-to-end build: outlines -> inserts -> nested tray -> STL + preview."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

from . import vectors
from .insert import InsertResult, build_insert
from .nesting import Layout, Piece, center_outline, nest
from .params import Params
from .preview import render_layout
from .tray import TrayResult, build_tray


@dataclass
class BuildOutput:
    tray: TrayResult
    inserts: list[InsertResult]
    layout: Layout
    tray_path: str
    insert_paths: list[str]
    preview_path: str
    warnings: list[str]


def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")
    return s or "piece"


def build(pieces: list[Piece], params: Params, out_dir: str,
          fmt: str = "stl") -> BuildOutput:
    """Run the full pipeline for a list of pieces and write all artefacts."""
    os.makedirs(out_dir, exist_ok=True)
    warnings: list[str] = []

    # 1. TPU insert per piece (built centred at the origin).
    inserts = [build_insert(pc.outline, pc.height, pc.params) for pc in pieces]

    # 2. Nest pockets (insert outer + clearance) into the tray footprint.
    pocket_sizes = [
        ins.outer_2d.buffer(params.pocket_clearance, join_style=1)
        for ins in inserts
    ]
    layout = nest(pieces, params, pocket_sizes)

    # Sanity check against the Pelican interior, if provided.
    if params.pelican_w and params.pelican_h:
        fx0, fy0, fx1, fy1 = layout.footprint.bounds
        if fx1 - fx0 > params.pelican_w + 1e-6 or fy1 - fy0 > params.pelican_h + 1e-6:
            warnings.append(
                "layout exceeds the Pelican interior "
                f"({fx1 - fx0:.1f} x {fy1 - fy0:.1f} mm vs "
                f"{params.pelican_w:.1f} x {params.pelican_h:.1f} mm)"
            )

    # 3. PETG tray.
    tray = build_tray(layout, inserts, params)

    # 4. Export meshes.
    ext = fmt.lower().lstrip(".")
    tray_path = os.path.join(out_dir, f"petg_tray.{ext}")
    tray.mesh.export(tray_path)

    insert_paths: list[str] = []
    used: dict[str, int] = {}
    for pc, ins in zip(pieces, inserts):
        base = _slug(pc.name)
        n = used.get(base, 0)
        used[base] = n + 1
        suffix = f"_{n + 1}" if (n or list(p.name for p in pieces).count(pc.name) > 1) else ""
        fname = f"tpu_insert_{base}{suffix}.{ext}"
        path = os.path.join(out_dir, fname)
        ins.mesh.export(path)
        insert_paths.append(path)

        if not ins.mesh.is_watertight:
            warnings.append(f"insert {pc.name!r} is not watertight")
    if not tray.mesh.is_watertight:
        warnings.append("tray mesh is not watertight")

    # 5. Layout preview PNG.
    preview_path = os.path.join(out_dir, "layout_preview.png")
    render_layout(preview_path, layout, tray, inserts)

    return BuildOutput(
        tray=tray, inserts=inserts, layout=layout,
        tray_path=tray_path, insert_paths=insert_paths,
        preview_path=preview_path, warnings=warnings,
    )


# --------------------------------------------------------------- piece assembly
def demo_pieces(params: Params) -> list[Piece]:
    outline = vectors.demo_outline(params.glass_dia, params.arc_resolution)
    return [Piece(outline=center_outline(outline),
                  height=params.glass_height, params=params, name="demo")]


def pieces_from_files(paths: list[str], params: Params,
                      heights: Optional[list[float]] = None) -> list[Piece]:
    """Build pieces from a list of SVG/DXF files (each file may hold >1 outline)."""
    pieces: list[Piece] = []
    for i, path in enumerate(paths):
        outlines = vectors.load_outlines(
            path, scale=params.svg_scale, resolution=params.arc_resolution
        )
        base = os.path.splitext(os.path.basename(path))[0]
        h = params.glass_height
        if heights and i < len(heights) and heights[i] is not None:
            h = heights[i]
        for j, outline in enumerate(outlines):
            name = base if len(outlines) == 1 else f"{base}_{j + 1}"
            pieces.append(Piece(outline=center_outline(outline),
                                height=h, params=params, name=name))
    return pieces


def pieces_from_config(cfg: dict, base_params: Params,
                       config_dir: str = ".") -> tuple[list[Piece], Params]:
    """Build pieces from a JSON config dict; returns (pieces, global params)."""
    global_params = base_params
    if "params" in cfg:
        global_params = base_params.merged(cfg["params"])
    if "pelican" in cfg:
        pel = cfg["pelican"]
        global_params = global_params.merged({
            "pelican_w": pel.get("width"),
            "pelican_h": pel.get("height"),
        })

    pieces: list[Piece] = []
    for entry in cfg.get("pieces", []):
        piece_params = global_params
        if "params" in entry:
            piece_params = global_params.merged(entry["params"])
        height = entry.get("height", piece_params.glass_height)

        if "file" in entry:
            path = entry["file"]
            if not os.path.isabs(path):
                path = os.path.join(config_dir, path)
            outlines = vectors.load_outlines(
                path, scale=piece_params.svg_scale,
                resolution=piece_params.arc_resolution,
            )
            base = entry.get("name", os.path.splitext(os.path.basename(path))[0])
            for j, outline in enumerate(outlines):
                name = base if len(outlines) == 1 else f"{base}_{j + 1}"
                pieces.append(Piece(outline=center_outline(outline),
                                    height=height, params=piece_params, name=name))
        elif entry.get("demo") or "diameter" in entry:
            dia = entry.get("diameter", piece_params.glass_dia)
            outline = vectors.demo_outline(dia, piece_params.arc_resolution)
            name = entry.get("name", "demo")
            pieces.append(Piece(outline=center_outline(outline),
                                height=height, params=piece_params, name=name))
    return pieces, global_params
