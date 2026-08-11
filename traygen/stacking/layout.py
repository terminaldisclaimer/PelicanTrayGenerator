"""Grid packing: place requested trays into the pocket's cell grid.

A simple first-fit-decreasing packer over the pocket's nx x ny occupancy grid.
Used for the layout preview and to warn when a requested set cannot tile the
pocket in one layer.
"""

from __future__ import annotations

from dataclasses import dataclass

from .params import StackParams, TraySpec


@dataclass
class Placement:
    spec: TraySpec
    col: int    # cell column of the tray's lower-left cell
    row: int    # cell row


@dataclass
class GridLayout:
    nx: int
    ny: int
    placed: list[Placement]
    unplaced: list[TraySpec]   # one entry per tray that did not fit


def pack(specs: list[TraySpec], p: StackParams) -> GridLayout:
    """First-fit-decreasing placement of every tray instance into the grid."""
    nx, ny = p.grid_cells()
    occupied = [[False] * nx for _ in range(ny)]

    instances: list[TraySpec] = []
    for s in specs:
        instances.extend(
            [TraySpec(s.gx, s.gy, s.height)] * s.qty)
    instances.sort(key=lambda s: (s.gx * s.gy, min(s.gx, s.gy)), reverse=True)

    def fits(col: int, row: int, gx: int, gy: int) -> bool:
        if col + gx > nx or row + gy > ny:
            return False
        return all(not occupied[r][c]
                   for r in range(row, row + gy)
                   for c in range(col, col + gx))

    def mark(col: int, row: int, gx: int, gy: int) -> None:
        for r in range(row, row + gy):
            for c in range(col, col + gx):
                occupied[r][c] = True

    placed: list[Placement] = []
    unplaced: list[TraySpec] = []
    for inst in instances:
        spot = None
        for rot in ((inst.gx, inst.gy), (inst.gy, inst.gx)):
            for row in range(ny):
                for col in range(nx):
                    if fits(col, row, *rot):
                        spot = (col, row, rot)
                        break
                if spot:
                    break
            if spot:
                break
        if spot is None:
            unplaced.append(inst)
            continue
        col, row, (gx, gy) = spot
        mark(col, row, gx, gy)
        placed.append(Placement(TraySpec(gx, gy, inst.height), col, row))

    return GridLayout(nx=nx, ny=ny, placed=placed, unplaced=unplaced)
