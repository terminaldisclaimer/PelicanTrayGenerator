"""Stackable, size-modular tray system (gridfinity-style, 1.5-inch grid)."""

from __future__ import annotations

from .params import StackParams, TraySpec, demo_specs, parse_tray_spec  # noqa: F401
from .pipeline import build_stack  # noqa: F401

__all__ = ["StackParams", "TraySpec", "demo_specs", "parse_tray_spec",
           "build_stack"]
