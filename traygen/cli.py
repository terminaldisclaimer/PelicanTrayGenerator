"""Command-line interface for the glass-carrier tray generator."""

from __future__ import annotations

import argparse
import os
import sys

from . import __version__
from .params import (
    Params,
    add_param_arguments,
    load_config,
    param_overrides_from_args,
)
from .pipeline import (
    build,
    demo_pieces,
    pieces_from_config,
    pieces_from_files,
)


def _pelican(value: str) -> tuple[float, float]:
    parts = value.lower().replace("mm", "").split("x")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("expected WxH, e.g. 330x230")
    return float(parts[0]), float(parts[1])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="traygen",
        description="Generate print-ready PETG tray + TPU crush-rib inserts "
                    "for carrying fragile glass in a Pelican case.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("inputs", nargs="*",
                        help="SVG/DXF outline file(s) of glass pieces")
    parser.add_argument("--demo", action="store_true",
                        help="generate the built-in round 80mm demo piece")
    parser.add_argument("--config", metavar="JSON",
                        help="JSON config with per-piece params (see README)")
    parser.add_argument("--out", default="output", metavar="DIR",
                        help="output directory for STL/PNG artefacts")
    parser.add_argument("--format", default="stl", choices=["stl", "3mf", "obj", "ply"],
                        help="mesh export format")
    parser.add_argument("--height", type=float, default=None,
                        help="glass height (mm) applied to file inputs")
    parser.add_argument("--pelican", type=_pelican, default=None, metavar="WxH",
                        help="Pelican interior size in mm, e.g. 330x230")
    parser.add_argument("--over-lip", action="store_true",
                        help="add small top-retention over-lip bumps")
    parser.add_argument("--version", action="version",
                        version=f"traygen {__version__}")

    add_param_arguments(parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    overrides = param_overrides_from_args(args)

    try:
        if args.config:
            cfg = load_config(args.config)
            base = Params().merged(overrides)
            pieces, params = pieces_from_config(
                cfg, base, config_dir=os.path.dirname(os.path.abspath(args.config))
            )
            # CLI overrides win over the config file.
            params = params.merged(overrides)
            for pc in pieces:
                pc.params = pc.params.merged(overrides)
            if not pieces:
                parser.error("config contained no pieces")
        elif args.demo:
            params = Params().merged(overrides)
            pieces = demo_pieces(params)
        elif args.inputs:
            params = Params().merged(overrides)
            heights = [args.height] * len(args.inputs) if args.height else None
            pieces = pieces_from_files(args.inputs, params, heights=heights)
            if not pieces:
                parser.error("no closed outlines found in the input file(s)")
        else:
            parser.error("provide input file(s), --demo, or --config")
    except (FileNotFoundError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    result = build(pieces, params, args.out, fmt=args.format)

    print(f"Wrote {len(result.insert_paths)} insert(s) + 1 tray to {args.out}/")
    print(f"  tray:    {os.path.basename(result.tray_path)} "
          f"(h={result.tray.height:.1f}mm, watertight={result.tray.mesh.is_watertight})")
    for pc, ins, path in zip(pieces, result.inserts, result.insert_paths):
        print(f"  insert:  {os.path.basename(path)} "
              f"(h={ins.height:.1f}mm, ribs={len(ins.ribs)}, "
              f"watertight={ins.mesh.is_watertight})")
    print(f"  preview: {os.path.basename(result.preview_path)}")
    fx0, fy0, fx1, fy1 = result.tray.footprint_2d.bounds
    print(f"  footprint: {fx1 - fx0:.1f} x {fy1 - fy0:.1f} mm")
    for w in result.warnings:
        print(f"  warning: {w}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
