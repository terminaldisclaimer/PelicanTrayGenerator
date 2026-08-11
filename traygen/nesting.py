"""Arrange one or more pieces into a tray footprint (simple shelf packing)."""

from __future__ import annotations

from dataclasses import dataclass, field

from shapely.affinity import translate
from shapely.geometry import Polygon, box

from .params import Params


@dataclass
class Piece:
    """A glass piece plus its resolved parameters and nested position."""

    outline: Polygon                 # glass outline, centred at origin
    height: float                    # glass height (mm)
    params: Params                   # per-piece resolved parameters
    name: str = "piece"
    dx: float = 0.0                  # nest translation
    dy: float = 0.0

    def placed(self, poly: Polygon) -> Polygon:
        return translate(poly, xoff=self.dx, yoff=self.dy)


def _centered(poly: Polygon) -> Polygon:
    """Translate a polygon so its centroid sits at the origin."""
    c = poly.centroid
    return translate(poly, xoff=-c.x, yoff=-c.y)


@dataclass
class Layout:
    pieces: list[Piece]
    footprint: Polygon
    pocket_polys: list[Polygon] = field(default_factory=list)


def nest(pieces: list[Piece], p: Params,
         pocket_sizes: list[Polygon]) -> Layout:
    """Shelf-pack pocket bounding boxes with ``tray_wall`` gaps.

    ``pocket_sizes`` are the pocket polygons (insert outer + clearance) centred
    at the origin, one per piece, in the same order.
    """
    margin = p.tray_wall
    spacing = p.nest_spacing
    # Available width: Pelican interior if given, else grow to fit a single row.
    if p.pelican_w:
        max_w = p.pelican_w - 2 * margin
    else:
        max_w = float("inf")

    x = margin
    y = margin
    row_h = 0.0
    placements: list[tuple[float, float]] = []
    for pocket in pocket_sizes:
        minx, miny, maxx, maxy = pocket.bounds
        w, h = maxx - minx, maxy - miny
        if x > margin and x + w > margin + max_w:
            # wrap to a new shelf
            x = margin
            y += row_h + spacing
            row_h = 0.0
        # translate so the pocket's min corner lands at (x, y)
        dx = x - minx
        dy = y - miny
        placements.append((dx, dy))
        x += w + spacing
        row_h = max(row_h, h)

    for piece, (dx, dy) in zip(pieces, placements):
        piece.dx, piece.dy = dx, dy

    placed_pockets = [
        translate(pk, xoff=dx, yoff=dy)
        for pk, (dx, dy) in zip(pocket_sizes, placements)
    ]

    # Footprint: Pelican rectangle, or bounding box of pockets + margin.
    if p.pelican_w and p.pelican_h:
        footprint = box(0, 0, p.pelican_w, p.pelican_h)
        # Center the packed cluster within the Pelican rectangle.
        allminx = min(pk.bounds[0] for pk in placed_pockets)
        allminy = min(pk.bounds[1] for pk in placed_pockets)
        allmaxx = max(pk.bounds[2] for pk in placed_pockets)
        allmaxy = max(pk.bounds[3] for pk in placed_pockets)
        cw, ch = allmaxx - allminx, allmaxy - allminy
        off_x = (p.pelican_w - cw) / 2 - allminx
        off_y = (p.pelican_h - ch) / 2 - allminy
        for piece in pieces:
            piece.dx += off_x
            piece.dy += off_y
        placed_pockets = [translate(pk, xoff=off_x, yoff=off_y)
                          for pk in placed_pockets]
    else:
        allmaxx = max(pk.bounds[2] for pk in placed_pockets)
        allmaxy = max(pk.bounds[3] for pk in placed_pockets)
        footprint = box(0, 0, allmaxx + margin, allmaxy + margin)

    if p.corner_radius > 0:
        r = min(p.corner_radius, min(footprint.bounds[2], footprint.bounds[3]) / 2)
        footprint = footprint.buffer(-r, join_style=1).buffer(r, join_style=1)

    return Layout(pieces=pieces, footprint=footprint, pocket_polys=placed_pockets)


def center_outline(poly: Polygon) -> Polygon:
    return _centered(poly)
