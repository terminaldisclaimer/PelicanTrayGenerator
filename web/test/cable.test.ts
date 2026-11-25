import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { toManifold } from '../src/geom/analyze';
import { CableError, connectorOutline, connectorReach, DEFAULT_CABLE, defaultConnectorAxis, orientConnector, placeConnector, leadTip, nearestAt, presetLead, solveCable, tubeMesh, type CableSpec, type LeadPreset, type LeadSpec } from '../src/geom/cable';
import { boxMesh } from './fixtures';

let k: ManifoldToplevel;
beforeAll(async () => { k = await initKernel(); });

const pathLength = (p: number[][]) => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);
const bounds = (p: number[][]) => [0, 1, 2].map((a) => [Math.min(...p.map((q) => q[a])), Math.max(...p.map((q) => q[a]))]);

describe('cable coil', () => {
  const lead = (kind: LeadPreset, top: boolean, end: 'left' | 'right', length = 30, more: Partial<LeadSpec> = {}, base: Partial<CableSpec> = {}): LeadSpec =>
    ({ ...presetLead(kind, top, end, { ...DEFAULT_CABLE, ...base }, length, { width: 20, length }), connector: null, ...more });
  const make = (top: LeadSpec, bottom: LeadSpec, more: Partial<CableSpec> = {}) => solveCable({ ...DEFAULT_CABLE, ...more, top, bottom });
  const dirOf = (e: { dir: number[] }) => e.dir.map((v) => Math.round(v) + 0);

  it('the script defaults: exact length, stacked turns, a J on top and a lead into the middle below', () => {
    const c = solveCable(DEFAULT_CABLE);
    // The polyline cuts corners slightly, so it comes out a hair short of the true length.
    expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997);
    expect(pathLength(c.path)).toBeLessThanOrEqual(1151 + 0.01);
    expect(Math.abs(c.footprint.length - 115)).toBeLessThan(18);
    expect(c.footprint.width).toBe(40);
    expect(c.footprint.height).toBeCloseTo(c.turns * 6.2 + 6, 0); // turns sit 6.2 mm apart
    expect(c.turns).toBeGreaterThan(3);
    // The coil stays inside its footprint; only the J sticks out, past the far long side, by its width less one cable.
    const [bx, by, bz] = bounds(c.path);
    expect(bx[1] - bx[0]).toBeLessThanOrEqual(c.footprint.length - 6 + 1e-6);
    expect(by[0]).toBeCloseTo(-17, 3);
    expect(by[1]).toBeCloseTo(17 + 14, 3);
    expect(bz[0]).toBeCloseTo(0, 6);
    // J: leaves the top turn, its bottom level with the left end, its free end 50 mm from there, pointing at the far end.
    expect(c.ends.top.at[2]).toBeCloseTo(bz[1], 6);
    expect(dirOf(c.ends.top)).toEqual([1, 0, 0]);
    expect(bx[0]).toBeCloseTo(-(c.footprint.length - 6) / 2, 3);
    expect(c.ends.top.at[0]).toBeCloseTo(-c.footprint.length / 2 + 50, 3);
    // Into the middle: on the long axis, in the hollow, on the bottom turn.
    expect(c.ends.bottom.at[1]).toBeCloseTo(0, 6);
    expect(Math.abs(c.ends.bottom.at[0])).toBeLessThan(c.hollow.length / 2);
    expect(c.ends.bottom.at[2]).toBeCloseTo(0, 6);
  });

  it('ready-made leads: in line, sideways, J, into the middle, none, at either end and on either turn', () => {
    // In line with the coil: straight on past the end, along the long side it was running on.
    const inline = make(lead('inline', true, 'right', 30), lead('inline', false, 'left', 40));
    expect(dirOf(inline.ends.top)).toEqual([1, 0, 0]);
    expect(inline.ends.top.at[0]).toBeCloseTo(inline.footprint.length / 2 - 3 - 12 + 30, 3); // 30 mm on from where the corner starts
    expect(Math.abs(inline.ends.top.at[1])).toBeCloseTo(17, 3);
    expect(dirOf(inline.ends.bottom)).toEqual([-1, 0, 0]);
    expect(inline.ends.bottom.at[0]).toBeCloseTo(-(inline.footprint.length / 2 - 3 - 12 + 40), 3);
    // With this winding both sit on the same long side; winding it the other way puts them on the other.
    expect(Math.sign(inline.ends.top.at[1])).toBe(Math.sign(inline.ends.bottom.at[1]));
    const other = make(lead('inline', true, 'right', 30), lead('inline', false, 'left', 40), { mirror: true });
    expect(Math.sign(other.ends.top.at[1])).toBe(-Math.sign(inline.ends.top.at[1]));
    // Sideways: straight out past a long side, from a short end.
    const side = make(lead('side', true, 'right', 25), lead('none', false, 'left'));
    expect(Math.abs(side.ends.top.dir[1])).toBeCloseTo(1, 6);
    expect(Math.abs(side.ends.top.at[0])).toBeCloseTo(side.footprint.length / 2 - 3, 3);
    expect(Math.abs(side.ends.top.at[1])).toBeCloseTo(17 - 12 + 25, 3);
    const [, sy] = bounds(side.path);
    expect(sy[1] - sy[0]).toBeCloseTo(34 + 13, 3); // nothing else sticks out
    // Both ends into the middle, from opposite ends, each on its own turn.
    const both = make(lead('middle', true, 'left', 5), lead('middle', false, 'right', 5));
    expect(both.ends.top.at[1]).toBeCloseTo(0, 6);
    expect(both.ends.bottom.at[1]).toBeCloseTo(0, 6);
    expect(dirOf(both.ends.top)).toEqual([1, 0, 0]);
    expect(dirOf(both.ends.bottom)).toEqual([-1, 0, 0]);
    // A J on the bottom turn at the right end.
    const j = make(lead('none', true, 'left'), lead('j', false, 'right', 50));
    expect(j.ends.bottom.at[2]).toBeCloseTo(0, 6);
    expect(j.ends.bottom.at[0]).toBeCloseTo(j.footprint.length / 2 - 50, 3);
    expect(dirOf(j.ends.bottom)).toEqual([-1, 0, 0]);
    for (const c of [inline, other, side, both, j]) { expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997); expect(pathLength(c.path)).toBeLessThanOrEqual(1151.01); }
  });

  it('a lead can leave anywhere on the coil and bend through any angle', () => {
    // Half-way along the far long side, bending 45 degrees away from the coil, then 40 mm.
    const c = make({ at: 4.5, stem: 0, angle: -45, radius: 10, length: 40, connector: null }, lead('none', false, 'left'));
    expect(c.leads.top.junction[0]).toBeCloseTo(0, 3);
    expect(c.leads.top.junction[1]).toBeCloseTo(17, 3);
    expect(c.ends.top.dir[0]).toBeCloseTo(-Math.SQRT1_2, 6); // it was heading −X; turned 45 degrees outward (+Y)
    expect(c.ends.top.dir[1]).toBeCloseTo(Math.SQRT1_2, 6);
    // The same sums, done the way the editor does them from the junction, land on the same tip.
    const t = c.leads.top, tip = leadTip(t.junction, t.heading, t.turn, 0, -45, 10, 40);
    expect(tip.at[0]).toBeCloseTo(c.ends.top.at[0], 3);
    expect(tip.at[1]).toBeCloseTo(c.ends.top.at[1], 3);
    // Positive angles go into the hollow: 90 degrees from the middle of the far side heads straight across.
    const inward = make({ at: 4.5, stem: 0, angle: 90, radius: 8, length: 5, connector: null }, lead('none', false, 'left'));
    expect(inward.ends.top.dir[1]).toBeCloseTo(-1, 6);
    expect(Math.abs(inward.ends.top.at[1])).toBeLessThan(17);
    // Wound the other way, the picture is mirrored and the editor's turn sign flips with it.
    const m = make({ at: 4.5, stem: 0, angle: -45, radius: 10, length: 40, connector: null }, lead('none', false, 'left'), { mirror: true });
    expect(m.leads.top.junction[1]).toBeCloseTo(-17, 3);
    expect(m.leads.top.turn).toBe(-c.leads.top.turn);
    const mt = leadTip(m.leads.top.junction, m.leads.top.heading, m.leads.top.turn, 0, -45, 10, 40);
    expect(mt.at[1]).toBeCloseTo(m.ends.top.at[1], 3);
    // A point seen from above maps back to the spot on the coil, snapping to where a corner starts.
    const L = c.footprint.length;
    expect(nearestAt(DEFAULT_CABLE, L, 0, 30)).toBeCloseTo(4.5, 1);
    expect(nearestAt(DEFAULT_CABLE, L, L / 2 - 3 - 12 + 2, -25)).toBe(1); // within 4 mm of the right-near corner start
    expect(nearestAt({ ...DEFAULT_CABLE, mirror: true }, L, 0, -30)).toBeCloseTo(4.5, 1);
    for (const x of [c, inward, m]) expect(pathLength(x.path)).toBeGreaterThan(1151 * 0.997);
  });

  it('a connector keeps within the height of the stack: the lead climbs or drops to suit', () => {
    const conn = { height: 19, width: 15, length: 40 };
    const c = make(lead('inline', true, 'right', 30, { connector: conn }), lead('middle', false, 'left', 5, { connector: conn }));
    const stackTop = c.footprint.height - 3; // the bottom turn's centre is z = 0
    expect(c.ends.bottom.at[2] + 19 / 2).toBeCloseTo(stackTop, 3); // in the hollow: top level with the top of the stack
    expect(c.ends.top.at[2] + 19 / 2).toBeCloseTo(stackTop, 3); // top turn, outside: the same
    const low = make(lead('none', true, 'left'), lead('inline', false, 'left', 30, { connector: conn }));
    expect(low.ends.bottom.at[2] - 19 / 2).toBeCloseTo(-3, 3); // bottom turn, outside: bottom level with the bottom of the stack
    expect(pathLength(c.path)).toBeGreaterThan(1151 * 0.997);
    // A connector in the hollow has to stay clear of the far end of the coil.
    const tip = c.ends.bottom.at[0] + c.ends.bottom.dir[0] * 40;
    expect(Math.abs(tip)).toBeLessThan(c.hollow.length / 2);
  });

  it('refuses what cannot be wound at all, and warns about clashes while still drawing the cable', () => {
    // Impossible outright.
    expect(() => solveCable({ ...DEFAULT_CABLE, cornerR: 2 })).toThrow(CableError);
    expect(() => solveCable({ ...DEFAULT_CABLE, totalLen: 30 })).toThrow(CableError);
    expect(() => make({ at: 1, stem: 0, angle: -180, radius: 2, length: 30, connector: null }, lead('none', false, 'left'))).toThrow(/bend radius/);
    // A sound cable has no warnings.
    expect(solveCable(DEFAULT_CABLE).warnings).toEqual([]);
    // A connector lying across the cable: too wide for the hollow, poking out through the coil, or far too long.
    const wide = make(lead('none', true, 'left'), lead('middle', false, 'left', 5, { connector: { height: 19, width: 40, length: 50 } }));
    expect(wide.warnings).toMatchObject([{ end: 'bottom' }]);
    expect(wide.warnings[0].text).toMatch(/overlaps the coil/);
    expect(wide.path.length).toBeGreaterThan(100); // still drawn
    expect(make({ at: 4.5, stem: 0, angle: 90, radius: 8, length: 2, connector: { height: 10, width: 10, length: 40 } }, lead('none', false, 'left')).warnings).toMatchObject([{ end: 'top' }]);
    expect(make(lead('none', true, 'left'), lead('middle', false, 'left', 5, { connector: { height: 19, width: 19, length: 3000 } })).warnings).toHaveLength(1);
    // The owner's heater coil (106 long, 23 wide) on the default 20 mm J sits 1 mm into the coil; a wider J clears it.
    const heater = { height: 32, width: 23, length: 105.8 };
    expect(make(lead('j', true, 'left', 50, { connector: heater }), lead('middle', false, 'left', 5)).warnings).toMatchObject([{ end: 'top' }]);
    const wider: LeadSpec = { ...presetLead('j', true, 'left', DEFAULT_CABLE, 0, { width: 32, length: 50 }), connector: heater };
    expect(make(wider, lead('middle', false, 'left', 5)).warnings).toEqual([]);
    // A lead bent back across its own coil on the same turn.
    const crossed = make({ at: 0.5, stem: 0, angle: 90, radius: 8, length: 60, connector: null }, lead('none', false, 'left'));
    expect(crossed.warnings).toMatchObject([{ end: null }]);
    expect(crossed.warnings[0].text).toMatch(/crosses itself/);
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
    // How far it reaches to one side, counting only a stretch of its length: a plug with a wide flange at its far end.
    const flanged = { name: 'f', positions: new Float32Array([...Array.from(boxMesh(6, 20, 6, 'body').positions, (v, i) => (i % 3 === 0 ? v + 12 : v)), ...Array.from(boxMesh(30, 4, 6, 'flange').positions, (v, i) => (i % 3 === 1 ? v + 20 : v))]) };
    const fo = orientConnector(flanged, 2, 1); // rolled so the flange sticks out sideways
    expect(fo.length).toBeCloseTo(24, 3);
    const half = fo.width / 2;
    expect(connectorReach(fo, 0, 24, 1)).toBeCloseTo(half, 3); // whole length: the flange counts
    expect(connectorReach(fo, 0, 15, 1)).toBeLessThan(half - 5); // only the slim body is in this stretch
    expect(connectorReach(fo, 0, 15, 1)).toBeCloseTo(connectorReach(fo, 0, 15, -1), 3);
    // Its outline from above follows that shape: slim along the body, wide at the flange.
    const outline = connectorOutline(fo, 2);
    const widthAt = (u: number) => { const vs = outline.filter((q) => Math.abs(q[0] - u) < 1e-6).map((q) => q[1]); return Math.max(...vs) - Math.min(...vs); };
    expect(widthAt(10)).toBeCloseTo(6, 3);
    expect(widthAt(22)).toBeCloseTo(30, 3);
    // Turning it never mirrors it: still a solid with positive volume.
    for (let axis = 0; axis < 6; axis++) {
      const m = toManifold(k, placeConnector(orientConnector(plug, axis, 1), end, 'plug'))!;
      expect(m.volume()).toBeCloseTo(12 * 30 * 8, 0);
      m.delete();
    }
  });
});
