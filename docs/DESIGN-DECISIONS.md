# Design decisions

Settled decisions carried into the build, and the answers to the questions that
were open at the start. Change these deliberately, not by accident.

## Settled before implementation

| # | Decision |
|---|---|
| 1 | Case cutout is always rectangular. Length, width and depth are entered in the UI. |
| 2 | One SVG per part, the widest top-down silhouette, from a Shaper Origin trace. Real-world units are read from the file. |
| 3 | Per-part depth = part height + about 2 mm, entered next to the part. |
| 4 | Grouping constraints force a set of parts onto one tray even when that packs worse. |
| 5 | A single global pocket clearance (default 2 mm) offsets every outline. No per-part clearance. |
| 6 | Tray footprints snap to a 25 mm grid; the minimum tray is one cell. |
| 7 | Trays are sized to the smallest grid multiple that fits, never rounded up further. |
| 8 | Multiple smaller trays sit side by side within a layer. |
| 9 | The Gridfinity lip and base profile is reused unchanged, re-pitched from 42 mm to 25 mm. |
| 10 | Pockets are straight vertical extrusions of the offset silhouette. No stepped or contoured pockets. |
| 11 | Vertical retention comes from the flat underside of the tray above, and the lid foam on the top layer. |
| 12 | Depth-bucketed rectangle packing, heuristic rather than exact. |
| 13 | Trays over the printer bed are flagged. |
| 14 | PETG tray bodies; compliant liners (foam, felt, or printed TPU inserts). |
| 15 | 3MF and STL export per tray, oriented for the X1C. |
| 16 | Full web interface. No CLI, no manifest files. |
| 17 | Interactive 3D preview with an exploded/stacked toggle. |
| 18 | Free static hosting. |

## Questions that were open, and how they were answered

**1. Wall and floor thickness.** 2 mm walls, 3 mm floor, both editable.

**2. Oversized trays.** Warn and let the user regroup. The packer caps tray size
at `min(cutout footprint, printer bed)`, so an oversized tray only appears when a
forced group cannot fit; the warning names the tray and its size. No dovetail or
pin joints - joint geometry is tolerance-sensitive enough to need test prints of
its own, and this route avoids the problem instead of managing it.

**3. SVG conventions.** Not assumed to be a single closed path. The parser
handles paths (all commands, arcs included), rects, circles, ellipses, polygons
and polylines; nested transforms; and mm, cm, in, pt, pc and unitless documents.
Open subpaths are closed and noted. The largest outline is the silhouette;
outlines inside it are holes, kept as raised islands only when the part's
**Holes** box is ticked, since a pocket normally wants the full silhouette.
Outlines outside it are ignored and reported. Every assumption the parser makes
shows up as a note on the part.

**4. Layer height mismatch.** Shorter trays are padded to the layer height so the
tray above seats flat - but only where a tray above actually rests on them.
Padding a shallow tray with nothing above it would print tens of millimetres of
solid filler to hold up thin air.

**5. Case cutout fit.** Snug, 0.5 mm per side, editable. Grid cells are counted
against `cutout - 2 x fit`.

**6. Finger access.** Thumb notches on tray edges, on. A 9 mm scallop is cut at
the middle of an edge wherever it clears every pocket by 0.5 mm, short sides
tried first, up to two per tray. A tray with no room says so rather than cutting
into a pocket wall. Per-pocket finger scallops were considered and left out: they
add a contour to the pocket wall, which pulls against decision 10, and a pocket
that is 2 mm deeper than its part already leaves a fingertip's worth of room.

**7. Labels.** Not generated. They cost print time on every tray and go stale
whenever the packing changes; the exported `print-notes.txt` lists which parts
are on which tray, which is what you actually need at the printer. Easy to add
later as an option.

**8. Persistence.** A downloadable `.traygen.json` project file is the record,
plus best-effort browser autosave so a refresh does not lose work. Every storage
access is guarded - browser storage is unavailable in some contexts, and the
file export never depends on it.

**9. Multiple cases.** One cutout per project. A second case is a second project
file.

**10. Liner accommodation.** Confirmed: the single global offset covers both
clearance and liner. One number to tune after a test print.

## Where this design departs from Gridfinity, and why

The chamfer profile, its heights and the 0.5 mm cell clearance are Gridfinity's,
unchanged. Three things differ:

**25 mm pitch instead of 42 mm.** 42 mm is too coarse for parts this size - a
60 mm part would land on an 84 mm tray and waste the difference. The profile is a
cross-section, so re-pitching it changes nothing about how it mates.

**Recesses and feet on every cell, not just the perimeter.** A Gridfinity bin has
its lip around the outside only, which is why a small bin slides around on a
large one. Here every cell has a recess on top and a foot underneath, so a tray
registers anywhere on the grid. The ridges between recesses are the same geometry
a Gridfinity baseplate already has between its cells - a wedge that is a knife
edge at the top and 5.9 mm wide at its base, which prints without supports and is
strong in the direction it is loaded.

**No 7 mm Z unit.** Tray height follows the parts: `4.75 + floor + pocket depth`
per layer. Quantising height to 7 mm units would round every tray up by an
average of 3.5 mm for no benefit, since nothing here needs to interchange with
Gridfinity hardware.
