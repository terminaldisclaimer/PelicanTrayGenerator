import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { poseCandidates, posePart, toManifold } from '../src/geom/analyze';
import { buildCavity, DEFAULT_POCKET } from '../src/geom/pocket';
import { buildTray, DEFAULT_TRAY, shelfLayout, TrayError, type TrayPart } from '../src/geom/tray';
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

const trayPart = (m: TriMesh, id: number): TrayPart => { const p = posed(m); return { partId: id, name: m.name, mesh: p.mesh, silhouette: p.silhouette, height: p.height }; };

describe('tray', () => {
  it('shelf layout keeps boxes inside the tray and apart', () => {
    const items = [{ w: 100, h: 40 }, { w: 80, h: 60 }, { w: 120, h: 30 }, { w: 50, h: 50 }];
    const o = { length: 300, width: 200, wall: 3, edge: 4 };
    const spots = shelfLayout(items, o)!;
    items.forEach((a, i) => {
      expect(Math.abs(spots[i].x) + a.w / 2).toBeLessThanOrEqual(150 - 4 + 1e-9);
      expect(Math.abs(spots[i].y) + a.h / 2).toBeLessThanOrEqual(100 - 4 + 1e-9);
      items.forEach((b, j) => {
        if (j <= i) return;
        const dx = Math.abs(spots[i].x - spots[j].x) - (a.w + b.w) / 2, dy = Math.abs(spots[i].y - spots[j].y) - (a.h + b.h) / 2;
        expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(3 - 1e-9);
      });
    });
    expect(shelfLayout([{ w: 400, h: 10 }], o)).toBeNull();
  });

  it('builds a watertight tray; depth = deepest pocket + floor; volume adds up', () => {
    const parts = [trayPart(boxMesh(60, 40, 25, 'a'), 1), trayPart(boxMesh(30, 30, 10, 'b'), 2)];
    const t = buildTray(k, parts, DEFAULT_TRAY);
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
    expect(t.placements[1].z).toBeCloseTo(27.2 - 10);
    // The floor under the deepest pocket is solid.
    expect(sliceArea(solid, 1) / (300 * 200)).toBeCloseTo(1, 2);
    solid.delete();
  });

  it('exports as a valid binary STL', () => {
    const t = buildTray(k, [trayPart(boxMesh(60, 40, 25), 1)], DEFAULT_TRAY);
    const back = parseSTL(writeSTL(t.mesh));
    expect(back.positions.length).toBe(t.mesh.positions.length);
    const again = toManifold(k, back)!;
    expect(again.volume() / t.volume).toBeCloseTo(1, 5);
    again.delete();
  });

  it('explains problems instead of producing a bad tray', () => {
    const p = [trayPart(boxMesh(60, 40, 25), 1)];
    expect(() => buildTray(k, [], DEFAULT_TRAY)).toThrow(TrayError);
    expect(() => buildTray(k, p, { ...DEFAULT_TRAY, length: 400, width: 330 })).toThrow(/print bed/);
    expect(() => buildTray(k, p, { ...DEFAULT_TRAY, length: 50, width: 40 })).toThrow(/do not fit/);
    expect(() => buildTray(k, p, { ...DEFAULT_TRAY, depth: 20 })).toThrow(/too shallow/);
    expect(buildTray(k, p, { ...DEFAULT_TRAY, depth: 40 }).depth).toBe(40);
    expect(buildTray(k, p, { ...DEFAULT_TRAY, length: 320, width: 330 }).depth).toBeGreaterThan(0); // fits rotated
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
        all.push({ partId: id++, name: f, mesh: p.mesh, silhouette: p.silhouette, height: p.height });
      }
    }
    const some = all.filter((p) => /bubbler|mct|pen|tweezers|m22\.3mf|zirconia/.test(p.name));
    const t0 = performance.now();
    const tray = buildTray(k, some, { ...DEFAULT_TRAY, length: 320, width: 220 });
    console.log(`tray of ${some.length}: depth ${tray.depth.toFixed(1)} mm, ${tray.mesh.positions.length / 9} triangles, ${(performance.now() - t0).toFixed(0)} ms`);
    const solid = toManifold(k, tray.mesh);
    expect(solid).not.toBeNull();
    solid!.delete();
  }, 120000);
});
