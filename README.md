# traygen — Parametric Glass-Carrier Tray Generator (PETG + TPU)

Generate print-ready **STL / 3MF** files for a two-part glass-carrier system:

- A rigid **PETG tray** with press-fit pockets, and
- Soft **TPU 95A crush-rib inserts** that press into the pockets and gently grip
  fragile glass pieces.

The assembly is designed to travel inside a Pelican case and survive vibration
and inversion: the insert captures 85 % of each glass piece's height, cushions
it on a continuous soft floor pad, and squeezes it with rounded crush ribs
("speed bumps, not fins"). Every fit dimension is a single tunable number so a
test-fit iteration is a one-argument change.

```
┌─────────────── PETG tray ───────────────┐
│  ┌── pocket ──┐   0.15 mm press-fit gap  │
│  │ ┌ TPU insert ┐                        │
│  │ │  ◗ crush rib  ← 0.8 mm squeeze      │
│  │ │ [   glass   ] ← sits on 2 mm pad    │
│  │ └────────────┘                        │
│  └────────────┘                          │
└──────────────────────────────────────────┘
```

## Install

```bash
pip install -r requirements.txt        # or: pip install -e .
```

Core stack: `shapely` (2D), `trimesh` + `manifold3d` (extrusion + watertight
booleans), `numpy`, `matplotlib` (preview), `svgpathtools` / `ezdxf` (vector
import).

## Usage

```bash
# Built-in demo: one round 80 mm x 4 mm piece
python -m traygen --demo --out output

# From your own vector outlines (closed paths), one piece per file
python -m traygen path/to/piece.svg --height 4
python -m traygen a.svg b.dxf --height 5 --out output

# Full control from a JSON config (multiple pieces, per-piece params)
python -m traygen --config examples/tray_config.json --out output

# Tweak any parameter on the CLI (overrides config + defaults)
python -m traygen --demo --rib-count 5 --rib-proud 1.4 --pocket-clearance 0.12
```

After install (`pip install -e .`) the `traygen` command is on your PATH:

```bash
traygen --demo --out output
```

### Outputs (per run, written to `--out`)

| File | Description |
|------|-------------|
| `petg_tray.stl` | The rigid tray with all pockets, chamfers and notches |
| `tpu_insert_<name>.stl` | One soft insert per glass piece |
| `layout_preview.png` | Top-view layout: footprint, pockets, cavities, ribs, notches |

Export format is selectable with `--format {stl,3mf,obj,ply}`. Every mesh is
checked for watertightness before export (warnings are printed if any fail).

## The pipeline

1. **Parse vectors** → shapely polygons. SVG/DXF entities are flattened to line
   segments and reassembled with `shapely.ops.polygonize`, so single closed
   polylines *and* drawings built from many LINE/ARC segments both work.
2. **TPU insert** per piece:
   - Cavity = glass outline offset by `cavity_clearance` (0.4 mm).
   - **Crush ribs**: rounded bumps protruding `rib_proud` (1.2 mm) inward past
     the cavity wall → ≈0.8 mm squeeze. Ribs are placed at *strong* regions of
     the outline (wide, low-curvature) and **avoid thin necks / sharp features**
     via a local width + curvature analysis (`rib_min_width` sets the neck cutoff).
   - Insert wall `insert_wall` (3 mm) beyond the cavity; solid `insert_floor`
     (2 mm) TPU pad under the glass — this is where drop energy arrives.
   - Captures `capture_frac` (85 %) of the glass height (inversion-safe).
   - Optional `--over-lip` bumps on a few ribs for top retention.
   - Finger notch (`notch_width`, ~18 mm) cut into the rim.
3. **PETG tray**:
   - Pocket = insert outer + `pocket_clearance` (0.15 mm) press-fit.
   - Walls between/around pockets ≥ `tray_wall` (4 mm); floor `tray_floor` (2 mm).
   - Matching outward-facing finger notches; `chamfer` (0.5–1 mm) lead-in on
     pocket rims.
   - Pockets nested on a footprint sized to the Pelican interior (`--pelican
     WxH`) or auto-sized to the pieces.
4. **Export** one tray + one insert per piece + a preview PNG. Booleans use the
   `manifold3d` engine for reliably watertight results.

## Parameters

All of these are tunable via CLI flag (`--rib-count`), JSON config, or left at
their default. Lengths are millimetres.

| Parameter | CLI flag | Default | Meaning |
|-----------|----------|---------|---------|
| `glass_dia` | `--glass-dia` | 80.0 | Demo round-piece diameter |
| `glass_height` | `--glass-height` / `--height` | 4.0 | Glass thickness / height |
| `cavity_clearance` | `--cavity-clearance` | 0.4 | Cavity gap around the glass |
| `rib_count` | `--rib-count` | 6 | Crush ribs per piece |
| `rib_proud` | `--rib-proud` | 1.2 | Rib protrusion inward past cavity wall |
| `rib_round` | `--rib-round` | 0.8 | Extra bump radius → rounded profile |
| `rib_min_width` | `--rib-min-width` | 6.0 | Skip ribs where local width is thinner |
| `insert_wall` | `--insert-wall` | 3.0 | TPU wall thickness beyond cavity |
| `insert_floor` | `--insert-floor` | 2.0 | Soft floor pad under the glass |
| `capture_frac` | `--capture-frac` | 0.85 | Fraction of glass height captured |
| `over_lip` | `--over-lip` | off | Add top-retention over-lip bumps |
| `lip_count` | `--lip-count` | 3 | Ribs that get an over-lip |
| `lip_proud` | `--lip-proud` | 0.6 | Over-lip protrusion past rib crest |
| `lip_height` | `--lip-height` | 1.5 | Over-lip vertical height at the top |
| `lip_round` | `--lip-round` | 0.9 | Over-lip bump radius |
| `pocket_clearance` | `--pocket-clearance` | 0.15 | Press-fit gap insert → pocket |
| `tray_wall` | `--tray-wall` | 4.0 | Wall between/around pockets (min) |
| `tray_floor` | `--tray-floor` | 2.0 | Tray floor thickness |
| `chamfer` | `--chamfer` | 0.8 | Pocket-rim lead-in chamfer (0 disables) |
| `notch_width` | `--notch-width` | 18.0 | Finger-notch width |
| `notch_depth_frac` | `--notch-depth-frac` | 0.6 | Fraction of pocket depth the notch cuts |
| `notch_angle_deg` | `--notch-angle-deg` | auto | Override notch direction (deg) |
| `corner_radius` | `--corner-radius` | 6.0 | Tray footprint corner radius |
| `svg_scale` | `--svg-scale` | 1.0 | Scale factor applied to imported vectors |
| `arc_resolution` | `--arc-resolution` | 192 | Segments used to flatten curves |
| Pelican size | `--pelican WxH` | none | Interior footprint, e.g. `330x230` |

### JSON config schema

```jsonc
{
  "params":  { /* global parameter overrides (any field above) */ },
  "pelican": { "width": 330, "height": 230 },
  "pieces": [
    { "name": "round_lens", "demo": true, "diameter": 80, "height": 4.0,
      "params": { "rib_count": 6 } },
    { "name": "plate", "file": "rounded_plate.svg", "height": 5.0,
      "params": { "rib_count": 5 } },
    { "name": "oval",  "file": "oval_neck.dxf", "height": 6.0,
      "params": { "rib_count": 5, "rib_min_width": 10.0 } }
  ]
}
```

Precedence: **CLI flags > per-piece `params` > global `params` > defaults.**
File paths in a config are resolved relative to the config file. See
`examples/tray_config.json`.

## Printing on a Bambu Lab X1C

Two **separate** prints, press-fit assembled — *not* multi-material.

**PETG tray**
- Material: PETG. Orientation: pockets **face-up** (flat floor on the plate).
- Walls: **4+** perimeters. Layer height: **0.12–0.16 mm**.
- Top/bottom: 5+ layers; 20–30 % infill (gyroid).
- The 0.5–1 mm pocket-rim chamfer gives the insert a lead-in for the press-fit.

**TPU 95A inserts**
- Material: TPU 95A. Print from an **external spool holder — not the AMS**
  (soft filament jams the AMS path).
- Speed: **~25–30 mm/s**, low acceleration. Layer height: 0.16–0.20 mm.
- Walls: 2–3 perimeters, 10–15 % infill (or solid floor via the 2 mm pad).
- Retraction: minimal; enable "slow down for overhangs".

**Assembly**
- Press each TPU insert into its tray pocket (0.15 mm interference). If it's
  tight, drop `--pocket-clearance` to 0.1 or nudge `--tray-wall` fit; if loose,
  raise it. Seat the glass so the crush ribs grip and it rests on the floor pad.
- Tune grip with `--rib-proud` (more = firmer squeeze) and `--rib-count`.

## Notes & tips

- **Fit iteration** is one number: `--pocket-clearance` for press-fit, `--rib-proud`
  for glass grip, `--capture-frac` for how much of the glass is held.
- Import units: vectors are assumed to be in millimetres. If your SVG/DXF is in
  another unit, pass `--svg-scale` (e.g. `0.0393701` for a 1000-unit = inch file,
  or `25.4` for inches → mm).
- Complex/organic outlines: crush ribs auto-avoid thin necks — raise
  `--rib-min-width` to be more conservative on delicate shapes.
- All meshes are validated watertight before export; the run prints a warning
  if any part isn't.

## Repository layout

```
traygen/
  params.py     # all tunable parameters, JSON/CLI merge
  vectors.py    # SVG/DXF -> shapely polygons, demo outline
  geometry.py   # cavity, crush-rib placement (width/curvature), finger notch
  mesh3d.py     # extrusion, booleans, chamfer loft, watertight checks
  insert.py     # TPU crush-rib insert builder
  tray.py       # PETG tray builder
  nesting.py    # multi-piece shelf packing into a footprint
  preview.py    # matplotlib layout PNG
  pipeline.py   # end-to-end orchestration + config assembly
  cli.py        # argparse CLI
examples/
  rounded_plate.svg, oval_neck.dxf, tray_config.json
```
