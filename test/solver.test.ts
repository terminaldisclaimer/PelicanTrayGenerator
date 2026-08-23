import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import type { PartInput, Poly, Settings, SolveResult } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { initCad } from '../src/lib/cad/manifold';
import { LIP_BASE, REG } from '../src/lib/cad/profile';
import { solve } from '../src/lib/solver/solve';
import { polyBBox } from '../src/lib/geom2d';

const require = createRequire(import.meta.url);
beforeAll(async () => { await initCad(require.resolve('manifold-3d/manifold.wasm')); }, 120000);

const rect = (w: number, h: number): Poly => [[[0, 0], [w, 0], [w, h], [0, h]]];
const ellipse = (rx: number, ry: number): Poly => [
  Array.from({ length: 48 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2;
    return [rx + rx * Math.cos(t), ry + ry * Math.sin(t)] as [number, number];
  }),
];

let seq = 0;
const part = (over: Partial<PartInput> = {}): PartInput => ({
  id: `p${seq++}`, name: `P${seq}`, poly: rect(40, 30), keepHoles: false, depth: 20,
  qty: 1, groupId: null, sourceFile: '', notes: [], sourceUnitMm: 1, unitOverrideMm: null,
  unitsAmbiguous: false, fingerNotches: [], ...over,
});
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a, slack = 1e-6) =>
  a.x < b.x + b.w - slack && b.x < a.x + a.w - slack &&
  a.y < b.y + b.h - slack && b.y < a.y + a.h - slack;

/** Structural invariants every solve must satisfy. */
function checkInvariants(res: SolveResult, s: Settings) {
  const margin = Math.max(s.wall, LIP_BASE);
  for (const t of res.trays) {
    expect(t.sizeX).toBeCloseTo(t.cellsX * s.gridPitch - REG.cellGap, 6);
    expect(t.sizeY).toBeCloseTo(t.cellsY * s.gridPitch - REG.cellGap, 6);

    for (let i = 0; i < t.parts.length; i++) {
      const a = t.parts[i];
      // Pocket stays clear of the perimeter lip.
      expect(a.bbox.x).toBeGreaterThanOrEqual(margin - 1e-6);
      expect(a.bbox.y).toBeGreaterThanOrEqual(margin - 1e-6);
      expect(a.bbox.x + a.bbox.w).toBeLessThanOrEqual(t.sizeX - margin + 1e-6);
      expect(a.bbox.y + a.bbox.h).toBeLessThanOrEqual(t.sizeY - margin + 1e-6);

      // The stored outline agrees with the stored bounding box.
      const bb = polyBBox(a.poly);
      expect(bb.minX).toBeCloseTo(a.bbox.x, 4);
      expect(bb.minY).toBeCloseTo(a.bbox.y, 4);
      expect(bb.maxX - bb.minX).toBeCloseTo(a.bbox.w, 4);
      expect(bb.maxY - bb.minY).toBeCloseTo(a.bbox.h, 4);

      expect(a.depth).toBeLessThanOrEqual(t.pocketZone + 1e-6);

      // Pockets keep a full wall between them.
      for (let j = i + 1; j < t.parts.length; j++) {
        const b = t.parts[j];
        const grown = { x: a.bbox.x - s.wall / 2, y: a.bbox.y - s.wall / 2, w: a.bbox.w + s.wall, h: a.bbox.h + s.wall };
        const other = { x: b.bbox.x - s.wall / 2, y: b.bbox.y - s.wall / 2, w: b.bbox.w + s.wall, h: b.bbox.h + s.wall };
        expect(overlaps(grown, other, 1e-4)).toBe(false);
      }
    }
  }

  for (const layer of res.layers) {
    for (let i = 0; i < layer.trays.length; i++) {
      const a = layer.trays[i];
      expect(a.cellX).toBeGreaterThanOrEqual(0);
      expect(a.cellX + a.cellsX).toBeLessThanOrEqual(res.stats.gridCellsX);
      expect(a.cellY + a.cellsY).toBeLessThanOrEqual(res.stats.gridCellsY);
      // A tray is either padded to its layer height or left at its own depth.
      expect([layer.pocketZone, a.requiredDepth].map((v) => v.toFixed(6))).toContain(a.pocketZone.toFixed(6));
      expect(a.pocketZone).toBeGreaterThanOrEqual(a.requiredDepth - 1e-6);
      expect(a.height).toBeCloseTo(REG.height + s.floor + a.pocketZone + REG.height, 6);
      for (let j = i + 1; j < layer.trays.length; j++) {
        const b = layer.trays[j];
        expect(overlaps(
          { x: a.cellX, y: a.cellY, w: a.cellsX, h: a.cellsY },
          { x: b.cellX, y: b.cellY, w: b.cellsX, h: b.cellsY },
        )).toBe(false);
      }
    }
  }

  // Any tray carrying a tray above it must reach its layer's full height.
  for (let i = 0; i + 1 < res.layers.length; i++) {
    const above = res.layers[i + 1];
    for (const t of res.layers[i].trays) {
      const loaded = above.trays.some(
        (u) => overlaps(
          { x: t.cellX, y: t.cellY, w: t.cellsX, h: t.cellsY },
          { x: u.cellX, y: u.cellY, w: u.cellsX, h: u.cellsY },
        ),
      );
      if (loaded) expect(t.pocketZone).toBeCloseTo(res.layers[i].pocketZone, 6);
    }
  }

  // Layers stack without gaps or overlaps.
  let z = 0;
  for (const layer of res.layers) {
    expect(layer.z).toBeCloseTo(z, 6);
    expect(layer.pitch).toBeCloseTo(REG.height + s.floor + layer.pocketZone, 6);
    z += layer.pitch;
  }
  if (res.layers.length) expect(res.stats.stackHeight).toBeCloseTo(z + REG.height, 6);
}

describe('tray sizing', () => {
  it('snaps to the smallest grid multiple that fits the part', () => {
    const s = settings();
    const res = solve([part({ poly: rect(40, 30) })], s);
    const t = res.trays[0];
    // 40 x 30 part + 2 mm clearance per side + 2.95 mm perimeter margin per
    // side = 49.9 x 39.9 mm of tray needed. Two cells span 49.5 mm, so the
    // long side takes three cells and the short side two.
    expect([t.cellsX, t.cellsY].sort()).toEqual([2, 3]);
    // One cell smaller in either direction must genuinely not fit.
    const margin = Math.max(s.wall, LIP_BASE);
    const need = [44 + 2 * margin, 34 + 2 * margin].sort((a, b) => a - b);
    const have = [t.sizeX, t.sizeY].sort((a, b) => a - b);
    expect(have[0]).toBeGreaterThanOrEqual(need[0]);
    expect(have[1]).toBeGreaterThanOrEqual(need[1]);
    expect(have[0] - s.gridPitch).toBeLessThan(need[0]);
    expect(have[1] - s.gridPitch).toBeLessThan(need[1]);
    checkInvariants(res, s);
  });

  it('never leaves a whole empty cell row', () => {
    const s = settings();
    const res = solve([part({ poly: rect(20, 20) })], s);
    const t = res.trays[0];
    expect(t.cellsX).toBe(2);
    expect(t.cellsY).toBe(2);
  });

  it('packs many parts onto few trays', () => {
    const s = settings();
    const parts = Array.from({ length: 12 }, (_, i) => part({ poly: rect(30, 25), name: `part${i}` }));
    const res = solve(parts, s);
    expect(res.unplaced).toHaveLength(0);
    expect(res.trays.length).toBeLessThanOrEqual(3);
    expect(res.stats.partCount).toBe(12);
    checkInvariants(res, s);
  });
});

describe('grouping constraints', () => {
  it('keeps a forced group on one tray', () => {
    const s = settings();
    const parts = [
      part({ poly: rect(40, 30), groupId: 'g1', name: 'g-a' }),
      part({ poly: rect(35, 25), groupId: 'g1', name: 'g-b' }),
      part({ poly: rect(60, 50), name: 'loner' }),
      part({ poly: ellipse(30, 20), name: 'oval' }),
    ];
    const res = solve(parts, s);
    const trayOf = (n: string) => res.trays.find((t) => t.parts.some((p) => p.name === n))!;
    expect(trayOf('g-a').id).toBe(trayOf('g-b').id);
    checkInvariants(res, s);
  });
});

describe('depth handling', () => {
  it('separates very different depths onto different trays', () => {
    const s = settings({ depthBucketTolerance: 5 });
    const parts = [
      part({ poly: rect(40, 30), depth: 10, name: 'shallow' }),
      part({ poly: rect(40, 30), depth: 70, name: 'deep' }),
    ];
    const res = solve(parts, s);
    const shallow = res.trays.find((t) => t.parts.some((p) => p.name === 'shallow'))!;
    const deep = res.trays.find((t) => t.parts.some((p) => p.name === 'deep'))!;
    expect(shallow.id).not.toBe(deep.id);
    checkInvariants(res, s);
  });

  it('pads a tray that carries the layer above, and leaves the rest alone', () => {
    // A cutout only two cells wide forces several layers, so some trays end up
    // load bearing and some do not.
    const s = settings({ cutoutLength: 130, cutoutWidth: 60, cutoutDepth: 400, depthBucketTolerance: 5 });
    const parts = [
      part({ poly: rect(45, 30), depth: 40, name: 'deep' }),
      part({ poly: rect(45, 30), depth: 8, name: 'shallow' }),
      part({ poly: rect(45, 30), depth: 41, name: 'deep2' }),
      part({ poly: rect(45, 30), depth: 9, name: 'shallow2' }),
    ];
    const res = solve(parts, s);
    expect(res.layers.length).toBeGreaterThan(1);
    checkInvariants(res, s);

    // Nothing sits on the top layer, so nothing there is padded.
    for (const t of res.layers[res.layers.length - 1].trays) {
      expect(t.padding).toBeCloseTo(0, 6);
      expect(t.pocketZone).toBeCloseTo(t.requiredDepth, 6);
    }
  });

  it('does not pad at all when everything fits in one layer', () => {
    const s = settings({ depthBucketTolerance: 5 });
    const parts = [
      part({ poly: rect(40, 30), depth: 8, name: 'a' }),
      part({ poly: rect(40, 30), depth: 45, name: 'b' }),
    ];
    const res = solve(parts, s);
    expect(res.layers).toHaveLength(1);
    for (const t of res.trays) {
      expect(t.padding).toBeCloseTo(0, 6);
      expect(t.pocketZone).toBeCloseTo(t.requiredDepth, 6);
    }
    checkInvariants(res, s);
  });

  it('reports a stack that is too tall for the cutout', () => {
    const s = settings({ cutoutDepth: 40, cutoutLength: 120, cutoutWidth: 120 });
    const parts = Array.from({ length: 6 }, (_, i) => part({ poly: rect(70, 70), depth: 30, name: `big${i}` }));
    const res = solve(parts, s);
    expect(res.layers.length).toBeGreaterThan(1);
    expect(res.stats.stackHeight).toBeGreaterThan(s.cutoutDepth);
    expect(res.warnings.join(' ')).toMatch(/only \d+ mm deep/i);
    checkInvariants(res, s);
  });
});

describe('limits', () => {
  it('flags a part that cannot fit any tray, and says why', () => {
    const s = settings();
    const res = solve([part({ poly: rect(400, 200), name: 'huge' })], s);
    const u = res.unplaced.find((x) => x.name === 'huge');
    expect(u).toBeDefined();
    // The message has to name the limit and the shortfall, not just "too big".
    expect(u!.reason).toMatch(/printer bed/);
    expect(u!.reason).toMatch(/\d+ mm short/);
    expect(u!.reason).toMatch(new RegExp(`${s.maxBed} mm`));
    // And a solve that placed nothing must say so at the top level.
    expect(res.trays).toHaveLength(0);
    expect(res.warnings.join(' ')).toMatch(/No trays were generated/);
  });

  it('blames the cutout, not the bed, when the case is the smaller limit', () => {
    const s = settings({ cutoutLength: 120, cutoutWidth: 120 });
    const res = solve([part({ poly: rect(200, 90), name: 'wide' })], s);
    const u = res.unplaced.find((x) => x.name === 'wide');
    expect(u!.reason).toMatch(/case cutout/);
  });

  it('never produces a tray wider than the printer bed', () => {
    const s = settings({ cutoutLength: 600, cutoutWidth: 400 });
    const parts = Array.from({ length: 20 }, () => part({ poly: rect(45, 45), depth: 20 }));
    const res = solve(parts, s);
    for (const t of res.trays) {
      expect(t.sizeX).toBeLessThanOrEqual(s.maxBed);
      expect(t.sizeY).toBeLessThanOrEqual(s.maxBed);
      expect(t.oversize).toBe(false);
    }
    checkInvariants(res, s);
  });

  it('handles quantities above one', () => {
    const s = settings();
    const res = solve([part({ poly: rect(30, 20), qty: 5 })], s);
    expect(res.trays.flatMap((t) => t.parts)).toHaveLength(5);
    checkInvariants(res, s);
  });

  it('returns cleanly with no parts', () => {
    const res = solve([], settings());
    expect(res.trays).toHaveLength(0);
    expect(res.stats.stackHeight).toBe(0);
  });
});

describe('rotation', () => {
  it('turns an off-axis outline to its minimum-area orientation', () => {
    const s = settings({ allowRotation: true });
    const diag: Poly = [[[0, 0], [70, 70], [66, 74], [-4, 4]]];
    const res = solve([part({ poly: diag })], s);
    expect(res.unplaced).toHaveLength(0);
    const t = res.trays[0];
    // Unrotated this needs a 74 x 78 mm envelope, i.e. 4 x 4 cells.
    expect(t.cellsX * t.cellsY).toBeLessThan(16);
    checkInvariants(res, s);
  });
});
