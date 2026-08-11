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

## Stackable modular trays (`traygen-stack`)

A second generator in this repo: a **size-modular, stackable box system** for a
Pelican case pocket — think *gridfinity, but stackable boxes on a 1.5-inch
grid*. The pocket (default **9 x 6 in**, adjustable) holds a **baseplate** with
one socket per grid cell; every **tray** is an integer number of grid units in
each direction and stacks on the baseplate *or on any other tray*.

With the default 1.5 in unit, the 9 x 6 pocket is a 6 x 4 cell grid, and valid
tray sizes include 9x6, 6x3, 6x1.5, 3x3, 3x1.5, 1.5x1.5 … any `WxL` where both
are multiples of 1.5 in.

```
        side view (stacked)                    tray anatomy
  ┌──────────────────────────┐          ___________________________
  │  ┌─────┐┌─────┐          │         |  ← stacking lip (top rim)  \
  │  │ 3x3 ││ 3x3 │  trays   │         |----------------------------|
  │  └──┬──┘└──┬──┘          │         |  open box (W x L x H)      |
  │  ┌──┴──────┴──────────┐  │         |____________________________|
  │  │       6x3          │  │            \_/    \_/    \_/
  │  └─┬────┬────┬────┬───┘  │          one chamfered foot per cell
  │ ▓▓▓▓▓▓▓▓ baseplate ▓▓▓▓▓ │
  └───── Pelican pocket ─────┘
```

**How stacking works.** Each tray has one chamfered foot per grid cell
underneath and a gridfinity-style lip around its top rim. The lip's inner
profile is identical to a baseplate socket, so the tray above drops in with
0.25 mm of play per side and its flat underside rests on the lip's top ring.
Because feet repeat at grid pitch, smaller trays register onto bigger ones
(e.g. two 3x3s on a 6x3) as long as they share an edge of the tray below. By
default the lip height equals the foot height, so stacked feet end up flush
with the rim below — nothing pokes into the contents.

### Usage

```bash
# Demo set: a full one-layer tiling of the 9x6 pocket
# (6x3 + 9x1.5 + 3x3 + two 3x1.5 + two 1.5x1.5) + the 6x4 baseplate
traygen-stack --out output_stack

# Pick your own sizes (inches; W/L must be multiples of the unit).
# Optional xH = height in inches, optional :N = quantity.
traygen-stack --tray 9x6 --tray 3x3x0.75:2 --tray 3x1.5:4

# Different pocket or grid unit (still inches)
traygen-stack --pocket 12x9 --unit 1.5 --tray 6x6

# Metric mode: all sizes in mm
traygen-stack --mm --pocket 228.6x152.4 --unit 38.1 --tray 76.2x38.1

# Just the baseplate
traygen-stack --baseplate-only
```

Outputs (to `--out`, default `output_stack/`): one `tray_WxL_hH.stl` per
*unique* size (quantities are reported, print multiples), `baseplate_NxM.stl`,
and `stack_layout_preview.png` showing the set packed into the pocket grid.
The build warns if the requested set doesn't fit in one layer.

### Stacking-system parameters

Sizes on the CLI are inches (or mm with `--mm`); fine-fit parameters are
always millimetres.

| Parameter | Flag | Default | Meaning |
|-----------|------|---------|---------|
| unit | `--unit` | 1.5 in | Grid pitch; all tray sizes are multiples of this |
| pocket | `--pocket WxL` | 9x6 in | Pelican pocket interior |
| height | `--height` | 1.5 in | Default tray body height (`xH` in a spec overrides) |
| `tray_gap` | `--tray-gap` | 0.25 | Tray outer inset from the nominal grid, per side |
| `stack_clearance` | `--stack-clearance` | 0.25 | Play per side: foot → lip/socket |
| `wall` | `--wall` | 2.0 | Tray wall thickness |
| `floor` | `--floor` | 2.0 | Tray floor thickness |
| `foot_height` | `--foot-height` | 4.0 | Foot height under the tray |
| `foot_inset` | `--foot-inset` | 3.0 | Foot face inset from the cell edge |
| `foot_chamfer` | `--foot-chamfer` | 2.0 | 45° lead-in at the foot tip |
| `lip_height` | `--lip-height` | 4.0 | Stacking-lip height above the rim |
| `lip_lead` | `--lip-lead` | 0.8 | Flared lead-in at the lip top |
| `plate_floor` | `--plate-floor` | 2.0 | Baseplate floor under the sockets |
| `plate_clearance` | `--plate-clearance` | 0.4 | Baseplate inset from the pocket, per side |

Fit iteration is one number here too: looser stacking → raise
`--stack-clearance`; trays binding side-by-side → raise `--tray-gap`.

**Printing:** PETG or PLA, no supports needed — feet chamfers are 45° and the
lip's inward step is a small 45° under-chamfer. Print trays open-side-up.

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
  stacking/     # stackable modular tray system (traygen-stack)
    params.py   #   grid + fit parameters, tray-spec parsing
    builder.py  #   tray (feet + box + lip) and baseplate meshes
    layout.py   #   first-fit packing into the pocket grid
    preview.py  #   layout PNG
    pipeline.py #   build + export orchestration
    cli.py      #   argparse CLI
examples/
  rounded_plate.svg, oval_neck.dxf, tray_config.json
```
