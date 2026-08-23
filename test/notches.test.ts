import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import type { PartInput, Poly, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { initCad, cad } from '../src/lib/cad/manifold';
import { REG } from '../src/lib/cad/profile';
import { buildTrayMesh } from '../src/lib/cad/tray';
import { buildInsertMesh } from '../src/lib/cad/insert';
import { solve } from '../src/lib/solver/solve';
import {
  autoPlacePair, alignOppositeT, nearestT, pointAtT, resolveTrayNotches,
} from '../src/lib/solver/notches';
import { rotateRing, translateRing } from '../src/lib/geom2d';

const require = createRequire(import.meta.url);
beforeAll(async () => { await initCad(require.resolve('manifold-3d/manifold.wasm')); }, 120000);

const rect = (w: number, h: number): Poly => [[[0, 0], [w, 0], [w, h], [0, h]]];

let seq = 0;
const part = (over: Partial<PartInput> = {}): PartInput => ({
  id: `p${seq++}`, name: `P${seq}`, poly: rect(60, 40), keepHoles: false, depth: 20,
  qty: 1, groupId: null, sourceFile: '', notes: [], sourceUnitMm: 1, unitOverrideMm: null,
  unitsAmbiguous: false, fingerNotches: [], ...over,
});
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('arc parameterization', () => {
  it('round-trips and survives rigid motion', () => {
    const ring = rect(60, 40)[0];
    for (const t of [0.05, 0.3, 0.62, 0.9]) {
      const p = pointAtT(ring, t);
      expect(nearestT(ring, p)).toBeCloseTo(t, 4);
      // The same t must land on the same physical spot after the ring is
      // rotated and moved, which is what makes stored notches stable.
      const moved = translateRing(rotateRing(ring, 1.1), 33, -12);
      const q = pointAtT(moved, t);
      const back = [
        (q[0] - 33) * Math.cos(-1.1) - (q[1] + 12) * Math.sin(-1.1),
        (q[0] - 33) * Math.sin(-1.1) + (q[1] + 12) * Math.cos(-1.1),
      ];
      expect(back[0]).toBeCloseTo(p[0], 3);
      expect(back[1]).toBeCloseTo(p[1], 3);
    }
  });
});

describe('auto placement', () => {
  it('places an opposite pair across the width of a lone part', () => {
    const s = settings({ thumbNotches: false });
    const res = solve([part({ poly: rect(80, 50), depth: 20 })], s);
    const tray = res.trays[0];
    const placed = tray.parts[0];
    const pair = autoPlacePair({ tray, part: placed, settings: s })!;
    expect(pair).not.toBeNull();
    const pa = pointAtT(placed.poly[0], pair.a);
    const pb = pointAtT(placed.poly[0], pair.b);
    // Opposite: the two points straddle the centroid...
    const cx = placed.bbox.x + placed.bbox.w / 2;
    const cy = placed.bbox.y + placed.bbox.h / 2;
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    expect(Math.hypot(mid[0] - cx, mid[1] - cy)).toBeLessThan(d * 0.25);
    // ...across the shorter dimension, whichever way the solver oriented the
    // part: the pair's separation matches the pocket's smaller extent.
    expect(d).toBeLessThan(Math.min(placed.bbox.w, placed.bbox.h) + 2);
    expect(d).toBeGreaterThan(Math.min(placed.bbox.w, placed.bbox.h) - 6);
    // 'a' reads as the left/lower-x notch.
    expect(pa[0]).toBeLessThanOrEqual(pb[0] + 1e-6);
  });

  it('aligns the partner opposite a dragged notch', () => {
    const s = settings({ thumbNotches: false });
    const res = solve([part({ poly: rect(80, 50), depth: 20 })], s);
    const tray = res.trays[0];
    const placed = tray.parts[0];
    const ctx = { tray, part: placed, settings: s };
    const pair = autoPlacePair(ctx)!;
    const dragged = (pair.a + 0.13) % 1;
    const opposite = alignOppositeT(ctx, dragged)!;
    expect(opposite).not.toBeNull();
    const pd = pointAtT(placed.poly[0], dragged);
    const po = pointAtT(placed.poly[0], opposite);
    const cx = placed.bbox.x + placed.bbox.w / 2;
    const cy = placed.bbox.y + placed.bbox.h / 2;
    const a1 = Math.atan2(pd[1] - cy, pd[0] - cx);
    const a2 = Math.atan2(po[1] - cy, po[0] - cx);
    let diff = Math.abs(a1 - a2);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    expect(diff).toBeGreaterThan(Math.PI * 0.6);
  });

  it('returns null when no pair can physically fit', () => {
    // Notches wider than the pocket can separate them: no valid pair exists.
    const s = settings({ thumbNotches: false, fingerNotchRadius: 40 });
    const res = solve([part({ poly: rect(30, 20), depth: 10 })], s);
    const tray = res.trays[0];
    expect(autoPlacePair({ tray, part: tray.parts[0], settings: s })).toBeNull();
  });

  it('avoids the wall shared with a neighbouring pocket', () => {
    const s = settings({ thumbNotches: false });
    const res = solve([part({ poly: rect(60, 40) }), part({ poly: rect(60, 40) })], s);
    const tray = res.trays[0];
    expect(tray.parts).toHaveLength(2);
    for (const placed of tray.parts) {
      const pair = autoPlacePair({ tray, part: placed, settings: s })!;
      expect(pair).not.toBeNull();
      const other = tray.parts.find((p) => p !== placed)!;
      for (const t of [pair.a, pair.b]) {
        const pt = pointAtT(placed.poly[0], t);
        // Each chosen spot keeps a full notch radius plus wall away from the
        // neighbouring pocket.
        const b = other.bbox;
        const dx = Math.max(b.x - pt[0], 0, pt[0] - (b.x + b.w));
        const dy = Math.max(b.y - pt[1], 0, pt[1] - (b.y + b.h));
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(s.fingerNotchRadius + s.wall - 1e-6);
      }
    }
  });
});

describe('resolution and blocking', () => {
  it('keeps an invalid hand-placed notch and blocks the tray', () => {
    const s = settings({ thumbNotches: false });
    const a = part({ poly: rect(60, 40), name: 'left', depth: 20 });
    const b = part({ poly: rect(60, 40), name: 'right', depth: 20 });
    const first = solve([a, b], s);
    const tray = first.trays[0];
    expect(tray.parts).toHaveLength(2);

    // Place the left part's notch pair directly at the wall shared with the
    // right part, which cannot be valid.
    const left = tray.parts.find((p) => p.name === 'left')!;
    const right = tray.parts.find((p) => p.name === 'right')!;
    const towards: [number, number] = [
      right.bbox.x + right.bbox.w / 2, right.bbox.y + right.bbox.h / 2,
    ];
    const tBad = nearestT(left.poly[0], towards);
    a.fingerNotches = [{ instance: 0, a: tBad, b: (tBad + 0.5) % 1 }];

    const res = solve([a, b], s);
    const t2 = res.trays[0];
    const resolved = t2.parts.find((p) => p.name === 'left')!.fingerNotches!;
    expect(resolved.some((n) => !n.valid)).toBe(true);
    // The position is preserved, not nudged.
    expect(resolved.find((n) => n.key === 'a')!.t).toBeCloseTo(tBad, 6);
    expect(t2.blocked).toBe(true);
    expect(t2.warnings.join(' ')).toMatch(/finger notch/);
    expect(res.warnings.join(' ')).toMatch(/withheld/);
  });

  it('a valid pair resolves on both copies independently', () => {
    const s = settings({ thumbNotches: false });
    const p1 = part({ poly: rect(60, 40), qty: 2, depth: 20 });
    const probe = solve([p1], s);
    const tray = probe.trays[0];
    const first = tray.parts.find((x) => x.instance === 0)!;
    const pair = autoPlacePair({ tray, part: first, settings: s })!;
    p1.fingerNotches = [{ instance: 0, ...pair }];

    const res = solve([p1], s);
    const t = res.trays[0];
    expect(t.blocked).toBe(false);
    const inst0 = t.parts.find((x) => x.instance === 0)!;
    const inst1 = t.parts.find((x) => x.instance === 1)!;
    expect(inst0.fingerNotches).toHaveLength(2);
    expect(inst0.fingerNotches!.every((n) => n.valid)).toBe(true);
    expect(inst1.fingerNotches).toBeUndefined();
  });
});

describe('notch geometry', () => {
  function solvedWithNotches() {
    const s = settings({ thumbNotches: false });
    const p1 = part({ poly: rect(80, 50), depth: 20 });
    const probe = solve([p1], s);
    const pair = autoPlacePair({ tray: probe.trays[0], part: probe.trays[0].parts[0], settings: s })!;
    p1.fingerNotches = [{ instance: 0, ...pair }];
    const res = solve([p1], s);
    return { s, tray: res.trays[0] };
  }

  it('cuts the scallop to the pocket floor and stays watertight', () => {
    const { s, tray } = solvedWithNotches();
    const placed = tray.parts[0];
    const n = placed.fingerNotches!.find((x) => x.key === 'a')!;
    const mesh = buildTrayMesh(tray, s);
    const { Manifold, Mesh } = cad();
    const solid = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
    expect(solid.status()).toBe('NoError');

    const topRef = tray.height - REG.height;
    // Just outside the pocket wall at the notch centre, half a radius out:
    // below the pocket floor there must be material, above it none.
    const c = [placed.bbox.x + placed.bbox.w / 2, placed.bbox.y + placed.bbox.h / 2];
    const dir = [n.x - c[0], n.y - c[1]];
    const len = Math.hypot(dir[0], dir[1]);
    const px = n.x + (dir[0] / len) * (s.fingerNotchRadius / 2);
    const py = n.y + (dir[1] / len) * (s.fingerNotchRadius / 2);
    const probeAt = (z: number) =>
      Manifold.cube([1.5, 1.5, 0.4], true).translate(px, py, z).intersect(solid).volume();
    expect(probeAt(topRef - placed.depth - 0.5)).toBeGreaterThan(0.5); // floor intact below
    expect(probeAt(topRef - placed.depth + 1.0)).toBeLessThan(0.01);   // scallop cut just above
    expect(probeAt(topRef - 1.0)).toBeLessThan(0.01);                  // open at the top
  });

  it('opens the liner at the notch', () => {
    const { s, tray } = solvedWithNotches();
    const placed = tray.parts[0];
    const n = placed.fingerNotches!.find((x) => x.key === 'a')!;
    const ins = buildInsertMesh(placed, s)!;
    const { Manifold, Mesh } = cad();
    const solid = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: ins.mesh.positions, triVerts: ins.mesh.indices }));
    // The liner must have nothing left within the notch opening.
    const cyl = Manifold.cylinder(ins.height + 4, s.fingerNotchRadius, s.fingerNotchRadius, 32)
      .translate(n.x, n.y, -2);
    expect(solid.intersect(cyl).volume()).toBeLessThan(0.05);
    expect(solid.volume()).toBeGreaterThan(0);
  });
});
