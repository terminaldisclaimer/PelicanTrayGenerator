import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { toManifold } from '../src/geom/analyze';
import { CableError, DEFAULT_CABLE, defaultConnectorAxis, orientConnector, placeConnector, solveCable, tubeMesh, type CableSpec, type LeadSpec } from '../src/geom/cable';
import { boxMesh } from './fixtures';

let k: ManifoldToplevel;
beforeAll(async () => { k = await initKernel(); });

const pathLength = (p: number[][]) => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);
const bounds = (p: number[][]) => [0, 1, 2].map((a) => [Math.min(...p.map((q) => q[a])), Math.max(...p.map((q) => q[a]))]);

describe('cable coil', () => {
  const lead = (o: Partial<LeadSpec>): LeadSpec => ({ style: 'end', end: 'left', length: 30, jWidth: 20, connector: null, ...o });

  it('the script defaults: exact length, stacked turns, footprint flexed by a few mm', () => {
    const c = solveCable(DEFAULT_CABLE);
    // The polyline cuts corners slightly, so it comes out a hair short of the true length.
    expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997);
    expect(pathLength(c.path)).toBeLessThanOrEqual(1151 + 0.01);
    expect(Math.abs(c.footprint.length - 115)).toBeLessThan(12);
    expect(c.footprint.width).toBe(40);
    expect(c.footprint.height).toBeCloseTo(c.turns * 6.2 + 6, 0); // turns sit 6.2 mm apart
    expect(c.turns).toBeGreaterThan(3);
    // The coil stays inside its footprint; only the J sticks out, past the far long side, by its width less one cable.
    const [bx, by, bz] = bounds(c.path);
    expect(bx[1] - bx[0]).toBeLessThanOrEqual(c.footprint.length - 6 + 1e-6);
    expect(by[0]).toBeCloseTo(-17, 3);
    expect(by[1]).toBeCloseTo(17 + 14, 3);
    expect(bz[0]).toBeCloseTo(0, 6);
    // J: leaves the top turn, its free end 50 mm from the left end, pointing at the far (right) end.
    expect(c.ends.top.at[2]).toBeCloseTo(bz[1], 6);
    expect(c.ends.top.dir.map((v) => Math.round(v) + 0)).toEqual([1, 0, 0]);
    expect(c.ends.top.at[0]).toBeCloseTo(-c.footprint.length / 2 + 50, 3);
    // Inside lead: on the long axis, in the hollow, on the bottom turn.
    expect(c.ends.bottom.at[1]).toBeCloseTo(0, 6);
    expect(Math.abs(c.ends.bottom.at[0])).toBeLessThan(c.hollow.length / 2);
    expect(c.ends.bottom.at[2]).toBeCloseTo(0, 6);
  });

  it('each end can leave the coil its own way: in line, sideways, as a J, into the middle, or not at all', () => {
    const make = (top: Partial<LeadSpec>, bottom: Partial<LeadSpec>, more: Partial<CableSpec> = {}) => solveCable({ ...DEFAULT_CABLE, ...more, top: lead(top), bottom: lead(bottom) });
    const dirOf = (e: { dir: number[] }) => e.dir.map((v) => Math.round(v) + 0);
    // In line with the coil: straight on past the end, along the long side it was running on.
    const inline = make({ style: 'end', end: 'right', length: 30 }, { style: 'end', end: 'left', length: 40 });
    expect(dirOf(inline.ends.top)).toEqual([1, 0, 0]);
    expect(inline.ends.top.at[0]).toBeCloseTo(inline.footprint.length / 2 - 3 - 12 + 30, 3); // 30 mm on from where the corner starts
    expect(Math.abs(inline.ends.top.at[1])).toBeCloseTo(17, 3); // still on the long side's line
    expect(dirOf(inline.ends.bottom)).toEqual([-1, 0, 0]);
    expect(inline.ends.bottom.at[0]).toBeCloseTo(-(inline.footprint.length / 2 - 3 - 12 + 40), 3);
    // With this winding both sit on the same long side; winding it the other way puts them on the other.
    expect(Math.sign(inline.ends.top.at[1])).toBe(Math.sign(inline.ends.bottom.at[1]));
    const other = make({ style: 'end', end: 'right', length: 30 }, { style: 'end', end: 'left', length: 40 }, { mirror: true });
    expect(Math.sign(other.ends.top.at[1])).toBe(-Math.sign(inline.ends.top.at[1]));
    // Sideways: straight out past a long side, from a short end.
    const side = make({ style: 'side', end: 'right', length: 25 }, { style: 'none' });
    expect(Math.abs(side.ends.top.dir[1])).toBeCloseTo(1, 6);
    expect(Math.abs(side.ends.top.at[0])).toBeCloseTo(side.footprint.length / 2 - 3, 3);
    expect(Math.abs(side.ends.top.at[1])).toBeCloseTo(17 - 12 + 25, 3);
    // No lead: the cable just stops on the coil.
    const [sx, sy] = bounds(side.path);
    expect(side.ends.bottom.at[0]).toBeGreaterThanOrEqual(sx[0] - 1e-6);
    expect(Math.abs(side.ends.bottom.at[1])).toBeLessThanOrEqual(17 + 1e-6);
    expect(sy[1] - sy[0]).toBeCloseTo(34 + 13, 3);
    // Both ends into the middle, from opposite ends, each on its own turn.
    const both = make({ style: 'inside', end: 'left', length: 5 }, { style: 'inside', end: 'right', length: 5 });
    expect(both.ends.top.at[1]).toBeCloseTo(0, 6);
    expect(both.ends.bottom.at[1]).toBeCloseTo(0, 6);
    expect(dirOf(both.ends.top)).toEqual([1, 0, 0]);
    expect(dirOf(both.ends.bottom)).toEqual([-1, 0, 0]);
    // A J on the bottom turn at the right end.
    const j = make({ style: 'none' }, { style: 'j', end: 'right', length: 50, jWidth: 20 });
    expect(j.ends.bottom.at[2]).toBeCloseTo(0, 6);
    expect(j.ends.bottom.at[0]).toBeCloseTo(j.footprint.length / 2 - 50, 3);
    expect(dirOf(j.ends.bottom)).toEqual([-1, 0, 0]);
    // Every one of them is exactly the asked length.
    for (const c of [inline, other, side, both, j]) { expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997); expect(pathLength(c.path)).toBeLessThanOrEqual(1151.01); }
    // "Either end" picks whichever changes the coil length least.
    const auto = make({ style: 'j', end: 'left' }, { style: 'inside', end: 'auto', length: 5 });
    const forced = ['left', 'right'].map((e) => make({ style: 'j', end: 'left' }, { style: 'inside', end: e as 'left', length: 5 }));
    expect(Math.abs(auto.footprint.length - 115)).toBeCloseTo(Math.min(...forced.map((f) => Math.abs(f.footprint.length - 115))), 6);
  });

  it('a connector keeps within the height of the stack: the lead climbs or drops to suit', () => {
    const conn = { height: 19, width: 15, length: 40 };
    const c = solveCable({ ...DEFAULT_CABLE, bottom: lead({ style: 'inside', end: 'auto', length: 5, connector: conn }), top: lead({ style: 'end', end: 'right', length: 30, connector: conn }) });
    const stackTop = c.footprint.height - 3; // the bottom turn's centre is z = 0
    expect(c.ends.bottom.at[2] + 19 / 2).toBeCloseTo(stackTop, 3); // inside: top level with the top of the stack
    expect(c.ends.top.at[2] + 19 / 2).toBeCloseTo(stackTop, 3); // top turn, outside: the same
    const low = solveCable({ ...DEFAULT_CABLE, top: lead({ style: 'none' }), bottom: lead({ style: 'end', end: 'left', length: 30, connector: conn }) });
    expect(low.ends.bottom.at[2] - 19 / 2).toBeCloseTo(-3, 3); // bottom turn, outside: bottom level with the bottom of the stack
    expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997);
    // An inside connector has to stay clear of the far end of the coil.
    const tip = c.ends.bottom.at[0] + c.ends.bottom.dir[0] * 40;
    expect(Math.abs(tip)).toBeLessThan(c.hollow.length / 2);
  });

  it('says what is wrong instead of drawing something that cannot be wound', () => {
    expect(() => solveCable({ ...DEFAULT_CABLE, cornerR: 2 })).toThrow(CableError);
    expect(() => solveCable({ ...DEFAULT_CABLE, bottom: lead({ style: 'inside', connector: { height: 19, width: 40, length: 50 } }) })).toThrow(/wider than the hollow/);
    expect(() => solveCable({ ...DEFAULT_CABLE, bottom: lead({ style: 'inside', end: 'auto', connector: { height: 19, width: 19, length: 3000 } }) })).toThrow(/No coil fits/);
    expect(() => solveCable({ ...DEFAULT_CABLE, totalLen: 30 })).toThrow(CableError);
    expect(() => solveCable({ ...DEFAULT_CABLE, top: lead({ style: 'j', jWidth: 8 }) })).toThrow(/at least/);
    // Two leads into the middle from the same end, long enough to meet, would cross.
    expect(() => solveCable({ ...DEFAULT_CABLE, wireD: 12, outerW: 60, cornerR: 15, totalLen: 900, top: lead({ style: 'inside', end: 'left', length: 60 }), bottom: lead({ style: 'inside', end: 'left', length: 60 }) })).not.toThrow(/NaN/);
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
    const end = c.ends.top;
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
