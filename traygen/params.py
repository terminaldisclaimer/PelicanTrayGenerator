"""Parametric configuration for the glass-carrier tray generator.

Every dimension a test-fit iteration might touch lives here so that changing a
fit is a one-number edit (CLI flag, JSON config, or default). All lengths are
millimetres unless noted.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from dataclasses import dataclass, fields
from typing import Any, Optional


@dataclass
class Params:
    """All tunable parameters for tray + insert generation (mm)."""

    # ---- Glass / demo piece ------------------------------------------------
    glass_dia: float = 80.0          # demo round-piece diameter
    glass_height: float = 4.0        # glass thickness / height (per piece)

    # ---- TPU insert --------------------------------------------------------
    cavity_clearance: float = 0.4    # cavity wall stands off the glass outline
    rib_count: int = 6               # number of crush ribs around a piece
    rib_proud: float = 1.2           # rib protrusion inward past cavity wall
    rib_round: float = 0.8           # extra bump radius -> rounded "speed bump"
    rib_min_width: float = 6.0       # skip ribs where local width is thinner
    insert_wall: float = 3.0         # TPU wall thickness beyond the cavity
    insert_floor: float = 2.0        # solid soft pad under the glass
    capture_frac: float = 0.85       # fraction of glass height captured

    # ---- Optional top-retention over-lip bumps -----------------------------
    over_lip: bool = False           # add small retaining lips on some ribs
    lip_count: int = 3               # how many ribs get an over-lip
    lip_proud: float = 0.6           # lip protrusion inward past the rib crest
    lip_height: float = 1.5          # vertical height of the lip at the top
    lip_round: float = 0.9           # lip bump radius (rounded)

    # ---- PETG tray ---------------------------------------------------------
    pocket_clearance: float = 0.15   # press-fit gap: insert -> tray pocket
    tray_wall: float = 4.0           # wall between / around pockets (min)
    tray_floor: float = 2.0          # tray floor thickness
    chamfer: float = 0.8             # pocket-rim lead-in chamfer (0 disables)

    # ---- Finger notch ------------------------------------------------------
    notch_width: float = 18.0        # finger-notch width
    notch_depth_frac: float = 0.6    # fraction of pocket depth the notch cuts
    notch_angle_deg: Optional[float] = None  # override notch direction (deg)

    # ---- Layout / footprint ------------------------------------------------
    pelican_w: Optional[float] = None   # Pelican interior width  (X)
    pelican_h: Optional[float] = None   # Pelican interior length (Y)
    corner_radius: float = 6.0          # rounded corners of the tray footprint

    # ---- Vector import / meshing ------------------------------------------
    svg_scale: float = 1.0           # multiply imported coords -> mm
    arc_resolution: int = 192        # segments used to flatten curves/circles
    boolean_engine: str = "manifold"  # trimesh boolean backend

    # ------------------------------------------------------------------ utils
    @property
    def bump_r(self) -> float:
        """Radius of a crush-rib bump (rounded profile)."""
        return self.rib_proud + self.rib_round

    @property
    def lip_bump_r(self) -> float:
        return self.lip_proud + self.lip_round

    @property
    def nest_spacing(self) -> float:
        """Minimum gap between neighbouring pockets == tray wall."""
        return self.tray_wall

    def capture_height(self, glass_height: Optional[float] = None) -> float:
        gh = self.glass_height if glass_height is None else glass_height
        return gh * self.capture_frac

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    def merged(self, overrides: dict[str, Any]) -> "Params":
        """Return a copy with the (non-None) overrides applied."""
        data = self.to_dict()
        for k, v in overrides.items():
            if v is None:
                continue
            if k not in data:
                raise KeyError(f"unknown parameter: {k!r}")
            data[k] = v
        return Params(**data)

    # ---------------------------------------------------------- constructors
    @classmethod
    def field_names(cls) -> list[str]:
        return [f.name for f in fields(cls)]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Params":
        known = {f.name for f in fields(cls)}
        unknown = set(data) - known
        if unknown:
            raise KeyError(f"unknown parameter(s): {sorted(unknown)}")
        return cls(**data)


def load_config(path: str) -> dict:
    """Load a JSON config file.

    Schema (all keys optional)::

        {
          "params":  { <global param overrides> },
          "pieces":  [ {"file": "a.svg", "height": 4.0,
                        "params": { <per-piece overrides> }}, ... ],
          "pelican": {"width": 330, "height": 230}
        }
    """
    with open(path) as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- CLI
# Map CLI flag -> Params field. Kept explicit so --help reads well.
_CLI_PARAMS: dict[str, tuple[type, str]] = {
    "glass-dia": (float, "demo round-piece diameter (mm)"),
    "glass-height": (float, "glass thickness / height (mm)"),
    "cavity-clearance": (float, "cavity clearance around the glass (mm)"),
    "rib-count": (int, "number of crush ribs per piece"),
    "rib-proud": (float, "rib protrusion inward past cavity wall (mm)"),
    "rib-round": (float, "extra rib-bump radius for rounded profile (mm)"),
    "rib-min-width": (float, "skip ribs where local width is thinner (mm)"),
    "insert-wall": (float, "TPU insert wall thickness (mm)"),
    "insert-floor": (float, "TPU soft floor pad thickness (mm)"),
    "capture-frac": (float, "fraction of glass height captured (0-1)"),
    "lip-count": (int, "number of ribs that get a top over-lip"),
    "lip-proud": (float, "over-lip protrusion past rib crest (mm)"),
    "lip-height": (float, "over-lip vertical height at the top (mm)"),
    "lip-round": (float, "over-lip bump radius (mm)"),
    "pocket-clearance": (float, "press-fit gap insert->pocket (mm)"),
    "tray-wall": (float, "tray wall between/around pockets (mm)"),
    "tray-floor": (float, "tray floor thickness (mm)"),
    "chamfer": (float, "pocket-rim chamfer, 0 disables (mm)"),
    "notch-width": (float, "finger-notch width (mm)"),
    "notch-depth-frac": (float, "fraction of pocket depth the notch cuts"),
    "notch-angle-deg": (float, "finger-notch direction override (deg)"),
    "corner-radius": (float, "tray footprint corner radius (mm)"),
    "svg-scale": (float, "scale factor applied to imported vectors"),
    "arc-resolution": (int, "segments used to flatten curves/circles"),
}


def add_param_arguments(parser: argparse.ArgumentParser) -> None:
    """Attach one CLI flag per tunable parameter (defaults left as None so we
    can tell 'user set it' from 'use config/default')."""
    group = parser.add_argument_group("parameters (override config / defaults)")
    for flag, (typ, help_text) in _CLI_PARAMS.items():
        group.add_argument(f"--{flag}", type=typ, default=None, help=help_text)


def param_overrides_from_args(args: argparse.Namespace) -> dict[str, Any]:
    """Collect the parameter overrides the user actually set on the CLI."""
    out: dict[str, Any] = {}
    for flag in _CLI_PARAMS:
        field_name = flag.replace("-", "_")
        val = getattr(args, field_name, None)
        if val is not None:
            out[field_name] = val
    # boolean toggles handled separately by the CLI
    if getattr(args, "over_lip", False):
        out["over_lip"] = True
    if getattr(args, "pelican", None):
        out["pelican_w"], out["pelican_h"] = args.pelican
    return out
