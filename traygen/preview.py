"""Top-view matplotlib layout preview (PNG) for a generated tray."""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from . import geometry as geo  # noqa: E402
from .insert import InsertResult  # noqa: E402
from .nesting import Layout  # noqa: E402
from .tray import TrayResult  # noqa: E402


def _draw(ax, poly, **kw):
    if poly is None or poly.is_empty:
        return
    if poly.geom_type == "Polygon":
        ax.plot(*poly.exterior.xy, **kw)
        kw2 = dict(kw)
        kw2.pop("label", None)
        for ring in poly.interiors:
            ax.plot(*ring.xy, **kw2)
    else:
        first = True
        for g in poly.geoms:
            kw2 = dict(kw)
            if not first:
                kw2.pop("label", None)
            _draw(ax, g, **kw2)
            first = False


def render_layout(path: str, layout: Layout, tray: TrayResult,
                  inserts: list[InsertResult]) -> str:
    """Draw footprint, pockets, insert walls, cavities+ribs and glass outlines."""
    fig, ax = plt.subplots(figsize=(8, 8))

    _draw(ax, tray.footprint_2d, color="#444", lw=2, label="PETG tray footprint")

    tray_c = (tray.footprint_2d.centroid.x, tray.footprint_2d.centroid.y)
    labeled = {"pocket": False, "outer": False, "cavity": False,
               "glass": False, "notch": False}
    for piece, ins in zip(layout.pieces, inserts):
        p = piece.params
        outer = piece.placed(ins.outer_2d)
        pocket = outer.buffer(p.pocket_clearance)
        cavity = piece.placed(ins.cavity_2d)
        glass = piece.placed(piece.outline)

        _draw(ax, pocket, color="#2a7", lw=1.2, ls="--",
              label=None if labeled["pocket"] else "tray pocket")
        _draw(ax, outer, color="#07c", lw=1.8,
              label=None if labeled["outer"] else "TPU insert outer")
        _draw(ax, cavity, color="#d33", lw=1.8,
              label=None if labeled["cavity"] else "TPU cavity + crush ribs")
        _draw(ax, glass, color="#999", lw=1.0, ls=":",
              label=None if labeled["glass"] else "glass piece")

        if p.notch_width > 0:
            pc = outer.centroid
            dx, dy = pc.x - tray_c[0], pc.y - tray_c[1]
            if abs(dx) < 1e-6 and abs(dy) < 1e-6:
                angle = p.notch_angle_deg
            else:
                import numpy as np
                angle = np.degrees(np.arctan2(dy, dx))
            notch = geo.notch_polygon(pocket, p.notch_width, angle,
                                      center=(pc.x, pc.y)).intersection(pocket)
            _draw(ax, notch, color="#a5a", lw=1.4,
                  label=None if labeled["notch"] else "finger notch")

        for k in labeled:
            labeled[k] = True

    ax.set_aspect("equal")
    ax.legend(loc="upper right", fontsize=8)
    ax.set_title("Top view: glass-carrier tray layout (mm)")
    ax.set_xlabel("X (mm)")
    ax.set_ylabel("Y (mm)")
    ax.grid(True, ls=":", alpha=0.3)
    fig.savefig(path, dpi=140, bbox_inches="tight")
    plt.close(fig)
    return path
