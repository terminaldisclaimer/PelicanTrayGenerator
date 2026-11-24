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
| Tray footprint | Configurable: you enter the case's inside L × W and a gap per side (default 1 mm). Every tray uses that same footprint. **Must fit the bed** (≤ 330 × 320 mm, rotation allowed); otherwise show an error and don't split |
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
- **Pose = which way up.** Every part offers its six 90° orientations (each
  of the model's ±X, ±Y, ±Z faces down), lowest first, plus any other flat
  resting face that is not square to those axes. The spin about the vertical
  axis is not part of the pose; the packer chooses it.
- **Automatic turning:** unless a part's pose is locked, the layout may turn
  it into any of its 90° orientations (mirror-image outlines count as
  different). It first uses only orientations that need no more depth than
  the deepest part needs lying as low as it can. If the parts do not fit one
  tray and the tray depth is not fixed, it steps the depth up through the
  next deeper orientations, to the case height if one is given, otherwise at
  most half as deep again, and keeps the first depth that fits. With a fixed
  tray depth, every orientation that fits within it is available from the
  start.
- **Lock pose:** each part has a "Lock pose" tick box. Ticked, the part
  keeps exactly the orientation shown (the layout still spins it about the
  vertical axis). Picking an orientation in the pose picker ticks it;
  unticking hands the choice back to the layout.

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
  matching the layer height). The part has to lift straight out, so the
  cavity cross-section at height z is `offset(union of all part slices at or
  below z, c)`. This is an exact form-fit wherever the part narrows towards
  the bottom. Where the part has an undercut (wider below than above), the
  undercut is filled in automatically. Consecutive identical sections are
  merged into one slab; the stack is built as one manifold.
- **Ignoring small details.** "Ignore part details smaller than" (default
  0 mm = follow everything) bridges grooves, notches and gaps in the part's
  outline that are narrower than the setting, at every height, so the pocket
  wall runs straight across them. It is applied to every part, and only ever
  makes a pocket roomier.
- Floor clearance: the cavity is lowered by `c_z` (default 0.2 mm) so the
  part rests on its lowest point without binding.
- `top_margin` (default 0 mm): optional extra depth so the part sits below
  the rim.
- Pocket depth `D = H + c_z + top_margin`.

### 3.4 Finger cutouts
- A round scoop centred on the pocket edge; its diameter is a setting
  (default 20 mm). Each pocket can
  have one on any of its four sides: the two long sides and the two ends.
- Depth: down to the pocket floor. A setting adds extra depth below the
  floor (default 0 mm) for getting a fingertip under the part; the tray grows
  to keep its floor thickness.
- Shape: **swept** by default — a smooth bowl that is full depth at the
  pocket edge and curves up to the surface. Switch it off for a
  straight-sided hole.
- **Auto (default):** parts under 10 mm tall get one scoop (lever the part
  up by its edge); taller parts get a pair on opposite long sides so they
  can be pinched and lifted straight out.
- **Choosing:** each part has a top-down drawing with a circle on every
  side; tap to add or remove a cutout. Presets: Auto, None, Pinch pair.
- Finger holes need no wall between each other: they may overlap, and holes
  of neighbouring parts that overlap or come within 2 mm are cut as one slot
  spanning those parts. A hole stays at least 1.5 mm clear of any other
  part's pocket.
- **Nothing breaks through the tray.** Every cut, pocket or finger hole,
  keeps at least the "minimum tray thickness at the edge" (setting, default
  2 mm) of tray material to the outside, and the floor thickness below, so a
  shell around the tray is never visible through it.

### 3.5 Stacking (tiered pockets)
- A stack is two or more parts sharing one footprint: the top part in a
  normal pocket at the tray surface, each lower part in its own pocket
  beneath the floor of the one above. You lift the top part out to reach
  the next.
- **When it happens (as built):**
  1. The deepest part, lying as low as it can, sets the tray's pocket depth.
  2. A quick side-by-side packing. If everything fits one tray, nothing is
     stacked and that layout is used.
  3. Otherwise a whole-layout search looks for a one-tray layout (§3.7).
     Stacking is one of its moves: a part may be sunk beneath surface parts
     whose pocket depth plus its own fits within the depth from step 1. It
     sits just below the deepest pocket above it and may lie partly under
     several parts.
  4. If no one-tray layout is found and the depth is not fixed, the depth is
     stepped up (see Automatic turning) and the search repeated.
  5. Failing that, the side-by-side packing over several trays is used.
- **Stacking gap.** "Gap between stacked parts" (Trays tab, default 0 mm)
  is vertical room left between a part and the one beneath it: the lower
  pocket sits that much below the floor of the pocket above. Each part can
  set its own "Gap when stacked"; for a pair, the larger of the two applies.
  The gap counts against the tray depth, so a larger gap means fewer parts
  can stack.
- A part on top keeps at least half its floor to rest on, unless the part
  beneath is hidden completely under it (then it rests on that part).
- A lower part's finger holes run from the tray surface down to its floor.
- Settings: "Stack parts if they don't all fit" (on by default), and each
  part has "Stacking: allowed / never".

### 3.6 Tray
- Footprint: case interior L × W − 2 × case clearance (default 1 mm), with
  corner radius (default 4 mm).
- Minimum wall 3 mm between pockets and 4 mm to the outer edge. Floor 2 mm
  under the deepest pocket.
- Optional rim chamfer of 0.6 mm on the pocket edges.
- Optional part label (name engraved 0.6 mm deep beside each pocket).
- Every exported mesh is checked to be manifold and watertight before
  download.

### 3.6a Rigid shell (on by default)
- A separate PLA/PETG body around each tray, shaped like a cup. **The shell's
  outside is the footprint that has to fit the case** (case interior − 2 × gap);
  the tray is smaller by the shell wall on every side, so tray + shell never
  grow past the case.
- Wall: 3 mm by default (1.2–15 mm). The wall stands **4 mm above the tray
  top** (the rim).
- Bottom: a 1 mm floor under the tray, and under that a **2 mm step** set in
  by the wall plus 0.3 mm of play. Stacked, the step of the tray above drops
  2 mm into the recess the rim below makes, leaving 2 mm of headroom over the
  parts. The floor is what joins the step to the walls.
- Heights: a tray on its own is tray depth + 7 mm (4 rim + 1 floor + 2 step);
  each tray in a stack takes tray depth + 5 mm. The case inside height limits
  the tray depth after taking the shell off.
- Gap between tray and shell: 0 by default (printed as one multi-material
  piece); set about 0.2 mm to print the two separately and drop the tray in.
- Exported as its own STL per tray, standing on its step. Printed that way up
  it needs supports under the ledge around the step.
- Code: `web/src/geom/shell.ts`; the packer and tray code only ever see the
  smaller tray footprint.

### 3.7 Layout / packing
- **No LLM.** Fitting pockets together is a precise geometric search (a
  millimetre decides whether two pockets collide). A program can test
  millions of exact positions; a language model would be estimating
  coordinates. It also works offline.
- Every footprint (pocket opening plus finger holes) is grown by half the
  minimum wall plus about 1 mm of slack and rasterised on a 1 mm grid, at
  every 15° about the vertical axis. Footprints that do not overlap are
  therefore at least a wall apart; the tray region is inset so pockets keep
  the edge margin.
- **Stage 1, quick packing** (`pack.ts`): parts are placed one at a time,
  first-fit, trying several orderings, placement rules and pose commitments.
  It is fast and gives tidy layouts. If its best result is one tray, that is
  used.
- **Stage 2, whole-layout search** (`anneal.ts`), when stage 1 needs more
  than one tray. Each part has a pose, an angle, a position and a level (on
  the surface, or sunk beneath others). A layout is scored as a whole by how
  much it breaks the rules, and improved by simulated annealing: move, turn,
  re-pose, swap, butt against a neighbour, or sink one part at a time,
  keeping improvements and sometimes accepting a worse layout to escape dead
  ends. The work is a fixed number of moves with seeded random numbers, so
  the same input gives the same layout on any device. Once a valid layout is
  found it is improved for fewer stacked parts, then a shallower tray, and
  parts that touch nothing are squared up and settled.
- **Limits.** This kind of packing has no known method that guarantees the
  best layout in reasonable time. The search is thorough and repeatable but
  can miss a layout that exists, and stage 2 handles one tray only: if it
  fails, the parts are spread over several trays by stage 1 without
  stacking.
- **What would make it fit?** When the result is more than one tray, a
  button tests one relaxation at a time, each with a thorough search, and
  lists every single change that gets everything into one tray: the longest
  search with no change; smaller finger holes; a deeper tray; a smaller
  stacking gap, edge thickness or clearance; unlocking a pose; allowing a
  part to stack; one finger hole instead of two; leaving out the smallest
  part that makes the rest fit. Suggestions appear as they are found, each
  with Apply; nothing is changed until one is applied. Stop ends the run.
- **Independent check.** After a tray is cut, every part is tested against
  the finished solid (seated and lifted out) and the floor is tested for
  breaks, separately from the layout search. A failure is reported as an
  error instead of producing a tray.
- **Search harder.** When the result is more than one tray, a button reruns
  stage 2 with many times the moves, from three different starting points,
  showing how close it has got. It can find layouts the normal search
  misses, at the cost of up to a few minutes.
- **Not yet built:** manual drag/rotate/lock in a 2D tray view; moving a
  part to another tray by hand; cancelling a long search.

### 3.7b Floor and walls
- "Floor under the deepest pocket" (Trays tab, default 4 mm, 0.8–30): the
  tray material left under the deepest pocket. With an automatic depth the
  tray gets deeper by the same amount; with a set depth or a case height it
  comes out of the room for parts.
- "Wall between pockets" (default 3 mm, 0.8–20): the least material between
  neighbouring pockets.

### 3.7a Lifting the tray out
- "Finger holes to lift the tray out" (Trays tab; long sides, ends, or off;
  on by default): two holes, one against each of the chosen pair of sides.
- Each is a compact grip sized for a man's index finger: a half-round scoop
  in the top face, its straight side on the tray's edge (12 mm into the tray
  and 24 mm wide by default), sloping down into a full round hole (diameter
  setting, default 20 mm) that runs out through the shell wall. No tray is
  left between the scoop and the shell: the shell wall above the hole (rim
  plus 4 mm) is the bridge the finger hooks under. The tray and shell floors
  stay whole. In a tray too shallow for hole plus bridge the bridge gets
  thinner (the hole never goes into the floor).
- It keeps clear only its own half-round scoop.
- The two holes do not have to face each other. In the quick packing they
  sit in the middle of their sides; in the whole-layout search each slides
  along its own side to wherever it is least in the way. Pockets and finger
  holes keep clear of them, and nothing is stacked under them.

### 3.8 Saving
- The current project (parts with their meshes, poses, finger cutouts, and
  the case settings) is saved automatically in the browser's IndexedDB on
  the device and reopened on the next visit.
- Settings tab: Save as…, New project, and a list of saved projects to open
  or delete.
- **The layout is saved too.** The generated arrangement (which tray each
  part is in, its pose, angle, position and level, and where the lift-out
  holes ended up) is stored with the project. Opening the project cuts that
  same arrangement again with no search. Changing a part or its settings
  discards the saved layout, since it no longer matches.
- Parts added from the device are also copied to the Library (the owner's
  Cloudflare account, behind Access), so they can be reused on other devices.
- **Library folders.** Every library part can sit in a folder; the Library
  shows one folder at a time (picker with part counts), with "New folder",
  and "Delete folder" for an empty one. Each part has Add, a "Move…" picker
  (other folders, a new folder, or no folder) and delete. Part names stay
  unique across the whole library. A part added from the device goes into
  the open folder; the Fusion add-in files new parts in a folder named after
  the Fusion folder; re-uploading an existing part leaves it where it is.
- Adding a part from the library leaves it listed (marked "in this
  project"), so it can be added more than once.

### 3.9 Coiled cables
"Add parts" opens a short menu: "Upload part files" or "Add a coiled cable".
The second opens the cable form on the Parts tab (also reachable by scrolling
there), which makes a part from numbers instead of a file.
It follows the owner's Fusion 360 "SnakedWire" script.
- **Coil:** a round cable wound as stacked turns around a rounded rectangle
  (each turn directly on the one below, 0.2 mm apart). You give cable
  diameter, cable length end to end, coil length and width (over the outside
  of the cable) and corner radius. The length, the two leads and the whole
  number of half turns over-constrain it, so the coil length flexes a few
  millimetres (grow or shrink, whichever is smaller) to make the cable
  length exact; the status line reports the result.
- **Two ends, each set up on its own**, one leaving the top turn and one the
  bottom turn. An end is described by where it leaves the coil (anywhere on
  the loop), a bend through any angle (+ toward the middle of the coil, −
  away from it, 0 = straight on, in line with the coil) on a chosen radius,
  and a straight length after the bend.
- **Editing them by hand:** the form shows the cable from above. Each end
  has two handles: a round one on the coil, dragged along the coil to move
  where the end leaves it (it snaps to where a straight meets a corner), and
  a square one at the tip, dragged to swing the end to any angle and set its
  length together (it prefers multiples of 15 degrees). The picture is
  worked out again on every movement; the 3D cable follows when the handle
  is let go. The bend, length and radius can also be typed.
- **Ready-made ends** (buttons): In line, Sideways (straight out past a long
  side from a short end), J (your script's), Into the middle (your
  script's centre lead), None. "Other end of coil" moves the end half a
  turn round. Which long side an outside end lands on follows from the
  winding direction; "Wound: other way" mirrors the cable.
- **Connectors:** each end can carry a model from the library. It is put on
  the cable's end, centred on it, pointing along it. "Turn" points a
  different side of the model along the cable (6 ways; default is its
  longest side), "Roll" turns it a quarter turn about the cable. A lead with
  a connector climbs or drops (two bends) so the connector stays within the
  height of the stack: top level with the top of the stack for the top-turn
  end and for any end in the middle, bottom level with the bottom of the
  stack for an outside end on the bottom turn. A connector must lie wholly
  in the hollow or wholly outside the coil, not across the cable.
- It is refused, with the reason, if the cable would run into itself, the
  radii cannot be wound, or the centre connector does not fit.
- The result is one ordinary part (cable and connectors joined), lying flat
  with its pose locked, so pockets, finger holes, layout and saving work as
  for any part. The pocket is a channel around an island of tray.
- Changing the form and pressing "Update cable" replaces that part. After a
  reload the cable is a plain part: the form keeps its last values, and
  pressing the button adds a new cable.
- **Not built:** a check that the two connectors do not run into each other
  or into the other end's lead; turning a connector by dragging (Turn and
  Roll are buttons); flat or oval cables; more than one editable cable at a time.

## 4. Export (Bambu H3C)
- **STL**: one binary STL per tray, in mm.
- **3MF** (built): one per tray. The tray and its shell are two separate
  bodies (meshes) inside one object, nested as they go together and standing
  on the bed, so the slicer can give each body its own filament (TPU tray,
  PLA/PETG shell). Core 3MF only (components), vertices shared.
- **Not yet built:** an all-trays project file, plate size and filament
  assignment written into the file (Bambu Studio `model_settings.config` /
  `project_settings` extensions).
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

## 7. Multi-material (H3C tool changer) — TPU liner
Built as "TPU as a liner only (shell fills the rest)" on the Trays tab (off by
default; needs the shell, with no gap between tray and shell).
- The tray is split in two. The **liner** (soft, e.g. Bambu TPU 75A) is
  everything within the liner thickness (default 6 mm, 1–20) of a pocket,
  finger hole, lift-out grip or the top face. The **core** is what is left
  deep inside the tray; it is joined to the shell and printed rigid.
- The thickness is a minimum: never thinner than set where the tray has that
  much material, up to about 1.4× in corners. Where the tray has less than
  that (the floor under the deepest pocket, walls between close pockets, the
  tray edge) it all stays liner; the layout is not spread out to make room.
- The top face is always liner, so no shell shows from above.
- Worked in 1 mm slabs from the finished tray, so it follows whatever the
  layout cut. Core slivers under 2 mm wide are left as liner.
- The 3MF holds the two bodies as before: "tray" (the liner) and "shell"
  (shell + core). The status line gives the volume of each.
- **Not built:** per-part thickness (e.g. thicker under glass), filament
  assignment written into the 3MF.

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
| Outside corner radius | 4 mm |
| Shell wall / rim / bottom step / floor | 3 / 4 / 2 / 1 mm |

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
