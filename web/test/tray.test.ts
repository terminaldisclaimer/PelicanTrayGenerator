import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { poseCandidates, posePart, toManifold } from '../src/geom/analyze';
import { buildCavity, DEFAULT_POCKET } from '../src/geom/pocket';
import { autoFingers, buildTrays, DEFAULT_TRAY, fingerCentre, fingerDepth, TrayError, type TrayPart } from '../src/geom/tray';
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
const FAST = { ...DEFAULT_TRAY, packAttempts: 6 };

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

  it('finger cutouts: chosen sides, sensible depth, extra material removed', () => {
    const box = boxMesh(60, 30, 20);
    const sil = posed(box).silhouette;
    expect(fingerCentre(sil, 0.5, 'top')).toEqual([0, 15.5]);
    expect(fingerCentre(sil, 0.5, 'bottom')).toEqual([0, -15.5]);
    expect(fingerCentre(sil, 0.5, 'left')).toEqual([-30.5, 0]);
    expect(fingerCentre(sil, 0.5, 'right')).toEqual([30.5, 0]);
    // Shallow pockets are scooped to the floor; deep ones 60 % (at least 15 mm).
    expect(fingerDepth(6.2, 0.6)).toBe(6.2);
    expect(fingerDepth(20.2, 0.6)).toBe(15);
    expect(fingerDepth(40, 0.6)).toBe(24);
    // Thin parts get one lever scoop, taller parts a pinch pair.
    expect(autoFingers(6)).toEqual(['top']);
    expect(autoFingers(20)).toEqual(['top', 'bottom']);

    const vol = (f: TrayPart['fingers']) => buildTrays(k, [trayPart(box, 1, f)], FAST).trays[0];
    const none = vol([]), one = vol(['top']), two = vol(['top', 'bottom']), auto = vol('auto');
    // Half a Ø20 disc lies outside the pocket, cut 15 mm deep.
    const half = (Math.PI * 100) / 2 * 15;
    expect((none.volume - one.volume) / half).toBeCloseTo(1, 1);
    expect((none.volume - two.volume) / (2 * half)).toBeCloseTo(1, 1);
    expect(auto.volume).toBeCloseTo(two.volume, 3);
    expect(auto.placements[0].fingers).toEqual(['top', 'bottom']);
    const solid = toManifold(k, two.mesh)!;
    expect(solid).not.toBeNull();
    solid.delete();
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
    // A depth limit rules out the on-edge pose.
    expect(() => buildTrays(k, [part], { ...FAST, length: 30, width: 120, depth: 20 })).toThrow(/Too big/);
  });

  it('overflows into a second tray of the same footprint', () => {
    const parts = [0, 1, 2].map((i) => trayPart(boxMesh(80, 60, 10 + i * 10, `p${i}`), i));
    const { trays } = buildTrays(k, parts, { ...FAST, length: 100, width: 140 });
    expect(trays).toHaveLength(2);
    expect(trays.reduce((n, t) => n + t.placements.length, 0)).toBe(3);
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
