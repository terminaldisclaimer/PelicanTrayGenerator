import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { poseCandidates, posePart, toManifold } from '../src/geom/analyze';
import { buildCavity, DEFAULT_POCKET } from '../src/geom/pocket';
import { autoFingers, buildTrays, DEFAULT_TRAY, distinctPoses, fingerCentre, TrayError, type TrayPart } from '../src/geom/tray';
import { IDENTITY } from '../src/geom/vec';
import { parseSTL, writeSTL } from '../src/mesh/stl';
import { parse3MF } from '../src/mesh/threemf';
import type { TriMesh } from '../src/mesh/types';
import { boxMesh } from './fixtures';

let k: ManifoldToplevel;
beforeAll(async () => { k = await initKernel(); });

function soup(m: Manifold, name = 'part'): TriMesh {
  const mesh = m.getMesh();
  const v = mesh.vertProperties, t = mesh.triVerts, np = mesh.numProp;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = v[t[i] * np + c];
  m.delete();
  return { name, positions: out };
}
const posed = (m: TriMesh) => posePart(k, m, IDENTITY);
const cavityOf = (m: TriMesh, o = DEFAULT_POCKET) => { const p = posed(m); return { p, c: buildCavity(k, p.mesh, p.silhouette, p.height, o) }; };
const sliceArea = (m: Manifold, z: number) => { const s = m.slice(z); const a = s.area(); s.delete(); return a; };
/** Volume of the part that pokes outside the pocket (must be ~0). */
function leftover(part: TriMesh, cavity: Manifold) {
  const solid = toManifold(k, part)!;
  const rest = solid.subtract(cavity);
  const v = rest.volume();
  solid.delete(); rest.delete();
  return v;
}

describe('pocket', () => {
  it('box: one straight step, grown by the clearance, lowered by the floor clearance', () => {
    const { p, c } = cavityOf(boxMesh(40, 20, 10));
    expect(c.formFit).toBe(false);
    expect(c.depth).toBeCloseTo(10.2);
    const b = c.solid.boundingBox();
    expect(b.min[2]).toBeCloseTo(-0.2);
    expect(b.max[0] - b.min[0]).toBeCloseTo(41, 2);
    expect(b.max[1] - b.min[1]).toBeCloseTo(21, 2);
    // Rounded corners: slightly less than the full 41 × 21 rectangle.
    const a = sliceArea(c.solid, 5);
    expect(a).toBeLessThan(41 * 21);
    expect(a).toBeGreaterThan(41 * 21 - 0.25);
    expect(leftover(p.mesh, c.solid)).toBeLessThan(1e-6);
    c.solid.delete();
  });

  it('cone, point down: form-fit below half height, straight above', () => {
    const { p, c } = cavityOf(soup(k.Manifold.cylinder(40, 0.01, 20, 96)));
    expect(c.formFit).toBe(true);
    // Lower zone follows the cone: radius at z=10 is 5 (+0.5 clearance).
    expect(sliceArea(c.solid, 9.9) / (Math.PI * 5.5 ** 2)).toBeCloseTo(1, 1);
    // Upper zone is the full silhouette: radius 20.5 all the way up.
    expect(sliceArea(c.solid, 21) / (Math.PI * 20.5 ** 2)).toBeCloseTo(1, 2);
    expect(sliceArea(c.solid, 39) / (Math.PI * 20.5 ** 2)).toBeCloseTo(1, 2);
    expect(leftover(p.mesh, c.solid)).toBeLessThan(1e-3);
    // Much less material removed than a straight pocket would.
    expect(c.solid.volume()).toBeLessThan(Math.PI * 20.5 ** 2 * 41.2 * 0.7);
    c.solid.delete();
  });

  it('sphere: pocket only ever widens going up, so the part lifts straight out', () => {
    const { p, c } = cavityOf(soup(k.Manifold.sphere(15, 96).translate([0, 0, 15])));
    let prev = 0;
    for (let z = -0.1; z < 30; z += 0.5) {
      const a = sliceArea(c.solid, z);
      expect(a).toBeGreaterThanOrEqual(prev * (1 - 1e-4)); // within outline-simplification tolerance
      prev = a;
    }
    expect(leftover(p.mesh, c.solid)).toBeLessThan(1e-3);
    c.solid.delete();
  });

  it('undercut (wide base, narrow neck): filled in so the base can pass', () => {
    const base = k.Manifold.cylinder(4, 15, 15, 96), neck = k.Manifold.cylinder(30, 4, 4, 48);
    const { p, c } = cavityOf(soup(base.add(neck)), { ...DEFAULT_POCKET, split: 0.9 });
    base.delete(); neck.delete();
    // At neck height, inside the form-fit zone, the pocket is still as wide as the base.
    expect(sliceArea(c.solid, 15) / (Math.PI * 15.5 ** 2)).toBeCloseTo(1, 2);
    expect(leftover(p.mesh, c.solid)).toBeLessThan(1e-3);
    c.solid.delete();
  });

  it('split = 0 gives a plain straight pocket; open meshes fall back to one too', () => {
    const cone = soup(k.Manifold.cylinder(40, 0.01, 20, 64));
    const a = cavityOf(cone, { ...DEFAULT_POCKET, split: 0 });
    expect(a.c.formFit).toBe(false);
    a.c.solid.delete();
    const open = { name: 'open', positions: boxMesh(40, 20, 10).positions.slice(18) };
    const b = cavityOf(open);
    expect(b.c.formFit).toBe(false);
    expect(b.c.solid.volume()).toBeGreaterThan(40 * 20 * 10);
    b.c.solid.delete();
  });

  it('clearance and top margin are honoured', () => {
    const { c } = cavityOf(boxMesh(40, 20, 10), { ...DEFAULT_POCKET, clearance: 1, topMargin: 3 });
    const b = c.solid.boundingBox();
    expect(b.max[0] - b.min[0]).toBeCloseTo(42, 2);
    expect(c.depth).toBeCloseTo(13.2);
    expect(c.top).toBeCloseTo(13);
    c.solid.delete();
  });
});

const trayPart = (m: TriMesh, id: number, fingers: TrayPart['fingers'] = []): TrayPart => {
  const p = posed(m);
  return { partId: id, name: m.name, fingers, poses: [{ poseIndex: 0, mesh: p.mesh, silhouette: p.silhouette, height: p.height }] };
};
const FAST = { ...DEFAULT_TRAY, packAttempts: 24, packAngleStep: 90, searchIterations: 30000, searchRounds: 3 };
/** Point-in-polygon (even-odd over all loops). */
function inside(loops: number[][][], [x, y]: number[]) {
  let hit = false;
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[(i + 1) % l.length];
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) hit = !hit;
  }
  return hit;
}

describe('tray', () => {
  it('builds a watertight tray; depth = deepest pocket + floor; volume adds up', () => {
    const parts = [trayPart(boxMesh(60, 40, 25, 'a'), 1), trayPart(boxMesh(30, 30, 10, 'b'), 2)];
    const { trays } = buildTrays(k, parts, FAST);
    expect(trays).toHaveLength(1);
    const t = trays[0];
    expect(t.depth).toBeCloseTo(25 + 0.2 + 2);
    const solid = toManifold(k, t.mesh)!;
    expect(solid).not.toBeNull();
    const b = solid.boundingBox();
    expect(b.max[0] - b.min[0]).toBeCloseTo(300, 3);
    expect(b.max[1] - b.min[1]).toBeCloseTo(200, 3);
    expect(b.min[2]).toBeCloseTo(0); expect(b.max[2]).toBeCloseTo(27.2);
    const block = 300 * 200 * 27.2 - (4 - Math.PI) * 16 * 27.2;
    const pockets = 61 * 41 * 25.2 + 31 * 31 * 10.2;
    expect(t.volume / (block - pockets)).toBeCloseTo(1, 3);
    // Shallow part sits at the top: its pocket floor is 10.2 below the surface.
    expect(t.placements.find((p) => p.partId === 2)!.z).toBeCloseTo(27.2 - 10);
    // The floor under the deepest pocket is solid.
    expect(sliceArea(solid, 1) / (300 * 200)).toBeCloseTo(1, 2);
    solid.delete();
  });

  it('keeps pockets at least a wall apart and an edge margin from the rim', () => {
    const sizes: [number, number][] = [[60, 40], [50, 30], [45, 45], [70, 20], [30, 30]];
    const parts = sizes.map(([w, h], i) => trayPart(boxMesh(w, h, 10, `p${i}`), i));
    const o = { ...FAST, length: 140, width: 120 };
    const { trays } = buildTrays(k, parts, o);
    expect(trays).toHaveLength(1);
    const boxes = trays[0].placements.map((pl) => {
      const [w, h] = sizes[pl.partId];
      const turned = pl.angle % 180 !== 0;
      const hw = (turned ? h : w) / 2 + 0.5, hh = (turned ? w : h) / 2 + 0.5; // pocket = part + clearance
      return { x0: pl.x - hw, x1: pl.x + hw, y0: pl.y - hh, y1: pl.y + hh };
    });
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(-70 + o.edge - 1e-6); expect(b.x1).toBeLessThanOrEqual(70 - o.edge + 1e-6);
      expect(b.y0).toBeGreaterThanOrEqual(-60 + o.edge - 1e-6); expect(b.y1).toBeLessThanOrEqual(60 - o.edge + 1e-6);
    }
    boxes.forEach((a, i) => boxes.forEach((b, j) => {
      if (j <= i) return;
      const gap = Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);
      expect(gap).toBeGreaterThanOrEqual(o.wall - 1e-6);
    }));
  });

  it('finger cutouts: chosen sides, full depth, swept bowl, extra depth', () => {
    const box = boxMesh(60, 30, 20);
    const sil = posed(box).silhouette;
    expect(fingerCentre(sil, 0.5, 'top')).toEqual([0, 15.5]);
    expect(fingerCentre(sil, 0.5, 'bottom')).toEqual([0, -15.5]);
    expect(fingerCentre(sil, 0.5, 'left')).toEqual([-30.5, 0]);
    expect(fingerCentre(sil, 0.5, 'right')).toEqual([30.5, 0]);
    // Thin parts get one lever hole, taller parts a pinch pair.
    expect(autoFingers(6)).toEqual(['top']);
    expect(autoFingers(20)).toEqual(['top', 'bottom']);

    const tray = (f: TrayPart['fingers'], extra: object = {}) => buildTrays(k, [trayPart(box, 1, f)], { ...FAST, ...extra }).trays[0];
    const straight = { fingerSwept: false };
    const none = tray([], straight), one = tray(['top'], straight), two = tray(['top', 'bottom'], straight), auto = tray('auto', straight);
    // Straight holes reach the pocket floor: half a Ø20 disc outside the pocket × 20.2 mm.
    const half = (Math.PI * 100) / 2 * 20.2;
    expect((none.volume - one.volume) / half).toBeCloseTo(1, 1);
    expect((none.volume - two.volume) / (2 * half)).toBeCloseTo(1, 1);
    expect(auto.volume).toBeCloseTo(two.volume, 3);
    expect(auto.placements[0].fingers).toEqual(['top', 'bottom']);
    expect(tray([]).placements[0].fingers).toEqual([]); // "None" really means none
    expect(tray([]).volume).toBeCloseTo(none.volume, 6);

    // Swept (default): a bowl of the same depth — a quarter ellipsoid lies outside the pocket.
    const swept = tray(['top']);
    const quarter = ((4 / 3) * Math.PI * 10 * 10 * 20.2) / 4;
    expect((none.volume - swept.volume) / quarter).toBeCloseTo(1, 1);
    const s1 = toManifold(k, swept.mesh)!;
    // Full depth right at the pocket edge, shallower further out, gone beyond the rim.
    const at = (y: number, z: number) => { const cut = s1.slice(z).toPolygons(); return inside(cut, [swept.placements[0].x, swept.placements[0].y + y]); };
    expect(at(15.5 + 2, swept.depth - 15)).toBe(false); // hole: no material 2 mm out, 15 mm down
    expect(at(15.5 + 9, swept.depth - 15)).toBe(true); // bowl has curved back in by 9 mm out
    expect(at(15.5 + 9, swept.depth - 2)).toBe(false); // near the surface it is still open at 9 mm
    s1.delete();

    // Extra depth: holes go below the pocket floor and the tray grows to keep its floor.
    const deeper = tray(['top'], { fingerSwept: false, fingerExtraDepth: 5 });
    expect(deeper.depth).toBeCloseTo(one.depth + 5);
    expect(deeper.placements[0].z).toBeCloseTo(one.placements[0].z + 5);
    const s2 = toManifold(k, deeper.mesh)!;
    // 3 mm below the pocket floor the only opening left is the finger hole's full Ø20 disc.
    const open = 300 * 200 - (4 - Math.PI) * 16 - s2.slice(deeper.depth - 20.2 - 3).area();
    expect(open / (Math.PI * 100)).toBeCloseTo(1, 1);
    s2.delete();
    // Parts without finger holes do not make the tray deeper.
    expect(tray([], { fingerExtraDepth: 5 }).depth).toBeCloseTo(none.depth);
  });

  it('chooses another allowed pose when that is what fits', () => {
    // 100×40×8 plate: flat it needs 101 mm of length; on edge (100×8 footprint, 40 tall) too.
    // In a 60×120 tray it must turn 90°; in a 60×60 tray nothing fits.
    const flat = posed(boxMesh(100, 40, 8)), edge = posed(boxMesh(100, 8, 40));
    const part: TrayPart = { partId: 1, name: 'plate', fingers: [], poses: [
      { poseIndex: 0, mesh: flat.mesh, silhouette: flat.silhouette, height: flat.height },
      { poseIndex: 1, mesh: edge.mesh, silhouette: edge.silhouette, height: edge.height },
    ] };
    const a = buildTrays(k, [part], { ...FAST, length: 60, width: 120 }).trays[0];
    expect(a.placements[0].poseIndex).toBe(0); // flat still fits once turned
    expect(a.placements[0].angle % 180).toBe(90);
    const b = buildTrays(k, [part], { ...FAST, length: 30, width: 120 }).trays[0];
    expect(b.placements[0].poseIndex).toBe(1); // only on edge fits a 30 mm wide tray
    expect(b.depth).toBeCloseTo(42.2);
    expect(() => buildTrays(k, [part], { ...FAST, length: 60, width: 60 })).toThrow(/Too big/);
    // A height limit (e.g. the case's inside height) rules out the on-edge pose too.
    expect(() => buildTrays(k, [part], { ...FAST, length: 30, width: 120, maxDepth: 30 })).toThrow(/Too big/);
    expect(buildTrays(k, [part], { ...FAST, length: 60, width: 120, maxDepth: 30 }).trays[0].depth).toBeCloseTo(10.2);
    // A depth limit rules out the on-edge pose.
    expect(() => buildTrays(k, [part], { ...FAST, length: 30, width: 120, depth: 20 })).toThrow(/Too big/);
  });

  it('overflows into a second tray of the same footprint', () => {
    const parts = [0, 1, 2].map((i) => trayPart(boxMesh(80, 60, 10 + i * 10, `p${i}`), i));
    const { trays } = buildTrays(k, parts, { ...FAST, length: 100, width: 140 });
    expect(trays).toHaveLength(2);
    expect(trays.reduce((n, t) => n + t.placements.length, 0)).toBe(3);
  });

  it('stacking: only when needed, within the depth the deepest part sets, until everything fits', () => {
    const A = trayPart(boxMesh(80, 60, 30, 'deep'), 1), B = trayPart(boxMesh(80, 60, 10, 'wide'), 2), C = trayPart(boxMesh(70, 50, 12, 'small'), 3);
    // Plenty of room: side by side, nothing stacked.
    const roomy = buildTrays(k, [A, B, C], { ...FAST, length: 100, width: 220 });
    expect(roomy.trays).toHaveLength(1);
    expect(roomy.stacks).toBe(0);
    expect(roomy.trays[0].placements.every((p) => p.stackSize === 1)).toBe(true);

    // Room for two footprints only: the two shallow parts share one, the tray is no deeper.
    const tight = { ...FAST, length: 100, width: 140 };
    const r = buildTrays(k, [A, B, C], tight);
    expect(r.trays).toHaveLength(1);
    expect(r.stacks).toBe(1);
    const t = r.trays[0];
    expect(t.depth).toBeCloseTo(30.2 + 2); // still set by the deepest part
    const at = (id: number) => t.placements.find((p) => p.partId === id)!;
    expect(at(1).stackSize).toBe(1);
    expect([at(2).level, at(3).level]).toEqual([0, 1]); // bigger footprint on top
    expect(at(2).z).toBeCloseTo(t.depth - 10); // top part flush with the surface
    expect(at(3).z).toBeCloseTo(t.depth - 10.2 - 12); // lower part under the top pocket's floor
    expect(at(3).under).toEqual([2]);
    // Hidden entirely under the wide part: its 71×51 pocket lies within the 81×61 one above.
    expect(Math.abs(at(3).x - at(2).x)).toBeLessThanOrEqual(5.01); expect(Math.abs(at(3).y - at(2).y)).toBeLessThanOrEqual(5.01);
    const solid = toManifold(k, t.mesh)!;
    expect(solid).not.toBeNull();
    // Material removed = three pockets (the lower one sits entirely under the upper one).
    const corners = (4 - Math.PI) * 0.25; // rounded pocket corners, r = 0.5
    const pockets = (81 * 61 - corners) * 30.2 + (81 * 61 - corners) * 10.2 + (71 * 51 - corners) * 12.2;
    const block = 100 * 140 * 32.2 - (4 - Math.PI) * 16 * 32.2;
    expect(t.volume / (block - pockets)).toBeCloseTo(1, 3);
    // Half-way down the lower pocket there are two openings: the deep part's and the small part's.
    const open = 100 * 140 - (4 - Math.PI) * 16 - solid.slice(t.depth - 10.2 - 6).area();
    expect(open / (81 * 61 + 71 * 51)).toBeCloseTo(1, 2);
    solid.delete();

    // Stacking switched off, or a part marked "never stack": overflow into a second tray instead.
    expect(buildTrays(k, [A, B, C], { ...tight, stacking: false }).trays).toHaveLength(2);
    const fixed = buildTrays(k, [A, B, { ...C, stackable: false }], tight);
    expect(fixed.trays).toHaveLength(2);
    expect(fixed.stacks).toBe(0);

    // No room in depth: three equally deep parts cannot stack, so they overflow.
    const same = [1, 2, 3].map((i) => trayPart(boxMesh(80, 60, 20, `p${i}`), i));
    const flat = buildTrays(k, same, tight);
    expect(flat.stacks).toBe(0);
    expect(flat.trays.length).toBe(2);
  });

  it('partial stacking: a part tucked partly under its neighbours still fits and lifts straight out', () => {
    // Two 75×45 pockets (10 deep) fill both rows of a tray that is 27.2 mm deep.
    // An 80×20×8 strip has no room of its own and is too long to hide under one pocket,
    // so it goes partly underneath.
    const parts = [trayPart(boxMesh(75, 45, 10, 'u1'), 1), trayPart(boxMesh(75, 45, 10, 'u2'), 2), trayPart(boxMesh(80, 20, 8, 'strip'), 4)];
    const o = { ...FAST, length: 100, width: 112, depth: 27.2 };
    expect(buildTrays(k, parts, { ...o, stacking: false }).trays).toHaveLength(2);
    const r = buildTrays(k, parts, o);
    expect(r.trays).toHaveLength(1);
    expect(r.stacks).toBe(1);
    const t = r.trays[0];
    expect(t.depth).toBeCloseTo(27.2);
    const strip = t.placements.find((p) => p.partId === 4)!;
    expect(strip.under.length).toBeGreaterThanOrEqual(1);
    expect(strip.z).toBeCloseTo(t.depth - 10.2 - 8); // just below the 10.2-deep pockets above it
    const tray = toManifold(k, t.mesh)!;
    expect(tray).not.toBeNull();
    // Every part sits in clear space, and stays clear as it is lifted straight up and out.
    for (const pl of t.placements) {
      const part = parts.find((p) => p.partId === pl.partId)!.poses[0];
      const solid = toManifold(k, part.mesh)!;
      for (const lift of [0, 4, 12, 30]) {
        const moved = solid.rotate([0, 0, pl.angle]).translate(pl.x, pl.y, pl.z + lift);
        const clash = moved.intersect(tray);
        expect(clash.volume()).toBeLessThan(0.01);
        moved.delete(); clash.delete();
      }
      solid.delete();
    }
    // The parts above keep at least half their floor to rest on.
    for (const id of strip.under) {
      const up = t.placements.find((p) => p.partId === id)!;
      const floor = tray.slice(t.depth - 10.2 - 0.1); // just under the upper pockets' floors
      const probe = k.CrossSection.square([75, 45], true).rotate(up.angle).translate(up.x, up.y);
      const rest = probe.intersect(floor);
      expect(rest.area() / (75 * 45)).toBeGreaterThan(0.45);
      floor.delete(); probe.delete(); rest.delete();
    }
    tray.delete();
  });

  it('the deepest part sets the depth: other parts are not stood on end to squeeze in', () => {
    // A 20 mm deep block sets the depth. Two long plates would fit one tray if stood on edge (40 deep),
    // but that would deepen the tray, so they stay flat and stack instead.
    const plate = (id: number): TrayPart => {
      const flat = posed(boxMesh(100, 40, 8)), edge = posed(boxMesh(100, 8, 40));
      return { partId: id, name: `plate${id}`, fingers: [], poses: [
        { poseIndex: 0, mesh: flat.mesh, silhouette: flat.silhouette, height: flat.height },
        { poseIndex: 1, mesh: edge.mesh, silhouette: edge.silhouette, height: edge.height },
      ] };
    };
    const r = buildTrays(k, [trayPart(boxMesh(100, 40, 20, 'block'), 1), plate(2), plate(3)], { ...FAST, length: 110, width: 100 });
    expect(r.trays).toHaveLength(1);
    expect(r.trays[0].depth).toBeCloseTo(22.2);
    expect(r.trays[0].placements.every((p) => p.poseIndex === 0)).toBe(true);
    expect(r.stacks).toBe(1);
  });

  it('turns unlocked parts to any 90° pose that fits the depth; with a case height, deeper ones too', () => {
    const plate = (id: number, locked = false): TrayPart => {
      const flat = posed(boxMesh(100, 40, 8)), edge = posed(boxMesh(100, 8, 40));
      const poses = [
        { poseIndex: 0, mesh: flat.mesh, silhouette: flat.silhouette, height: flat.height },
        { poseIndex: 1, mesh: edge.mesh, silhouette: edge.silhouette, height: edge.height },
      ];
      return { partId: id, name: `plate${id}`, fingers: [], stackable: false, poses: locked ? poses.slice(0, 1) : poses };
    };
    const block = trayPart(boxMesh(100, 30, 40, 'block'), 1); // 40 deep: sets the depth
    const o = { ...FAST, length: 110, width: 70 };
    // The block needs 40.2; the plates may stand on edge (also 40.2) and then all three fit.
    const r = buildTrays(k, [block, plate(2), plate(3)], o);
    expect(r.trays).toHaveLength(1);
    expect(r.trays[0].depth).toBeCloseTo(42.2);
    expect(r.trays[0].placements.filter((p) => p.poseIndex === 1).length).toBe(2);
    // A plate whose pose is locked flat stays flat, so they no longer fit one tray.
    const locked = buildTrays(k, [block, plate(2, true), plate(3, true)], o);
    expect(locked.trays.length).toBeGreaterThan(1);
    expect(locked.trays.flatMap((t) => t.placements).filter((p) => p.partId !== 1).every((p) => p.poseIndex === 0)).toBe(true);

    // Without a deep part, standing up would deepen the tray a lot (8 -> 40 mm): only done when a case height allows it.
    const two = [plate(2), plate(3)];
    const shallow = { ...FAST, length: 110, width: 50 };
    expect(buildTrays(k, two, shallow).trays).toHaveLength(2); // stay flat (8.2 deep), one per tray
    const tall = buildTrays(k, two, { ...shallow, maxDepth: 60 });
    expect(tall.trays).toHaveLength(1);
    expect(tall.trays[0].depth).toBeCloseTo(42.2);
    expect(buildTrays(k, two, { ...shallow, maxDepth: 30 }).trays).toHaveLength(2); // 42.2 would not fit a 30 mm case
  });

  it('lets the deepest part use a slightly taller orientation when that is what makes everything fit', () => {
    // The big part lies lowest as 100×60×30, but turned over it is 100×50×33: 10 mm narrower, 3 mm taller.
    // Only the narrower way leaves room for the second part beside it in one tray.
    const low = posed(boxMesh(100, 60, 30)), narrow = posed(boxMesh(100, 50, 33));
    const big: TrayPart = { partId: 1, name: 'big', fingers: [], stackable: false, poses: [
      { poseIndex: 0, mesh: low.mesh, silhouette: low.silhouette, height: low.height },
      { poseIndex: 1, mesh: narrow.mesh, silhouette: narrow.silhouette, height: narrow.height },
    ] };
    const other = { ...trayPart(boxMesh(100, 40, 20, 'other'), 2), stackable: false };
    const r = buildTrays(k, [big, other], { ...FAST, length: 110, width: 106 });
    expect(r.trays).toHaveLength(1);
    expect(r.trays[0].placements.find((p) => p.partId === 1)!.poseIndex).toBe(1);
    expect(r.trays[0].depth).toBeCloseTo(33.2 + 2);
    // When the low pose fits anyway, it is kept and the tray stays shallower.
    const roomy = buildTrays(k, [big, other], { ...FAST, length: 110, width: 130 });
    expect(roomy.trays[0].placements.find((p) => p.partId === 1)!.poseIndex).toBe(0);
    expect(roomy.trays[0].depth).toBeCloseTo(30.2 + 2);
  });

  it('keeps mirror-image poses as separate options, drops true duplicates', () => {
    // An L-shaped plate: flipped over it is a mirror image (a different shape to nest); a plain box is not.
    const a = k.Manifold.cube([40, 10, 6]), b = k.Manifold.cube([10, 30, 6]);
    const l = a.add(b);
    const lMesh = l.getMesh();
    const soup = new Float32Array(lMesh.triVerts.length * 3);
    for (let i = 0; i < lMesh.triVerts.length; i++) for (let c = 0; c < 3; c++) soup[i * 3 + c] = lMesh.vertProperties[lMesh.triVerts[i] * lMesh.numProp + c];
    a.delete(); b.delete(); l.delete();
    const pose = (m: TriMesh, r: number[], i: number) => { const p = posePart(k, m, r as never); return { poseIndex: i, mesh: p.mesh, silhouette: p.silhouette, height: p.height }; };
    const FLIP = [1, 0, 0, 0, -1, 0, 0, 0, -1];
    const lPart = { name: 'l', positions: soup };
    expect(distinctPoses([pose(lPart, IDENTITY, 0), pose(lPart, FLIP, 1)])).toHaveLength(2);
    const box = boxMesh(40, 20, 6);
    expect(distinctPoses([pose(box, IDENTITY, 0), pose(box, FLIP, 1)])).toHaveLength(1);
  });

  it('exports as a valid binary STL', () => {
    const t = buildTrays(k, [trayPart(boxMesh(60, 40, 25), 1, 'auto')], FAST).trays[0];
    const back = parseSTL(writeSTL(t.mesh));
    expect(back.positions.length).toBe(t.mesh.positions.length);
    const again = toManifold(k, back)!;
    expect(again.volume() / t.volume).toBeCloseTo(1, 5);
    again.delete();
  });

  it('explains problems instead of producing a bad tray', () => {
    const p = [trayPart(boxMesh(60, 40, 25), 1)];
    expect(() => buildTrays(k, [], FAST)).toThrow(TrayError);
    expect(() => buildTrays(k, p, { ...FAST, length: 400, width: 330 })).toThrow(/print bed/);
    expect(() => buildTrays(k, p, { ...FAST, length: 50, width: 40 })).toThrow(/Too big/);
    expect(() => buildTrays(k, p, { ...FAST, depth: 20 })).toThrow(/too shallow/);
    expect(buildTrays(k, p, { ...FAST, depth: 40 }).trays[0].depth).toBe(40);
    expect(buildTrays(k, p, { ...FAST, length: 320, width: 330 }).trays[0].depth).toBeGreaterThan(0); // fits rotated
  });
});

const LIB = 'test-results/lib';
describe.skipIf(!existsSync(LIB))('real parts', () => {
  it('every library part gets a pocket it fits in; a tray of several is watertight', () => {
    const all: TrayPart[] = [];
    let id = 1;
    for (const f of readdirSync(LIB).filter((x) => x.endsWith('.3mf'))) {
      const buf = readFileSync(`${LIB}/${f}`);
      for (const m of parse3MF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, f)) {
        const p = posePart(k, m, poseCandidates(k, m)[0].rotation);
        const t0 = performance.now();
        const c = buildCavity(k, p.mesh, p.silhouette, p.height, DEFAULT_POCKET);
        const ms = performance.now() - t0;
        const straight = p.silhouetteArea * c.depth;
        const out = leftover(p.mesh, c.solid);
        console.log(`${f.padEnd(22)} steps=${String(c.steps).padStart(3)} depth=${c.depth.toFixed(1).padStart(5)} pocket=${(c.solid.volume() / 1000).toFixed(1).padStart(6)}cm³ vs straight ${(straight / 1000).toFixed(1).padStart(6)}cm³ leftover=${out.toExponential(1)} ${ms.toFixed(0)}ms`);
        expect(out).toBeLessThan(0.5); // mm³
        c.solid.delete();
        const cands = poseCandidates(k, m).slice(0, 3);
        all.push({ partId: id++, name: f, fingers: 'auto', poses: cands.map((c, i) => { const q = posePart(k, m, c.rotation); return { poseIndex: i, mesh: q.mesh, silhouette: q.silhouette, height: q.height }; }) });
      }
    }
    // The user's test case: 112.52 × 238.76 mm inside, 1 mm gap to the case wall.
    const t0 = performance.now();
    const { trays } = buildTrays(k, all, { ...DEFAULT_TRAY, length: 110.52, width: 236.76 });
    console.log(`${all.length} parts -> ${trays.length} trays in ${(performance.now() - t0).toFixed(0)} ms: ` + trays.map((t) => `${t.placements.length} parts, ${t.depth.toFixed(1)} mm deep`).join(' | '));
    for (const t of trays) {
      const solid = toManifold(k, t.mesh);
      expect(solid).not.toBeNull();
      solid!.delete();
    }
  }, 120000);
});
