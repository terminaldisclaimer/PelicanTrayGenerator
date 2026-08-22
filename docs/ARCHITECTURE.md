# Architecture

## The decision: fully client-side

The first task was to evaluate a browser-only app against a Python backend
(build123d / CadQuery) before committing. **The app is fully client-side.**

What the geometry actually needs:

| Operation | Needed for | Available in the browser? |
|---|---|---|
| Polygon offset | Pocket clearance around a silhouette | Yes - Clipper2, via manifold's `CrossSection.offset` |
| Polygon extrusion with holes | Pockets, tray bodies | Yes - `CrossSection.extrude` |
| Boolean subtraction | Pockets and recesses out of the tray | Yes - manifold's CSG |
| Lofted chamfer profiles | The stacking lip and feet | Yes - built from stacked cross-sections |
| Mesh export | 3MF, STL | Yes - both are mesh formats |

Nothing on that list needs a BREP kernel. The stacking profile is three straight
chamfer segments, not a fillet, so it can be lofted directly rather than
constructed with the fillet/chamfer operations that push you towards OpenCascade.
Pockets are straight prisms by design. That removes the only real argument for a
backend.

What being client-side buys:

- **Free hosting that stays free.** Static files on GitHub Pages, Cloudflare
  Pages or Netlify. No server to keep alive, no cold starts, no bill when it
  gets used.
- **No round trip.** Solving and rebuilding geometry after a slider change is
  local. A backend would upload SVGs and download meshes on every iteration.
- **Nothing leaves the machine.** Part outlines stay in the browser.
- **One language.** The solver, geometry and UI share types; a part outline is
  the same object from SVG parse to STL write.

The costs, and why they are acceptable:

- **~540 KB of WASM** on first load, cached afterwards. Fine for a design tool.
- **No STEP export.** 3MF and STL are what a Bambu Lab slicer wants; STEP was
  never in scope.
- **Single-threaded geometry.** A realistic case solves and builds in a couple
  of seconds. Tray meshes are built one at a time with the event loop yielding
  in between, so the UI stays responsive and shows progress.

`replicad` (OpenCascade in WASM) was the other client-side option. It brings a
much larger download and slower boolean operations in exchange for BREP features
this design does not use. `manifold-3d` is the better fit.

## Module map

```
src/
  types.ts                  Project, Settings, Tray, SolveResult
  defaults.ts               Default settings and an empty project
  lib/
    geom2d.ts               Areas, bounding boxes, convex hull, rotating
                            callipers, rounded rectangles, bezier flattening
    svg/
      parsePath.ts          SVG path `d` -> polylines (all commands, arcs
                            included)
      parseSvg.ts           SVG document -> one silhouette in mm: unit
                            resolution, nested transforms, shape elements,
                            outer/hole classification
    cad/
      manifold.ts           WASM kernel bootstrap, polygon offset, lofting,
                            mesh extraction, explicit WASM memory release
      profile.ts            The stacking profile constants and the foot /
                            recess solids
      tray.ts               One tray solid: body, feet, recesses, pockets,
                            thumb notches
      insert.ts             One TPU liner per pocket: floor pad, backing shell
                            and crush ribs, with the fit maths and the checks
                            that refuse a liner the clearance cannot hold
    solver/
      maxrects.ts           Maximal-rectangles packer
      solve.ts              Parts -> pockets -> clusters -> depth buckets ->
                            trays -> layers
    export/
      stl.ts                Binary STL
      threemf.ts            3MF package (multiple named objects), zipping,
                            downloads
    project.ts              Project JSON load/save and best-effort autosave
  three/Preview.tsx         Interactive 3D preview
  ui/                       Panels
  App.tsx                   State, the generate pipeline, exports
```

## The solve pipeline

1. **Silhouettes.** Each SVG becomes one closed outline in millimetres, plus any
   interior outlines, which are kept as pocket islands only if the part asks for
   it.
2. **Pockets.** Each silhouette is offset outward by the single global clearance
   and, if rotation is enabled, turned to its minimum-area orientation using
   rotating callipers.
3. **Clusters.** Parts sharing a group are packed against each other once and
   from then on travel as a single rigid rectangle, which is what guarantees
   they end up on the same tray.
4. **Depth buckets.** Clusters are grouped by depth so a tall part does not drag
   shallow ones into a deep tray. The bucket tolerance is a setting.
5. **Trays.** Within a bucket, every candidate grid size is tried; each is packed
   with maximal-rectangles and then shrunk to the smallest grid multiple that
   still contains what was placed. The densest candidate wins, with a mild
   preference for the one that clears more parts. Candidates are capped by both
   the cutout footprint and the printer bed, so an oversized tray cannot be
   produced by the packer.
6. **Layers.** Tray rectangles are packed into the cutout footprint in grid
   cells, deepest first, so trays of similar depth land together. Layers stack
   until the parts run out.
7. **Padding.** Only trays that carry a tray above them are padded to their
   layer's height.
8. **Geometry.** Each tray becomes a solid and then a triangle mesh, and each
   pocket gets a liner built in the same frame.

Throughout, each part carries **two** outlines: the pocket outline (offset by
the clearance) and the part's own outline. Every rotation and placement applies
the identical rigid motion to both, which is what keeps a liner concentric with
the pocket it has to drop into. A test asserts this holds after the solver has
rotated a part to its minimum-area orientation and then turned its whole tray a
quarter turn to fit the layer.

## Geometry construction

A tray, bottom to top:

```
z = 0                       bottom of the registration feet
  + 4.75  (REG.height)      top of the feet / underside of the floor
  + floor                   pocket floor
  + pocketZone              top plane - the floor of the stacking recesses
  + 4.75  (REG.height)      top of the ridges
```

Stack pitch is `4.75 + floor + pocketZone`: the ridges of one tray are consumed
by the feet of the next, exactly as a Gridfinity bin stacks.

The solid is built by subtraction:

- Start with the footprint extruded to full height.
- Subtract *(bottom slab minus the union of per-cell feet)*, which carves the
  feet and clips them to the footprint in one step.
- Subtract the per-cell recesses at the top.
- Subtract each pocket, as a prism from above the top face down to its own
  depth. Cutting from the top face means the recess ridges vanish wherever a
  pocket needs the space.
- Subtract the thumb-notch scallops.

Pockets are held `max(wall, 2.95 mm)` from the tray edge. 2.95 mm is the width
of the lip at the recess floor, so the perimeter lip keeps its full profile no
matter how thin the walls are set.

Thumb notches are opportunistic: a scallop is cut at the middle of an edge only
where it clears every pocket, edges of the short sides first. A tray with no room
for one says so instead of quietly compromising a pocket wall.

WASM objects are freed explicitly as each tray is built, so a large case does not
accumulate garbage in the kernel's heap.

## Containerised deployment

`Dockerfile` builds the site with Node and serves it from nginx. The runtime
stage asserts, at image build time, that the base image still provides the
`application/wasm` MIME type and `gzip_static`, and runs `nginx -t`. Both are
assumptions that would otherwise fail silently in someone's browser, so they
fail the build instead. See `docs/SELF-HOSTING.md`.

## Testing

`npm test` covers the parts that are easy to get subtly wrong:

- **SVG** - millimetre documents with a 96 dpi viewBox (the Shaper Origin
  convention), unitless documents, inches, nested transforms, holes versus
  separate outlines, `defs` exclusion, and the error path. Circles are
  circumscribed rather than inscribed so a round pocket is never undersized.
- **Solver invariants**, asserted on every scenario: tray footprints match their
  cell counts, pockets clear the perimeter margin, pockets keep a full wall
  between them, stored outlines agree with their bounding boxes, trays do not
  overlap within a layer or spill outside the grid, layers stack without gaps,
  and any tray carrying a tray above it reaches its layer height.
- **Geometry** - the built mesh is fed back through the kernel to prove it is
  watertight and manifold, it stays inside its declared envelope, and probe
  cubes confirm pockets are cut to the depth that was asked for.
- **Stacking fit** - a foot is lowered into a recess and the intersection volume
  is checked to be zero, which is what actually proves the profile mates.
