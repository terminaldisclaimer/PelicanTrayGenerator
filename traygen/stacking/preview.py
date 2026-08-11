"""Top-view layout preview (PNG) for the stackable tray system."""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import patches  # noqa: E402

from .layout import GridLayout  # noqa: E402
from .params import IN, StackParams, _fmt  # noqa: E402

_COLORS = ["#4c72b0", "#dd8452", "#55a868", "#c44e52",
           "#8172b3", "#937860", "#da8bc3", "#8c8c8c"]


def render_stack_layout(path: str, layout: GridLayout, p: StackParams,
                        inches: bool = True) -> str:
    """Draw the pocket, baseplate grid and the packed tray footprints."""
    fig, ax = plt.subplots(figsize=(9, 7))
    U = p.unit
    nx, ny = layout.nx, layout.ny
    grid_w, grid_l = nx * U, ny * U
    # Grid centred in the pocket; use the grid's lower-left as the origin.
    px0 = -(p.pocket_w - grid_w) / 2.0
    py0 = -(p.pocket_l - grid_l) / 2.0

    ax.add_patch(patches.Rectangle(
        (px0, py0), p.pocket_w, p.pocket_l, fill=False, color="#333",
        lw=2, ls="--", label="Pelican pocket"))
    pc = p.plate_clearance
    ax.add_patch(patches.Rectangle(
        (px0 + pc, py0 + pc), p.pocket_w - 2 * pc, p.pocket_l - 2 * pc,
        fill=False, color="#777", lw=1.2, label="baseplate"))
    for i in range(nx + 1):
        ax.plot([i * U, i * U], [0, grid_l], color="#bbb", lw=0.6, zorder=0)
    for j in range(ny + 1):
        ax.plot([0, grid_w], [j * U, j * U], color="#bbb", lw=0.6, zorder=0)

    seen: dict[tuple, int] = {}
    for pl in layout.placed:
        s = pl.spec
        key = (s.gx, s.gy, round(s.height, 3))
        if key not in seen:
            seen[key] = len(seen)
        color = _COLORS[seen[key] % len(_COLORS)]
        x = pl.col * U + p.tray_gap
        y = pl.row * U + p.tray_gap
        w = s.gx * U - 2 * p.tray_gap
        l = s.gy * U - 2 * p.tray_gap
        ax.add_patch(patches.FancyBboxPatch(
            (x, y), w, l,
            boxstyle=patches.BoxStyle("Round", pad=0, rounding_size=p.corner_radius),
            facecolor=color, edgecolor="#222", lw=1.2, alpha=0.55))
        scale = IN if inches else 1.0
        suffix = "\"" if inches else ""
        label = (f"{_fmt(s.gx * U / scale)}x{_fmt(s.gy * U / scale)}{suffix}\n"
                 f"h {_fmt(s.height / scale)}{suffix}")
        ax.annotate(label, (x + w / 2, y + l / 2), ha="center", va="center",
                    fontsize=8, color="#111")

    title = "Stackable tray layout"
    if layout.unplaced:
        title += f"  ({len(layout.unplaced)} tray(s) did not fit this layer)"
    ax.set_title(title)
    ax.set_aspect("equal")
    margin = 8.0
    ax.set_xlim(px0 - margin, px0 + p.pocket_w + margin)
    ax.set_ylim(py0 - margin, py0 + p.pocket_l + margin)
    ax.set_xlabel("X (mm)")
    ax.set_ylabel("Y (mm)")
    ax.legend(loc="upper right", fontsize=8)
    fig.savefig(path, dpi=140, bbox_inches="tight")
    plt.close(fig)
    return path
