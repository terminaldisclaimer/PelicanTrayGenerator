import type { Settings, Tray } from '../../types';
import { cad, sectionFromPoly, toTriMesh, type Section, type Solid, type TriMesh } from './manifold';
import { REG, cellCentre, footSolid, socketSolid } from './profile';
import { roundedRect } from '../geom2d';

/**
 * Build one tray in its own printing frame: origin at the lower-left of the
 * footprint, z = 0 at the bottom of the registration feet.
 *
 *   z = 0                    feet that drop into the recesses of the tray below
 *   + REG.height             solid floor
 *   + floor                  pocket zone
 *   + pocketZone             top plane; stacking recesses are cut down from here
 *   + REG.height             top of the ridges
 *
 * WASM objects are freed as we go, so a large solve does not exhaust memory.
 */
export function buildTrayMesh(tray: Tray, s: Settings): TriMesh {
  const { Manifold } = cad();
  const solids: Solid[] = [];
  const sections: Section[] = [];
  const S = <T extends Solid>(x: T): T => { solids.push(x); return x; };
  const C = <T extends Section>(x: T): T => { sections.push(x); return x; };

  try {
    const P = s.gridPitch;
    const T = tray.height;
    const topRef = T - REG.height;

    const footprint = C(sectionFromPoly([
      roundedRect(tray.sizeX, tray.sizeY, REG.cornerRadius, 10).map(
        ([x, y]) => [x + tray.sizeX / 2, y + tray.sizeY / 2] as [number, number],
      ),
    ]));

    let body = S(footprint.extrude(T));

    const centres: [number, number][] = [];
    for (let j = 0; j < tray.cellsY; j++) {
      for (let i = 0; i < tray.cellsX; i++) centres.push([cellCentre(i, P), cellCentre(j, P)]);
    }

    // Registration feet underneath.
    const foot = S(footSolid(P));
    const feet = centres.map(([cx, cy]) => S(foot.translate(cx, cy, 0)));
    const footSlab = S(footprint.extrude(REG.height));
    const feetUnion = S(Manifold.union(feet));
    body = S(body.subtract(S(footSlab.subtract(feetUnion))));

    // Matching recesses on top, one per cell, so a tray registers anywhere on
    // the 25 mm grid rather than only over the tray directly beneath it.
    const socket = S(socketSolid(P, s.stackTolerance));
    const sockets = centres.map(([cx, cy]) => S(socket.translate(cx, cy, topRef)));
    body = S(body.subtract(S(Manifold.union(sockets))));

    // Pockets: straight vertical extrusions of the offset silhouette.
    if (tray.parts.length) {
      const pockets = tray.parts.map((p) => {
        const cs = C(sectionFromPoly(p.poly));
        return S(S(cs.extrude(REG.height + p.depth + 2)).translate(0, 0, topRef - p.depth));
      });
      body = S(body.subtract(S(Manifold.union(pockets))));
    }

    // Finger notches: scallops on the pocket wall, cut from above the ridges
    // down to each pocket's own floor so a finger reaches under the part.
    const fingerCuts: Solid[] = [];
    for (const p of tray.parts) {
      for (const n of p.fingerNotches ?? []) {
        if (!n.valid) continue;
        fingerCuts.push(
          S(S(Manifold.cylinder(REG.height + p.depth + 2, s.fingerNotchRadius, s.fingerNotchRadius, 40))
            .translate(n.x, n.y, topRef - p.depth)),
        );
      }
    }
    if (fingerCuts.length) body = S(body.subtract(S(Manifold.union(fingerCuts))));

    // Thumb notches, cut down to the top of the floor.
    if (tray.notches.length) {
      const depth = REG.height + tray.pocketZone + 2;
      const cuts = tray.notches.map((n) =>
        S(S(Manifold.cylinder(depth, n.radius, n.radius, 48)).translate(n.cx, n.cy, topRef - tray.pocketZone)),
      );
      body = S(body.subtract(S(Manifold.union(cuts))));
    }

    return toTriMesh(body);
  } finally {
    for (const x of solids) { try { x.delete(); } catch { /* already freed */ } }
    for (const x of sections) { try { x.delete(); } catch { /* already freed */ } }
  }
}
