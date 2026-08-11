"""Parametric configuration for the stackable modular tray system.

The system is a size-modular grid ("gridfinity for stackable boxes"): a base
unit (default 1.5 in = 38.1 mm) defines a pitch, the Pelican pocket (default
9 x 6 in) holds a baseplate with one socket per grid cell, and every tray is an
integer number of cells in X and Y. Each tray has one chamfered foot per cell
underneath and a stacking lip on top whose inner profile matches the baseplate
sockets — so any tray registers onto the baseplate or onto any other tray.

All internal lengths are millimetres. The CLI speaks inches by default (the
grid was specified in inches); fine-fit parameters (walls, clearances, foot
geometry) are always millimetres.
"""

from __future__ import annotations

import argparse
import dataclasses
from dataclasses import dataclass, fields
from typing import Any

IN = 25.4  # mm per inch


@dataclass
class StackParams:
    """All tunable parameters for the stackable tray system (mm)."""

    # ---- Grid ----------------------------------------------------------------
    unit: float = 1.5 * IN           # grid pitch (default 1.5 in = 38.1 mm)
    pocket_w: float = 9.0 * IN       # Pelican pocket interior width  (X)
    pocket_l: float = 6.0 * IN       # Pelican pocket interior length (Y)

    # ---- Fits / clearances ---------------------------------------------------
    tray_gap: float = 0.25           # tray outer inset from nominal grid, per side
    stack_clearance: float = 0.25    # gap per side: foot -> lip / socket
    plate_clearance: float = 0.4     # baseplate outer inset from pocket, per side

    # ---- Tray body -----------------------------------------------------------
    wall: float = 2.0                # tray wall thickness
    floor: float = 2.0               # tray floor thickness
    corner_radius: float = 3.5       # tray outer corner radius
    default_height: float = 1.5 * IN  # body height (floor incl.) when unspecified

    # ---- Feet (one per grid cell, registers into sockets / lips) -------------
    foot_height: float = 4.0         # foot height below the tray body
    foot_inset: float = 3.0          # foot face inset from nominal cell edge
    foot_chamfer: float = 2.0        # 45 degree lead-in chamfer at the foot tip
    foot_corner_radius: float = 1.6  # foot pad corner radius

    # ---- Stacking lip (top rim, mirrors the socket profile) ------------------
    lip_height: float = 4.0          # lip rises this far above the tray rim
    lip_lead: float = 0.8            # flared lead-in chamfer at the lip top

    # ---- Baseplate -----------------------------------------------------------
    plate_floor: float = 2.0         # solid floor under the sockets
    plate_corner_radius: float = 6.0  # baseplate outer corner radius
    socket_extra_depth: float = 0.3  # socket deeper than the foot -> tray seats
                                     # on the lattice top, not on foot tips

    # ---- Meshing -------------------------------------------------------------
    boolean_engine: str = "manifold"

    # ------------------------------------------------------------- derived fits
    @property
    def lip_inset(self) -> float:
        """Lip/socket inner face inset from the *nominal* grid edge.

        A foot (inset ``foot_inset``) dropped into a lip or socket then has
        ``stack_clearance`` of play per side.
        """
        return self.foot_inset - self.stack_clearance

    @property
    def socket_depth(self) -> float:
        return self.foot_height + self.socket_extra_depth

    @property
    def foot_pad_size(self) -> float:
        """Foot pad side length (per cell)."""
        return self.unit - 2.0 * self.foot_inset

    @property
    def socket_size(self) -> float:
        """Socket / lip opening side length (per cell)."""
        return self.unit - 2.0 * self.lip_inset

    def tray_outer(self, gx: int, gy: int) -> tuple[float, float]:
        """Actual outer footprint of a gx x gy cell tray."""
        return (gx * self.unit - 2.0 * self.tray_gap,
                gy * self.unit - 2.0 * self.tray_gap)

    def grid_cells(self) -> tuple[int, int]:
        """How many whole grid cells fit in the pocket."""
        return (int(self.pocket_w / self.unit + 1e-6),
                int(self.pocket_l / self.unit + 1e-6))

    def validate(self) -> None:
        if self.unit <= 0:
            raise ValueError("unit must be positive")
        if self.foot_inset <= self.stack_clearance:
            raise ValueError("foot_inset must exceed stack_clearance")
        if self.foot_pad_size <= 2.0 * self.foot_chamfer:
            raise ValueError("foot_chamfer too large for the foot pad")
        if self.tray_gap >= self.foot_inset:
            raise ValueError("tray_gap must be smaller than foot_inset")
        if self.lip_height <= self.lip_lead:
            raise ValueError("lip_height must exceed lip_lead")
        nx, ny = self.grid_cells()
        if nx < 1 or ny < 1:
            raise ValueError("pocket is smaller than one grid unit")

    # ---------------------------------------------------------------- plumbing
    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    def merged(self, overrides: dict[str, Any]) -> "StackParams":
        data = self.to_dict()
        for k, v in overrides.items():
            if v is None:
                continue
            if k not in data:
                raise KeyError(f"unknown parameter: {k!r}")
            data[k] = v
        return StackParams(**data)

    @classmethod
    def field_names(cls) -> list[str]:
        return [f.name for f in fields(cls)]


@dataclass
class TraySpec:
    """One requested tray size: gx x gy grid cells, body height (mm), qty."""

    gx: int
    gy: int
    height: float
    qty: int = 1

    def key(self) -> tuple[int, int, float]:
        return (self.gx, self.gy, round(self.height, 3))

    def label(self, p: StackParams, inches: bool = True) -> str:
        if inches:
            return (f"{_fmt(self.gx * p.unit / IN)}x{_fmt(self.gy * p.unit / IN)}"
                    f" h{_fmt(self.height / IN)}in")
        return (f"{_fmt(self.gx * p.unit)}x{_fmt(self.gy * p.unit)}"
                f" h{_fmt(self.height)}mm")


def _fmt(x: float) -> str:
    """Format a number trimming trailing zeros: 3.0 -> '3', 1.50 -> '1.5'."""
    s = f"{x:.3f}".rstrip("0").rstrip(".")
    return s or "0"


def parse_tray_spec(text: str, p: StackParams, inches: bool = True) -> TraySpec:
    """Parse ``WxL``, ``WxLxH`` or ``WxLxH:QTY`` (sizes in inches or mm).

    W and L must be integer multiples of the grid unit; H is a free height.
    Examples (inches): ``9x6``, ``3x1.5``, ``6x3x2``, ``3x3x1.5:4``.
    """
    scale = IN if inches else 1.0
    qty = 1
    body = text.strip().lower().replace("in", "").replace("mm", "")
    if ":" in body:
        body, qty_s = body.rsplit(":", 1)
        try:
            qty = int(qty_s)
        except ValueError:
            raise ValueError(f"bad quantity in tray spec {text!r}")
        if qty < 1:
            raise ValueError(f"quantity must be >= 1 in {text!r}")
    parts = body.split("x")
    if len(parts) not in (2, 3):
        raise ValueError(
            f"bad tray spec {text!r}: expected WxL, WxLxH or WxLxH:QTY")
    try:
        vals = [float(v) for v in parts]
    except ValueError:
        raise ValueError(f"bad number in tray spec {text!r}")

    dims = []
    for v in vals[:2]:
        cells = v * scale / p.unit
        if abs(cells - round(cells)) > 1e-3 or round(cells) < 1:
            unit_disp = p.unit / scale
            raise ValueError(
                f"tray size {_fmt(v)} in {text!r} is not a positive multiple "
                f"of the grid unit ({_fmt(unit_disp)})")
        dims.append(int(round(cells)))

    height = vals[2] * scale if len(vals) == 3 else p.default_height
    min_h = p.floor + 5.0
    if height < min_h:
        raise ValueError(
            f"tray height in {text!r} is too small (min {_fmt(min_h)} mm)")
    return TraySpec(gx=dims[0], gy=dims[1], height=height, qty=qty)


def demo_specs(p: StackParams) -> list[TraySpec]:
    """A mixed set of tray sizes that exactly tiles the default 6x4 pocket grid:

    6x3 + 9x1.5 + 3x3 + 2 of 3x1.5 + 2 of 1.5x1.5 (inches) = 24 cells.
    Falls back to a single full-pocket tray if the pocket grid is smaller.
    """
    nx, ny = p.grid_cells()
    h = p.default_height
    if nx >= 6 and ny >= 4:
        return [
            TraySpec(4, 2, h),       # 6 x 3
            TraySpec(6, 1, h),       # 9 x 1.5
            TraySpec(2, 2, h),       # 3 x 3
            TraySpec(2, 1, h, qty=2),  # 3 x 1.5
            TraySpec(1, 1, h, qty=2),  # 1.5 x 1.5
        ]
    return [TraySpec(nx, ny, h)]


# ------------------------------------------------------------------------- CLI
# Fine-fit parameters exposed as CLI flags. Always millimetres.
_CLI_PARAMS: dict[str, tuple[type, str]] = {
    "tray-gap": (float, "tray outer inset from nominal grid, per side (mm)"),
    "stack-clearance": (float, "play per side: foot -> lip/socket (mm)"),
    "plate-clearance": (float, "baseplate inset from pocket, per side (mm)"),
    "wall": (float, "tray wall thickness (mm)"),
    "floor": (float, "tray floor thickness (mm)"),
    "corner-radius": (float, "tray outer corner radius (mm)"),
    "foot-height": (float, "foot height under the tray body (mm)"),
    "foot-inset": (float, "foot inset from the nominal cell edge (mm)"),
    "foot-chamfer": (float, "45-degree lead-in chamfer at the foot tip (mm)"),
    "foot-corner-radius": (float, "foot pad corner radius (mm)"),
    "lip-height": (float, "stacking-lip height above the rim (mm)"),
    "lip-lead": (float, "flared lead-in at the lip top (mm)"),
    "plate-floor": (float, "baseplate floor under the sockets (mm)"),
    "plate-corner-radius": (float, "baseplate outer corner radius (mm)"),
    "socket-extra-depth": (float, "socket depth beyond the foot height (mm)"),
}


def add_param_arguments(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("fine-fit parameters (mm, override defaults)")
    for flag, (typ, help_text) in _CLI_PARAMS.items():
        group.add_argument(f"--{flag}", type=typ, default=None, help=help_text)


def param_overrides_from_args(args: argparse.Namespace) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for flag in _CLI_PARAMS:
        field_name = flag.replace("-", "_")
        val = getattr(args, field_name, None)
        if val is not None:
            out[field_name] = val
    return out
