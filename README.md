# Pelican Tray Generator

A browser app that turns a set of part outlines into 3D-printable stackable trays
that fill a Pelican case cutout.

You give it the cutout dimensions, one SVG silhouette per part (as traced on a
Shaper Origin), and how deep each part needs to sit. It packs the parts onto
trays, snaps every tray to a 25 mm grid, stacks the trays inside the cutout,
shows the result in 3D, and exports 3MF and STL sized for a Bambu Lab X1C.

Everything runs in the browser. No server, no uploads, no account.

---

## Using it

1. **Case cutout** - enter the cutout's inside length, width and depth.
2. **Parts** - drop in one SVG per part. The app reads real-world units from the
   SVG, so a Shaper Origin trace comes in at the right size with nothing to set.
   Give each part its depth: *part height + about 2 mm*, so the underside of the
   tray above closes the pocket without pressing on the part.
3. **Groups** - parts that must share a tray get the same group. The solver
   treats a group as one rigid block and never splits it.
4. **Trays** - one global pocket clearance (default 2 mm) is offset around every
   outline. It is sized so a foam or felt liner takes up the slack; there is no
   per-part clearance to manage.
5. **Generate** - the preview shows the trays in the case. Drag to orbit, use
   **Explode** to separate the layers, and click a tray to highlight it.
6. **Export** - 3MF or STL per tray, or **Download all** for a zip containing
   both formats, printing notes, and the project file.

**Save project** writes a `.traygen.json` file holding everything: dimensions,
outlines, depths and groups. Keep it next to your case. The app also autosaves
into browser storage as a convenience, but the file is the real record.

## How the trays work

**Footprint.** Every tray is a whole number of 25 mm cells, sized to the
smallest multiple that holds its parts. The grid is deliberately fine so trays
are not oversized: a part needing 60 mm of pocket gets a 3-cell tray, not a
half-empty case-sized one.

**Stacking.** The lip and base chamfer profile is Gridfinity's, unchanged:
0.8 mm chamfer, 1.8 mm straight, 2.15 mm chamfer, 4.75 mm tall, 0.5 mm cell
clearance. Those numbers have years of field use behind them. Only the X/Y pitch
changes - 25 mm here instead of 42 mm. The Z profile is pitch-independent, so it
transfers as-is.

Unlike a Gridfinity bin, **every cell of every tray gets a recess on top and a
foot underneath**, not just the perimeter. That is what lets a small tray sit
anywhere on a larger one at 25 mm intervals without sliding, which a
perimeter-only lip does not give you.

**Pockets** are straight vertical extrusions of the offset silhouette, cut to
each part's own depth. No stepped or contoured pockets, so a part drops straight
in and lifts straight out.

**Retention** comes from the flat underside of the tray above; the case's lid
foam presses on the top layer. This is why pocket depth is part height plus a
couple of millimetres.

**Layer heights.** Trays in a layer are padded to a common height *only where a
tray above actually rests on them*. A shallow tray with nothing above it stays
shallow instead of carrying tens of millimetres of solid filler.

## Printing

- **Trays:** PETG. Heat tolerance for a case left in a vehicle, and tough enough
  to take a drop. Print flat, feet down, no supports. 0.2 mm layers, 3 walls,
  15 % infill.
- **Liners:** self-adhesive foam or felt cut to the pocket, or printed TPU
  inserts. TPU runs from an external spool on the X1C rather than through the
  AMS. Foaming TPU is worth an experiment but is not the baseline - it is not
  dimensionally predictable enough to design around.
- **Oversized trays** are flagged rather than auto-split. The solver caps tray
  size at the bed limit, so this only comes up if you force a group that cannot
  fit; split the group and regenerate.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # solver, geometry, SVG parsing
npm run typecheck
npm run build      # static site in dist/
```

## Hosting

The app is fully static - HTML, JS, a WASM geometry kernel, and nothing else -
so it runs anywhere that serves files.

### Self-hosting (Unraid, Docker)

There is a container: nginx plus the built assets, no state and no volumes.

```bash
docker compose up -d          # pulls the published image, serves on :8420
```

`docs/SELF-HOSTING.md` covers the Unraid routes end to end - the GHCR image with
automatic updates, Compose Manager, or building on the box with no registry at
all - plus the Docker template in `unraid/`.

### Free public hosting

**GitHub Pages.** `.github/workflows/deploy.yml` builds and
publishes on every push to `main`. Enable it once under
*Settings -> Pages -> Build and deployment -> Source: GitHub Actions*. The
workflow sets `BASE_PATH` from the repository name so assets resolve under
`https://<user>.github.io/<repo>/`.

**Cloudflare Workers.** `wrangler.jsonc` is set up for Workers Static Assets,
which is what Cloudflare recommends for new static sites rather than Pages.
Deploy from a machine with credentials:

```bash
npx wrangler login     # or export CLOUDFLARE_API_TOKEN=...
npm run deploy         # builds, then uploads dist/
```

`.github/workflows/deploy-cloudflare.yml` does the same on every push to `main`
once two repository secrets are set under *Settings -> Secrets and variables ->
Actions*:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard -> My Profile -> API Tokens -> Create Token -> **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard -> Workers & Pages, in the right-hand sidebar |

`npm run deploy:dry` validates the config and the upload without publishing.

**Netlify / Vercel** work with no config change: build command `npm run build`,
output directory `dist`, and leave `BASE_PATH` unset so the site is served from
the domain root.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why this is a client-side
app and how the pieces fit together, and
[docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) for the decisions behind
the geometry.
