import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import type { PartInput, Poly, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { initCad, cad } from '../src/lib/cad/manifold';
import { REG, LIP_BASE } from '../src/lib/cad/profile';
import { buildTrayMesh } from '../src/lib/cad/tray';
import { solve } from '../src/lib/solver/solve';
import { autoPlacePair, pointAtT } from '../src/lib/solver/notches';
import { placementProblemAt } from '../src/lib/solver/placement';

const require = createRequire(import.meta.url);
beforeAll(async () => { await initCad(require.resolve('manifold-3d/manifold.wasm')); }, 120000);

const rect = (w: number, h: number): Poly => [[[0, 0], [w, 0], [w, h], [0, h]]];
let seq = 0;
const part = (over: Partial<PartInput> = {}): PartInput => ({
  id: `p${seq++}`, name: `P${seq}`, poly: rect(60, 40), keepHoles: false, depth: 20,
  qty: 1, groupId: null, sourceFile: '', notes: [], sourceUnitMm: 1, unitOverrideMm: null,
  unitsAmbiguous: false, fingerNotches: [], placements: [], ...over,
});
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

/** A legal position as far from the packed one as the tray's slack allows. */
function legalTarget(tray: { sizeX: number; sizeY: number }, bbox: { x: number; y: number; w: number; h: number }, s: Settings) {
  const margin = Math.max(s.wall, LIP_BASE);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const x = clamp(bbox.x + 6, margin, tray.sizeX - margin - bbox.w);
  const y = clamp(bbox.y + 4, margin, tray.sizeY - margin - bbox.h);
  // Fall back to the other direction when the packer parked it flush.
  return {
    x: Math.abs(x - bbox.x) > 0.5 ? x : clamp(bbox.x - 6, margin, tray.sizeX - margin - bbox.w),
    y: Math.abs(y - bbox.y) > 0.5 ? y : clamp(bbox.y - 4, margin, tray.sizeY - margin - bbox.h),
  };
}

describe('placement overrides', () => {
  it('moves a copy to the stored position and records the packed one', () => {
    const s = settings({ thumbNotches: false });
    const a = part({ poly: rect(40, 30) });
    const probe = solve([a], s);
    const packed = probe.trays[0].parts[0].bbox;
    const target = legalTarget(probe.trays[0], packed, s);
    expect(Math.hypot(target.x - packed.x, target.y - packed.y)).toBeGreaterThan(1);
    a.placements = [{ instance: 0, ...target }];

    const res = solve([a], s);
    const placed = res.trays[0].parts[0];
    expect(placed.moved).toBe(true);
    expect(placed.bbox.x).toBeCloseTo(target.x, 6);
    expect(placed.bbox.y).toBeCloseTo(target.y, 6);
    expect(placed.packed!.x).toBeCloseTo(packed.x, 6);
    expect(placed.packed!.y).toBeCloseTo(packed.y, 6);
    // The outline moved with the box.
    expect(placed.poly[0].some(([x]) => Math.abs(x - target.x) < 1e-6)).toBe(true);
    expect(res.trays[0].blocked).toBe(false);
  });

  it('keeps an invalid position, flags it, and blocks the tray', () => {
    const s = settings({ thumbNotches: false });
    const a = part({ poly: rect(60, 40), name: 'mover' });
    const b = part({ poly: rect(60, 40), name: 'anchor' });
    const probe = solve([a, b], s);
    const tray = probe.trays[0];
    expect(tray.parts).toHaveLength(2);
    const anchor = tray.parts.find((p) => p.name === 'anchor')!;
    // Park the mover directly on top of the anchor.
    a.placements = [{ instance: 0, x: anchor.bbox.x, y: anchor.bbox.y }];

    const res = solve([a, b], s);
    const t = res.trays[0];
    const mover = t.parts.find((p) => p.name === 'mover')!;
    expect(mover.bbox.x).toBeCloseTo(anchor.bbox.x, 6); // kept, not nudged
    expect(mover.placementProblem).toMatch(/too close to the anchor/);
    expect(t.blocked).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/withheld/);
  });

  it('rejects a position outside the usable area', () => {
    const s = settings({ thumbNotches: false });
    const res0 = solve([part({ poly: rect(40, 30) })], s);
    const tray = res0.trays[0];
    const p0 = tray.parts[0];
    expect(placementProblemAt(tray, p0, s, 0.5, p0.bbox.y)).toMatch(/outside/);
    expect(placementProblemAt(tray, p0, s, Math.max(s.wall, LIP_BASE), p0.bbox.y)).toBeNull();
  });

  it('notches follow a moved part', () => {
    const s = settings({ thumbNotches: false });
    const a = part({ poly: rect(80, 50) });
    const probe = solve([a], s);
    const tray0 = probe.trays[0];
    const pair = autoPlacePair({ tray: tray0, part: tray0.parts[0], settings: s })!;
    const before = pointAtT(tray0.parts[0].poly[0], pair.a);
    const packed = tray0.parts[0].bbox;
    const target = legalTarget(tray0, packed, s);
    a.fingerNotches = [{ instance: 0, ...pair }];
    a.placements = [{ instance: 0, ...target }];

    const res = solve([a], s);
    const placed = res.trays[0].parts[0];
    const na = placed.fingerNotches!.find((n) => n.key === 'a')!;
    // Same arc position, translated exactly with the outline.
    expect(na.x).toBeCloseTo(before[0] + (target.x - packed.x), 3);
    expect(na.y).toBeCloseTo(before[1] + (target.y - packed.y), 3);
    expect(na.valid).toBe(true);
    expect(res.trays[0].blocked).toBe(false);
  });

  it('the pocket is cut at the moved position, not the packed one', () => {
    const s = settings({ thumbNotches: false });
    const a = part({ poly: rect(40, 30), depth: 15 });
    const probe = solve([a], s);
    const packed = probe.trays[0].parts[0].bbox;
    const target = legalTarget(probe.trays[0], packed, s);
    expect(Math.abs(target.x - packed.x)).toBeGreaterThan(3);
    a.placements = [{ instance: 0, x: target.x, y: packed.y }];
    const res = solve([a], s);
    const tray = res.trays[0];
    const placed = tray.parts[0];

    const mesh = buildTrayMesh(tray, s);
    const { Manifold, Mesh } = cad();
    const solid = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
    expect(solid.status()).toBe('NoError');
    const z = tray.height - REG.height - placed.depth / 2;
    const probeAt = (x: number, y: number) =>
      Manifold.cube([1.2, 1.2, 0.6], true).translate(x, y, z).intersect(solid).volume();
    // Centre of the moved pocket: empty. The vacated strip on the packed
    // side: solid wall again.
    expect(probeAt(placed.bbox.x + placed.bbox.w / 2, placed.bbox.y + placed.bbox.h / 2)).toBeLessThan(0.01);
    // The strip the pocket vacated on the packed side is solid wall again.
    const vacatedX = target.x > packed.x ? packed.x + 1.5 : packed.x + placed.bbox.w - 1.5;
    expect(probeAt(vacatedX, packed.y + placed.bbox.h / 2)).toBeGreaterThan(0.4);
  });
});
