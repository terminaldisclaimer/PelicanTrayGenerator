import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import type { PartInput, Poly, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { initCad, cad, sectionFromPoly } from '../src/lib/cad/manifold';
import { REG } from '../src/lib/cad/profile';
import { buildTrayMesh } from '../src/lib/cad/tray';
import { buildInsertMesh, insertProblem } from '../src/lib/cad/insert';
import { solve } from '../src/lib/solver/solve';
import { polyBBox } from '../src/lib/geom2d';

const require = createRequire(import.meta.url);
beforeAll(async () => { await initCad(require.resolve('manifold-3d/manifold.wasm')); }, 120000);

const rect = (w: number, h: number): Poly => [[[0, 0], [w, 0], [w, h], [0, h]]];
const disc = (r: number): Poly => [
  Array.from({ length: 72 }, (_, i) => {
    const t = (i / 72) * Math.PI * 2;
    return [r + r * Math.cos(t), r + r * Math.sin(t)] as [number, number];
  }),
];

const part = (over: Partial<PartInput> = {}): PartInput => ({
  id: 'a', name: 'A', poly: rect(60, 40), keepHoles: false, depth: 20, qty: 1,
  groupId: null, sourceFile: '', notes: [], sourceUnitMm: 1, unitOverrideMm: null,
  unitsAmbiguous: false, fingerNotches: [], ...over,
});
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

const toSolid = (m: { positions: Float32Array; indices: Uint32Array }) => {
  const { Manifold, Mesh } = cad();
  return Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }));
};

describe('the part outline travels with the pocket', () => {
  it('stays concentric with the pocket after rotation and placement', () => {
    const s = settings();
    for (const poly of [rect(60, 40), disc(30), [[[0, 0], [70, 70], [66, 74], [-4, 4]]] as Poly]) {
      const res = solve([part({ poly })], s);
      for (const t of res.trays) {
        for (const p of t.parts) {
          const pocket = polyBBox(p.poly);
          const raw = polyBBox(p.rawPoly);
          // The part outline must sit exactly `clearance` inside the pocket
          // on every side, however the solver rotated and moved it.
          expect(raw.minX - pocket.minX).toBeCloseTo(s.clearance, 1);
          expect(raw.minY - pocket.minY).toBeCloseTo(s.clearance, 1);
          expect(pocket.maxX - raw.maxX).toBeCloseTo(s.clearance, 1);
          expect(pocket.maxY - raw.maxY).toBeCloseTo(s.clearance, 1);
        }
      }
    }
  });
});

describe('liner geometry', () => {
  it('builds a watertight solid with ribs', () => {
    const s = settings();
    const res = solve([part()], s);
    const p = res.trays[0].parts[0];
    const ins = buildInsertMesh(p, s)!;
    expect(ins).not.toBeNull();
    expect(ins.ribs).toBeGreaterThan(4);

    const solid = toSolid(ins.mesh);
    expect(solid.status()).toBe('NoError');
    expect(solid.volume()).toBeGreaterThan(0);
    expect(solid.genus()).toBeGreaterThanOrEqual(0);
  });

  it('fits inside its pocket without fouling the tray', () => {
    const s = settings({ thumbNotches: false });
    const res = solve([part()], s);
    const tray = res.trays[0];
    const p = tray.parts[0];
    const ins = buildInsertMesh(p, s)!;

    const trayS = toSolid(buildTrayMesh(tray, s));
    // Lift the liner from pocket-floor coordinates into the tray frame.
    const floorZ = tray.height - REG.height - p.depth;
    const insS = toSolid(ins.mesh).translate(0, 0, floorZ);

    // It must not intersect the tray it drops into...
    expect(trayS.intersect(insS).volume()).toBeLessThan(1.0);
    // ...and must sit within the pocket's own footprint.
    const pocket = polyBBox(p.poly);
    const bb = insS.boundingBox();
    expect(bb.min[0]).toBeGreaterThanOrEqual(pocket.minX - 1e-6);
    expect(bb.min[1]).toBeGreaterThanOrEqual(pocket.minY - 1e-6);
    expect(bb.max[0]).toBeLessThanOrEqual(pocket.maxX + 1e-6);
    expect(bb.max[1]).toBeLessThanOrEqual(pocket.maxY + 1e-6);
    expect(bb.min[2]).toBeGreaterThanOrEqual(floorZ - 1e-6);
    expect(bb.max[2]).toBeLessThanOrEqual(floorZ + p.depth + 1e-6);
  });

  it('grips the part: the ribs interfere, the backing does not', () => {
    const s = settings();
    const res = solve([part()], s);
    const p = res.trays[0].parts[0];
    const ins = buildInsertMesh(p, s)!;
    const insS = toSolid(ins.mesh);

    // The nominal part, standing on the liner's floor pad.
    const partCs = sectionFromPoly(p.rawPoly);
    const partS = partCs.extrude(p.depth).translate(0, 0, s.insertPad);

    const clash = insS.intersect(partS).volume();
    // Ribs must actually squeeze the part...
    expect(clash).toBeGreaterThan(0.5);
    // ...but only the ribs: a solid sleeve would overlap far more than this.
    const sleeve = p.depth * 0.5 * 1000;
    expect(clash).toBeLessThan(sleeve);

    // Shrinking the part by the squeeze allowance clears the ribs entirely.
    const relieved = partCs.offset(-s.insertSqueeze - 0.05, 'Round', 2, 24);
    const relievedS = relieved.extrude(p.depth).translate(0, 0, s.insertPad);
    expect(insS.intersect(relievedS).volume()).toBeLessThan(0.05);
  });

  it('refuses to make a liner when the clearance is too small', () => {
    const tight = settings({ clearance: 0.5 });
    expect(insertProblem(tight)).toMatch(/no room|too small/i);
    const res = solve([part()], tight);
    expect(buildInsertMesh(res.trays[0].parts[0], tight)).toBeNull();
    // The default clearance is fine.
    expect(insertProblem(settings())).toBeNull();
  });

  it('handles a round part and honours coverage', () => {
    const s = settings();
    const res = solve([part({ poly: disc(30), depth: 25 })], s);
    const p = res.trays[0].parts[0];

    const full = buildInsertMesh(p, s)!;
    expect(full.height).toBeCloseTo(25, 1);

    const half = buildInsertMesh(p, settings({ insertCoverage: 0.5 }))!;
    expect(half.height).toBeLessThan(full.height);
    expect(half.height).toBeGreaterThan(s.insertPad);
    expect(toSolid(half.mesh).volume()).toBeLessThan(toSolid(full.mesh).volume());
  });
});
