import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { toManifold } from '../src/geom/analyze';
import { CableError, DEFAULT_CABLE, defaultConnectorAxis, orientConnector, placeConnector, solveCable, tubeMesh, type CableSpec } from '../src/geom/cable';
import { boxMesh } from './fixtures';

let k: ManifoldToplevel;
beforeAll(async () => { k = await initKernel(); });

const pathLength = (p: number[][]) => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);
const bounds = (p: number[][]) => [0, 1, 2].map((a) => [Math.min(...p.map((q) => q[a])), Math.max(...p.map((q) => q[a]))]);

describe('cable coil', () => {
  it('the script defaults: exact length, stacked turns, footprint flexed by a few mm', () => {
    const c = solveCable(DEFAULT_CABLE);
    // The polyline cuts corners slightly, so it comes out a hair short of the true length.
    expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997);
    expect(pathLength(c.path)).toBeLessThanOrEqual(1151 + 0.01);
    expect(Math.abs(c.footprint.length - 115)).toBeLessThan(12);
    expect(c.footprint.width).toBe(40);
    // Turns sit on top of each other 6.2 mm apart, and the peel-off needs a whole number of half turns plus a bit.
    expect(c.footprint.height).toBeCloseTo(c.turns * 6.2 + 6, 0);
    expect(c.turns).toBeGreaterThan(3);
    // The coil itself stays inside its footprint; only the outside lead sticks out past one long side.
    const [bx, by, bz] = bounds(c.path);
    expect(bx[1] - bx[0]).toBeLessThanOrEqual(c.footprint.length - 6 + 1e-6);
    expect(by[1] - by[0]).toBeCloseTo(40 - 6 + (20 - 6), 3); // J sticks out by J width − cable diameter
    expect(bz[0]).toBeCloseTo(0, 6);
  });

  it('the outside lead goes where it is told, and leaves from the top turn with nothing above it', () => {
    const at = (j: Partial<NonNullable<CableSpec['j']>>) => solveCable({ ...DEFAULT_CABLE, j: { ...DEFAULT_CABLE.j!, ...j } });
    const a = at({ end: 'left', side: 'top', layer: 'top' });
    const top = Math.max(...a.path.map((p) => p[2]));
    expect(a.ends.outside!.at[2]).toBeCloseTo(top, 6); // on the top turn
    expect(a.ends.outside!.at[1]).toBeGreaterThan(20); // past the "top" long side (+Y)
    expect(a.ends.outside!.dir).toEqual([1, 0, 0]); // free end points toward the far (right) end
    expect(a.ends.outside!.at[0]).toBeCloseTo(-a.footprint.length / 2 + 50, 3); // 50 mm long from the left end
    const b = at({ end: 'right', side: 'bottom', layer: 'bottom' });
    expect(b.ends.outside!.at[2]).toBeCloseTo(0, 6);
    expect(b.ends.outside!.at[1]).toBeLessThan(-20);
    expect(b.ends.outside!.dir).toEqual([-1, 0, 0]);
    // The centre lead ends on the long axis, inside the hollow, at the other end of the stack.
    expect(a.ends.center.at[1]).toBeCloseTo(0, 6);
    expect(Math.abs(a.ends.center.at[0])).toBeLessThan(a.hollow.length / 2);
    expect(a.ends.center.at[2]).toBeCloseTo(0, 6);
  });

  it('a centre connector makes the lead climb so the connector top is level with the top of the stack', () => {
    const c = solveCable({ ...DEFAULT_CABLE, din: { diameter: 19, above: 0, length: 50 } });
    const stackTop = c.footprint.height - 3; // z of the top of the stack (bottom turn's centre is z = 0)
    expect(c.ends.center.at[2] + 19 / 2).toBeCloseTo(stackTop, 3);
    expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997);
    // The connector has to stay clear of the far end of the coil.
    const tip = c.ends.center.at[0] + c.ends.center.dir[0] * 50;
    expect(Math.abs(tip)).toBeLessThan(c.hollow.length / 2);
  });

  it('says what is wrong instead of drawing something that cannot be wound', () => {
    expect(() => solveCable({ ...DEFAULT_CABLE, cornerR: 2 })).toThrow(CableError);
    expect(() => solveCable({ ...DEFAULT_CABLE, din: { diameter: 19, above: 0, length: 50, width: 40 } })).toThrow(/wider than the hollow/);
    expect(() => solveCable({ ...DEFAULT_CABLE, din: { diameter: 19, above: 0, length: 300 } })).toThrow(/No coil fits/);
    expect(() => solveCable({ ...DEFAULT_CABLE, totalLen: 30 })).toThrow(CableError);
    expect(() => solveCable({ ...DEFAULT_CABLE, j: { ...DEFAULT_CABLE.j!, width: 8 } })).toThrow(/at least/);
    // No outside lead is fine.
    expect(solveCable({ ...DEFAULT_CABLE, j: null }).ends.outside).toBeNull();
  });

  it('the cable is a closed solid of the right volume, and a connector lands on its end', () => {
    const c = solveCable(DEFAULT_CABLE);
    const tube = tubeMesh(c.path, 6);
    const solid = toManifold(k, tube)!;
    expect(solid).not.toBeNull();
    // A 12-sided tube has 95.5% of a round one's area.
    expect(solid.volume() / (Math.PI * 9 * 1151)).toBeGreaterThan(0.94);
    expect(solid.volume() / (Math.PI * 9 * 1151)).toBeLessThan(1.0);
    solid.delete();
    // A 30 × 12 × 8 plug: its long side runs along the cable by default.
    const plug = boxMesh(12, 30, 8, 'plug');
    expect(defaultConnectorAxis(plug)).toBe(2); // +Y
    const o = orientConnector(plug, 2, 0);
    expect([o.length, o.width, o.height].map((v) => +v.toFixed(3))).toEqual([30, 8, 12]);
    const rolled = orientConnector(plug, 2, 1);
    expect([rolled.length, rolled.width, rolled.height].map((v) => +v.toFixed(3))).toEqual([30, 12, 8]);
    const end = c.ends.outside!;
    const placed = placeConnector(o, end, 'plug', 0);
    const pts: number[][] = [];
    for (let i = 0; i < placed.positions.length; i += 3) pts.push([...placed.positions.slice(i, i + 3)]);
    const [bx, by, bz] = bounds(pts);
    expect(bx[0]).toBeCloseTo(end.at[0], 3); // starts at the cable's end and runs on from it
    expect(bx[1]).toBeCloseTo(end.at[0] + 30, 3);
    expect((by[0] + by[1]) / 2).toBeCloseTo(end.at[1], 3); // centred on the cable
    expect((bz[0] + bz[1]) / 2).toBeCloseTo(end.at[2], 3);
    // Turning it never mirrors it: still a solid with positive volume.
    for (let axis = 0; axis < 6; axis++) {
      const m = toManifold(k, placeConnector(orientConnector(plug, axis, 1), end, 'plug'))!;
      expect(m.volume()).toBeCloseTo(12 * 30 * 8, 0);
      m.delete();
    }
  });
});
