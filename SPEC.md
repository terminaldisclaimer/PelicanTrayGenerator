# SPEC — STL Cutout Tray Generator (web app)

Status: **APPROVED** (2026-11-22). Remaining TBD: case interior size (entered in the app's Settings; presets offered).

## 1. Concept

Upload STL or 3MF models of parts. The app poses each part, computes its
top-down silhouette and height, arranges the parts into one or more trays
(each tray matches the case interior's length and width), and cuts form-fit
pockets with finger cutouts. You download print-ready STL and 3MF files for a
Bambu Lab H3C.

Differences from the old `traygen` (Python CLI):

| | traygen (old) | This app |
|---|---|---|
| Input | 2D SVG/DXF outlines + typed height | 3D STL / 3MF models |
| Pocket | Straight extrusion of the outline | Straight walls to mid-height, form-fit below |
| Parts | TPU crush-rib insert pressed into a PETG tray | Single PETG/PLA tray body; optional TPU liner (see §7) |
| Layout | Shelf packing | Optimizing packer, multiple trays, tiered pockets |
| Runs | Local Python | Browser / phone, offline PWA |

The old Python package stays in the repo for now. The web app goes in `web/`.

## 2. Decisions from the interview

| Topic | Decision |
|---|---|
| Printer | Bambu Lab **H3C**: 330 × 320 × 325 mm build volume, tool changer, multi-material |
| Tray material | PETG or PLA (chosen at export; written into the 3MF) |
| Tray footprint | Every tray uses the same L × W = case interior minus fit clearance. **Must fit the bed** (≤ 330 × 320 mm, rotation allowed); otherwise show an error and don't split |
| Tray depth | Per tray: auto = deepest stack of pockets + floor, or set manually (a warning appears if it's too shallow) |
| Pocket style | Upper half: straight walls (the silhouette cut down). Lower half: follows the part's 3D shape exactly |
| Clearance | **0.5 mm** per side by default, adjustable globally and per part |
| Orientation | Auto stable pose + manual override (90° steps, lay flat on a picked face, spin about Z) |
| Finger cutouts | On by default for every pocket, placed automatically; can be removed per part |
| Stacking | **Tiered pockets**: a shallow part sits in an upper pocket above a deeper part's pocket |
| Units | Stored in mm; UI toggle for mm / inch |
| Import | STL (binary + ASCII) and **3MF** |
| Export | STL (one per tray) and 3MF (one per tray, plus an all-trays project) |

## 3. Geometry

### 3.1 Import and pose
- Parse STL/3MF in a Web Worker. Weld vertices and check that the mesh is
  manifold. If it isn't, show a warning and try a repair (manifold-3d merge);
  if that fails, fall back to the silhouette only (straight pocket).
- Unit detection: if the largest dimension is < 10 units, suggest "this looks
  like inches — scale ×25.4?" (you confirm).
- Large-mesh warning above 500k triangles (offer decimation) and a hard cap
  of 3M.
- Auto pose: from the convex-hull faces, pick the most stable resting face
  (largest contact area; ties go to the lower height). The part is then
  translated so it rests at z = 0.

### 3.2 Silhouette
- `S = union(project(part))` onto the XY plane (manifold-3d `project()`,
  Clipper2-based), simplified to 0.05 mm.
- Height `H = zmax`.

### 3.3 Pocket (cavity) for one part, clearance `c`, split ratio `s` (default 0.5)
- `z_m = s · H`.
- **Upper zone** `z ∈ [z_m, H + top_margin]`: extrude `offset(S_upper, c)`,
  where `S_upper` is the silhouette of everything at or above `z_m`. This
  usually equals S, since the widest part rules.
- **Lower zone** `z ∈ [0, z_m]`: slice the part every Δz (default 0.2 mm,
  matching the layer height). The cavity cross-section at height z is
  `offset(union of slices from z up to z_m, c)`. This gives an exact form-fit
  wherever the part narrows downward. Where the part has undercuts, the
  undercut is filled in automatically so the part can still lift straight
  out. The slab stack is built as one manifold (union of extrusions).
- Floor clearance: the cavity is lowered by `c_z` (default 0.2 mm) so the
  part rests on its lowest point without binding.
- `top_margin` (default 0 mm): optional extra depth so the part sits below
  the rim.
- Pocket depth `D = H + c_z + top_margin`.

### 3.4 Finger cutout
- A rounded slot (default 20 mm wide, about 60 % of the pocket depth, with
  rounded bottom) runs from the pocket edge outward.
- Auto placement: candidates are scored by (a) how much of the part they
  expose (prefer the narrow ends of long parts and the sides of compact ones)
  and (b) the free space left in the layout. The packer treats each finger
  cutout as part of the part's footprint.
- Can be removed or set to 2 (opposite sides) per part.

### 3.5 Tiered pockets
- Part B (shallow) sits above part A's pocket: B's pocket is cut from the
  top, and A's pocket continues below B's pocket floor.
- Valid when `D_A + D_B + floor ≤ tray depth` and B rests stably. "Stable"
  means B's contact footprint, minus the opening of A's pocket, leaves ledges
  totalling ≥ 25 % of B's area spread across its centroid. B's finger cutout
  also gives access to A.
- The packer proposes tiers; you can pin or unpin them.

### 3.6 Tray
- Footprint: case interior L × W − 2 × case clearance (default 1 mm), with
  corner radius (default 4 mm).
- Minimum wall 3 mm between pockets and 4 mm to the outer edge. Floor 2 mm
  under the deepest pocket.
- Optional rim chamfer of 0.6 mm on the pocket edges.
- Optional part label (name engraved 0.6 mm deep beside each pocket).
- Every exported mesh is checked to be manifold and watertight before
  download.

### 3.7 Layout / packing
- **No LLM.** Arrangement is a geometric optimization (2D irregular nesting
  plus assigning parts to trays). A deterministic optimizer is faster and
  more reliable, gives the same result for the same inputs, and works
  offline. Sending part geometry to an LLM would also break the rule that
  files never leave the browser.
- Algorithm (in the worker): rasterize each footprint (pocket + finger
  cutout, dilated by half the wall) at 0.5 mm. Place parts bottom-left-fill
  over candidate rotations (every 15°, plus each part's principal-axis
  angles). Order parts by area descending. Then run simulated annealing on
  order, rotation and tray assignment for a time budget (default 3 s,
  progress shown).
- Objective, in priority order: fewest trays → lowest total stacked depth →
  most even wall margins → finger cutouts pointing at open space.
- Manual override: drag or rotate a part in the 2D tray view. You can lock a
  part, move it to another tray, or make it a tier. Then re-run the optimizer
  for the unlocked parts.

## 4. Export (Bambu H3C)
- **STL**: one binary STL per tray, in mm.
- **3MF**: one per tray (or all trays, one per plate). Built-in plate size is
  330 × 320 mm, and the filament (PETG/PLA) is assigned per object. Uses the
  core 3MF spec plus the Bambu Studio `Metadata/model_settings.config` /
  `project_settings` extensions that Bambu Studio reads for plate and
  filament assignment.
- Suggested print settings are shown at export: 0.2 mm layers, 3 walls,
  15 % gyroid, pockets facing up.

## 5. Architecture
- **TypeScript + Vite**, no UI framework (small vanilla components), or
  Preact if the UI grows.
- **Three.js** preview. Custom touch controls: one finger orbits, pinch
  zooms, two fingers pan. Mouse equivalents on desktop.
- **manifold-3d (WASM)** as the CAD kernel: booleans, slicing, projection,
  offsets, extrusion. Clipper2 is built in.
- **Web Worker** (Comlink-style messages) runs all heavy geometry, with
  progress events and cancellation.
- 3MF read/write uses `fflate` (zip) plus a small XML builder and parser.
- State lives in IndexedDB (projects and imported meshes), so a refresh or
  going offline doesn't lose work. Nothing is uploaded anywhere.
- **PWA**: web manifest + service worker (vite-plugin-pwa); the WASM and all
  assets are precached, so the app works offline after the first load and is
  installable on iOS and Android.

## 6. UI (mobile-first)
- Phone (390 px) layout: a full-screen 3D view, with a bottom sheet that
  snaps to peek / half / full. Sheet tabs: **Parts**, **Trays**, **Export**,
  **Settings**.
- Tap targets ≥ 44 px. Nothing depends on hover. Long-press opens a part's
  menu.
- Native file picker (`accept=".stl,.3mf"`, multiple) for iOS Files and
  Android. Drag-and-drop on desktop.
- Desktop (≥ 900 px): the sheet becomes a right-hand side panel.
- Views: 3D tray preview, 2D layout (top-down, draggable), and a single-part
  pose view.
- Progress bar and cancel button for worker jobs.
- Tested at 390 px in Chromium mobile emulation and Playwright WebKit (as a
  stand-in for iOS Safari). You check on a real iPhone at each milestone.

## 7. Multi-material (H3C tool changer) — TPU protection liner
- v1: single-material tray (PETG or PLA).
- **v1.1: TPU protection liner (approved).** Each pocket is surrounded by a
  TPU body thick enough to fully protect the part. Liner thickness `t` is a
  setting (default 10 mm, range 2–40 mm), applied to the walls *and* under
  the part (floor pad). Liner = `offset(cavity, t)` minus cavity, clipped to
  the tray; the PETG/PLA body = tray minus liners. Neighbouring liners merge
  into one TPU region. A "full TPU interior" mode makes everything inside a
  PETG/PLA outer shell (min 3 mm) TPU.
- The packer treats the liner as part of each footprint (spacing between
  parts ≥ 2·t when not merged; ≥ t when merged), and tray depth grows by the
  floor pad thickness.
- Exported as two objects in one 3MF (shell = PETG/PLA, liner = TPU 95A),
  printed as one multi-material job on the H3C.

## 8. Hosting
- Cloudflare Workers with static assets only: `wrangler.jsonc` with
  `assets.directory = web/dist`, no `main` script, `workers_dev: false`,
  `preview_urls: false`, custom domain route **`pelican.blocknets.org`**.
- Cloudflare Access: a self-hosted app on the domain, one-time PIN identity
  provider, and an allow policy for the owner's email(s), passed as `ACCESS_EMAILS` at setup time (never committed — the repo is public). Set up by an idempotent
  script (`npm run access:setup`) that calls the Cloudflare API with
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment.
  Tokens are never written to files.
- `npm run deploy` = build + `wrangler deploy`. `npm run verify:access`
  curls the domain and checks for a 302 to `*.cloudflareaccess.com` (the
  Access login page) when not authenticated.

## 9. Testing
- Vitest unit tests:
  - silhouette (cube, cylinder, L-bracket, concave and holed parts);
  - pocket cavity (undercut fill, clearance offset, depth);
  - finger-cutout placement;
  - packer (no overlaps, walls respected, footprint bounds, deterministic
    with a seed);
  - tier validity;
  - STL/3MF round-trip;
  - unit detection.
- Playwright smoke test at 390 × 844: upload a fixture STL, preview renders,
  export produces a file.

## 10. Milestones
1. **M0 walking skeleton**: Vite/TS/PWA shell, upload STL/3MF, Three.js
   preview with touch controls, deployed behind Access.
2. **M1**: worker + manifold-3d, auto pose, silhouette, height + unit tests.
3. **M2**: pocket cavity (split form-fit), single tray, STL export.
4. **M3**: finger cutouts, packer, 2D layout editing.
5. **M4**: multiple trays, tiered pockets, per-tray depth.
6. **M5**: 3MF export (H3C plates, materials), 3MF import polish, labels,
   offline/IndexedDB.
7. (v1.1) TPU protection liner.
8. (later) Fusion 360 import via Autodesk Platform Services (see §13).

## 11. Defaults (all adjustable)

| Parameter | Default |
|---|---|
| Lateral clearance | 0.5 mm |
| Floor clearance | 0.2 mm |
| Form-fit split | 50 % of part height |
| Slice step | 0.2 mm |
| Wall between pockets / to edge | 3 / 4 mm |
| Tray floor | 2 mm |
| Case fit clearance | 1 mm per side |
| Finger cutout | 20 mm wide, 60 % depth, on |
| Tray corner radius | 4 mm |

## 12. Open items
1. Case interior L × W × H (mm), or the case model. Entered in the app's
   Settings (default 330 × 230 mm footprint until set).

## 13. Fusion 360 import
- **Built:** `fusion/PelicanExport` — a Fusion script that exports every
  design in a cloud folder as 3MF and uploads it to the parts library
  (`/api/parts`, Workers KV, 25 MB per file, behind Access via a service
  token). The app lists the library under Parts. Files added from the device
  still never leave the browser; library files live in the owner's own
  Cloudflare account. The Worker is therefore no longer assets-only.

### Alternatives considered
- **Today:** export 3MF from Fusion (desktop: File → 3D Print / Export → 3MF,
  or Fusion mobile → share) to iCloud/Files/Drive, then open it with the
  app's file picker.
- **Later:** a "Import from Fusion" button using Autodesk Platform Services
  (APS) with OAuth PKCE in the browser (no server, no secret). It lists your
  hubs/projects/designs via the Data Management API and downloads a
  translated mesh (STL/OBJ via the Model Derivative API). Requires you to
  create a free APS app and register the site's callback URL. Needs a check
  of which F3D output formats Model Derivative currently supports and whether
  APS calls work through Cloudflare Access/CORS; if not, a small Worker
  proxy would be added.
