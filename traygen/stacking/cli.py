"""CLI for the stackable modular tray system (``traygen-stack``)."""

from __future__ import annotations

import argparse
import os
import sys

from .. import __version__
from .params import (
    IN,
    StackParams,
    _fmt,
    add_param_arguments,
    demo_specs,
    param_overrides_from_args,
    parse_tray_spec,
)
from .pipeline import build_stack


def _size(value: str) -> tuple[float, float]:
    parts = value.lower().replace("in", "").replace("mm", "").split("x")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("expected WxL, e.g. 9x6")
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        raise argparse.ArgumentTypeError(f"bad size: {value!r}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="traygen-stack",
        description="Generate a stackable, size-modular tray system for a "
                    "Pelican case pocket — like gridfinity, but stackable "
                    "boxes on a 1.5-inch grid. Sizes are inches by default.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        epilog="examples:\n"
               "  traygen-stack                              # demo set, 9x6 pocket\n"
               "  traygen-stack --tray 9x6 --tray 3x3:2      # one 9x6 + two 3x3\n"
               "  traygen-stack --tray 6x3x2 --tray 3x1.5:4  # 2in-tall 6x3, four 3x1.5\n"
               "  traygen-stack --pocket 12x9 --unit 1.5     # bigger pocket, same grid\n",
    )
    parser.add_argument("--tray", action="append", default=[], metavar="WxL[xH][:QTY]",
                        help="add a tray size (inches; W/L must be multiples of "
                             "the unit; H free, default --height). Repeatable.")
    parser.add_argument("--pocket", type=_size, default=(9.0, 6.0), metavar="WxL",
                        help="Pelican pocket interior size (inches)")
    parser.add_argument("--unit", type=float, default=1.5,
                        help="grid unit / pitch (inches)")
    parser.add_argument("--height", type=float, default=1.5,
                        help="default tray body height (inches)")
    parser.add_argument("--mm", action="store_true",
                        help="interpret --tray/--pocket/--unit/--height in mm")
    parser.add_argument("--no-baseplate", action="store_true",
                        help="skip generating the pocket baseplate")
    parser.add_argument("--baseplate-only", action="store_true",
                        help="generate only the baseplate")
    parser.add_argument("--out", default="output_stack", metavar="DIR",
                        help="output directory for STL/PNG artefacts")
    parser.add_argument("--format", default="stl",
                        choices=["stl", "3mf", "obj", "ply"],
                        help="mesh export format")
    parser.add_argument("--version", action="version",
                        version=f"traygen {__version__}")
    add_param_arguments(parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    inches = not args.mm
    scale = IN if inches else 1.0

    params = StackParams(
        unit=args.unit * scale,
        pocket_w=args.pocket[0] * scale,
        pocket_l=args.pocket[1] * scale,
        default_height=args.height * scale,
    ).merged(param_overrides_from_args(args))

    try:
        params.validate()
        if args.baseplate_only:
            specs = []
        elif args.tray:
            specs = [parse_tray_spec(t, params, inches=inches)
                     for t in args.tray]
        else:
            specs = demo_specs(params)
            print("no --tray given; generating the demo set "
                  "(a full one-layer tiling of the pocket)")
        out = build_stack(specs, params, args.out, fmt=args.format,
                          baseplate=not args.no_baseplate, inches=inches)
    except (ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    nx, ny = params.grid_cells()
    unit_disp = _fmt(params.unit / scale)
    u = "in" if inches else "mm"
    print(f"Grid: {nx}x{ny} cells of {unit_disp}{u} in a "
          f"{_fmt(params.pocket_w / scale)}x{_fmt(params.pocket_l / scale)}{u} pocket")
    for res, path, q in zip(out.trays, out.tray_paths, out.tray_qty):
        qs = f"  x{q}" if q > 1 else ""
        print(f"  tray:      {os.path.basename(path)}{qs} "
              f"({res.spec.gx}x{res.spec.gy} cells, "
              f"total h={res.total_height:.1f}mm, "
              f"watertight={res.mesh.is_watertight})")
    if out.baseplate_path:
        print(f"  baseplate: {os.path.basename(out.baseplate_path)} "
              f"({out.baseplate.nx}x{out.baseplate.ny} sockets, "
              f"h={out.baseplate.total_height:.1f}mm, "
              f"watertight={out.baseplate.mesh.is_watertight})")
    print(f"  preview:   {os.path.basename(out.preview_path)}")
    for w in out.warnings:
        print(f"  warning: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
