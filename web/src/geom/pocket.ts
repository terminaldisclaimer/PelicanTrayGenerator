import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import type { Silhouette } from './analyze';
import { toManifold } from './analyze';

export interface PocketOptions {
  /** Gap between part and pocket wall, per side (mm). */
  clearance: number;
  /** Extra depth under the part so it rests without binding (mm). */
  floorClearance: number;
  /** Fraction of the part height that is form-fitted; above it walls are straight. */
  split: number;
  /** Height of each form-fit step (mm); match the print layer height. */
  sliceStep: number;
  /** Extra depth so the part sits below the tray surface (mm). */
  topMargin: number;
}

export const DEFAULT_POCKET: PocketOptions = { clearance: 0.5, floorClearance: 0.2, split: 0.5, sliceStep: 0.2, topMargin: 0 };

export interface Cavity {
  /**
   * The pocket volume in the part's own coordinates: the part rests on z=0,
   * the cavity runs from z=-floorClearance up to z=top (and `overcut` beyond,
   * so subtracting it from a tray leaves a clean opening).
   */
  solid: Manifold;
  /** Pocket depth below the tray surface: height + floorClearance + topMargin. */
  depth: number;
  /** z of the tray surface in part coordinates. */
  top: number;
  /** Outline of the pocket opening at the tray surface (silhouette + clearance). */
  opening: Silhouette;
  /** Number of distinct steps in the form-fit zone (1 = straight walls). */
  steps: number;
  formFit: boolean;
}

const OVERCUT = 1; // mm above the tray surface
const CIRCULAR_SEGMENTS = 24;
/** How far (mm) a form-fit wall may sit outside the true part surface before a new step is cut. */
const SLAB_TOLERANCE = 0.08;

/**
 * Build the pocket for one posed part.
 *
 * Upper zone (above split·height): the full top-down silhouette, cut straight
 * down. Lower zone: follows the part. The part must still lift straight out,
 * so the pocket at height z is the union of every part cross-section at or
 * below z — an exact fit wherever the part narrows towards the bottom, with
 * undercuts filled in automatically. Everything is grown by `clearance`.
 */
export function buildCavity(k: ManifoldToplevel, mesh: TriMesh, silhouette: Silhouette, height: number, o: PocketOptions): Cavity {
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  try {
    const grow = (cs: CrossSection) => keep(keep(cs.offset(o.clearance, 'Round', 2, CIRCULAR_SEGMENTS)).simplify(0.01));
    const top = height + o.topMargin;
    const outline = keep(k.CrossSection.ofPolygons(silhouette, 'Positive'));
    const part = toManifold(k, mesh);
    if (part) keep(part);

    const zm = part ? Math.min(height, Math.max(0, o.split * height)) : 0;
    const slabs: Manifold[] = [];
    let steps = 0;
    let lowerTop: CrossSection | null = null; // widest section of the form-fit zone

    if (part && zm > o.sliceStep / 2) {
      // Lower zone: stack of thin slabs, each the running union of sections so far.
      const n = Math.max(1, Math.round(zm / o.sliceStep));
      const dz = zm / n;
      let cumulative: CrossSection | null = null;
      let slabStart = -o.floorClearance; // z where the current slab began
      let slabArea = -1; // section area when the current slab began
      let previous: CrossSection | null = null; // running union up to the previous step
      // A slab ends when the section has grown noticeably (its edge moved by
      // roughly SLAB_TOLERANCE). Each slab is cut with the *largest* section
      // inside it, so the pocket never pinches the part.
      const flush = (z: number, section: CrossSection | null) => {
        if (section && z > slabStart) {
          slabs.push(keep(keep(grow(section).extrude(z - slabStart)).translate(0, 0, slabStart)));
          steps++;
        }
        slabStart = z;
      };
      for (let i = 0; i < n; i++) {
        const z0 = i * dz, z1 = (i + 1) * dz;
        // Sample mid-step and just below the top of the step.
        for (const z of [z0 + dz / 2, z1 - 1e-3]) {
          const s = keep(part.slice(z));
          // Simplify as we go: curved parts otherwise pile up thousands of
          // near-duplicate vertices in the running union and slow to a crawl.
          if (cumulative) {
            const joined: CrossSection = keep((cumulative as CrossSection).add(s));
            cumulative = keep(joined.simplify(0.005));
          } else cumulative = s;
        }
        const area = cumulative!.area();
        if (slabArea < 0) slabArea = area;
        else if (area - slabArea > SLAB_TOLERANCE * Math.sqrt(4 * Math.PI * Math.max(area, 1))) {
          flush(z0, previous); // close the slab below with everything up to z0
          slabArea = area;
        }
        previous = cumulative;
      }
      flush(zm, cumulative);
      lowerTop = cumulative;
    }

    // The straight zone must contain everything below it (the outline was
    // simplified separately, so make that explicit).
    const opening = grow(lowerTop ? keep(outline.add(lowerTop)) : outline);

    // Upper zone (or the whole pocket for non-solid meshes / split = 0).
    const upperStart = slabs.length ? zm : -o.floorClearance;
    slabs.push(keep(keep(opening.extrude(top + OVERCUT - upperStart)).translate(0, 0, upperStart)));

    const solid = slabs.length === 1 ? slabs[0] : k.Manifold.union(slabs);
    if (slabs.length === 1) trash.splice(trash.indexOf(solid), 1);
    return {
      solid, top, depth: height + o.floorClearance + o.topMargin,
      opening: opening.toPolygons() as Silhouette,
      steps: Math.max(1, steps), formFit: steps > 1,
    };
  } finally {
    for (const t of trash) t.delete();
  }
}
