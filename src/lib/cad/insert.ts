import type { PlacedPart, Poly, Settings, Vec2 } from '../../types';
import { cad, offsetPoly, sectionFromPoly, toTriMesh, type Section, type Solid, type TriMesh } from './manifold';

/**
 * A printable TPU liner for one pocket.
 *
 * The liner is a separate part that drops into the pocket and holds the item
 * on compliant crush ribs rather than a solid wall. TPU is not dimensionally
 * predictable enough for a press fit: a 2 mm wall that comes out 0.3 mm over
 * will not go in, and 0.3 mm under will rattle. Ribs simply squash by however
 * much they need to.
 *
 * Radial layout, measured inwards from the liner's outer face:
 *
 *   0                     outer face, sits against the pocket wall
 *   insertFit             (the pocket wall itself)
 *   insertWall            inner face of the backing shell
 *   clearance - fit       where the part's surface will be
 *   + insertSqueeze       rib tips, i.e. how far they are compressed
 */
export interface InsertResult {
  mesh: TriMesh;
  /** Rib count, useful for reporting. */
  ribs: number;
  height: number;
}

/** Distance the rib tip sits inside the liner's outer face. */
function ribTipDepth(s: Settings): number {
  return s.clearance - s.insertFit + s.insertSqueeze;
}

/**
 * Why a pocket cannot take a liner, or null when it can.
 * Exported so the solver can flag it without building any geometry.
 */
export function insertProblem(s: Settings): string | null {
  const tip = ribTipDepth(s);
  if (s.clearance - s.insertFit <= s.insertWall + 0.2) {
    return `A ${s.clearance} mm clearance leaves no room for a ${s.insertWall} mm liner wall. ` +
           `Raise the pocket clearance to at least ${(s.insertWall + s.insertFit + 0.4).toFixed(1)} mm, or use foam.`;
  }
  if (tip <= 0) return 'Clearance is too small for a liner.';
  return null;
}

/** Walk a polygon's rings and drop a point every `spacing` mm of perimeter. */
function samplePerimeter(poly: Poly, spacing: number): Vec2[] {
  const out: Vec2[] = [];
  for (const ring of poly) {
    if (ring.length < 3) continue;
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (perimeter < spacing) {
      // Tiny ring: still give it a few ribs so small parts are held.
      const n = Math.max(3, Math.round(perimeter / Math.max(spacing / 3, 1)));
      for (let k = 0; k < n; k++) out.push(ring[Math.floor((k * ring.length) / n)]);
      continue;
    }
    const count = Math.max(3, Math.round(perimeter / spacing));
    const step = perimeter / count;
    let target = step / 2;
    let travelled = 0;
    let placed = 0;
    for (let i = 0; i < ring.length && placed < count; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (placed < count && travelled + seg >= target) {
        const t = seg === 0 ? 0 : (target - travelled) / seg;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        placed++;
        target += step;
      }
      travelled += seg;
    }
  }
  return out;
}

/**
 * Build the liner for one pocket, in the same tray-local frame as the pocket,
 * with z = 0 at the pocket floor.
 */
export function buildInsertMesh(part: PlacedPart, s: Settings): InsertResult | null {
  if (insertProblem(s)) return null;

  const { Manifold } = cad();
  const solids: Solid[] = [];
  const sections: Section[] = [];
  const S = <T extends Solid>(x: T): T => { solids.push(x); return x; };
  const C = <T extends Section>(x: T): T => { sections.push(x); return x; };

  try {
    const pad = Math.min(s.insertPad, part.depth - 0.6);
    if (pad <= 0.2) return null;
    const height = Math.max(pad + 0.6, Math.min(part.depth, pad + (part.depth - pad) * s.insertCoverage));

    // Outer face: the pocket, pulled in so the liner drops into it.
    const outer = offsetPoly(part.poly, -s.insertFit);
    if (outer.length === 0 || outer[0].length < 3) return null;
    // Inner face of the backing shell.
    const backing = offsetPoly(outer, -s.insertWall);
    if (backing.length === 0 || backing[0].length < 3) return null;

    const tip = ribTipDepth(s);
    // Rib radius: the chosen width, but never so thin the rib loses contact
    // with the backing shell, and capped so the rib centre stays at least
    // its own radius inside the outer face.
    const radius = Math.min(Math.max(s.insertRibWidth, tip - s.insertWall) / 2, tip / 2);
    if (!(radius > 0.15)) return null;

    // Centres of the rib cylinders.
    const ribCurve = offsetPoly(outer, -(tip - radius));
    const centres = ribCurve.length ? samplePerimeter(ribCurve, s.insertRibSpacing) : [];

    const outerCs = C(sectionFromPoly(outer));
    const backingCs = C(sectionFromPoly(backing));

    // Floor pad plus backing shell in one subtraction.
    let body = S(S(outerCs.extrude(height)).subtract(
      S(S(backingCs.extrude(height)).translate(0, 0, pad)),
    ));

    if (centres.length) {
      const lead = Math.min(2.5, (height - pad) * 0.35);
      const straight = height - pad - lead;
      const ribs: Solid[] = [];
      for (const [cx, cy] of centres) {
        // Straight section, then a cone so a part drops in rather than
        // catching on a square rib top.
        if (straight > 0.05) {
          ribs.push(S(S(Manifold.cylinder(straight, radius, radius, 20)).translate(cx, cy, pad)));
        }
        if (lead > 0.05) {
          ribs.push(S(S(Manifold.cylinder(lead, radius, radius * 0.35, 20))
            .translate(cx, cy, pad + Math.max(0, straight))));
        }
      }
      // Trim to the outer face so nothing can protrude and jam the pocket.
      const trimmed = S(S(Manifold.union(ribs)).intersect(S(outerCs.extrude(height))));
      body = S(body.add(trimmed));
    }

    // Open the liner where a finger notch is, or the notch would end at a
    // TPU wall. Slightly oversize so the openings line up despite fit gaps.
    const notchCuts = (part.fingerNotches ?? []).filter((n) => n.valid);
    if (notchCuts.length) {
      const cuts = notchCuts.map((n) =>
        S(S(Manifold.cylinder(height + 2, s.fingerNotchRadius + 0.4, s.fingerNotchRadius + 0.4, 40))
          .translate(n.x, n.y, -1)),
      );
      body = S(body.subtract(S(Manifold.union(cuts))));
    }

    return { mesh: toTriMesh(body), ribs: centres.length, height };
  } finally {
    for (const x of solids) { try { x.delete(); } catch { /* already freed */ } }
    for (const x of sections) { try { x.delete(); } catch { /* already freed */ } }
  }
}
