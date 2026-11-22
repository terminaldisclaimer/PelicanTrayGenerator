import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { poseCandidates, posePart, toManifold, weld } from '../src/geom/analyze';
import { convexHull, insideConvex, minAreaRectAngle } from '../src/geom/hull2d';
import { apply, IDENTITY, mul, ROT_X90, rotationToDown, rotZ, type Mat3 } from '../src/geom/vec';
import { parse3MF } from '../src/mesh/threemf';
import type { TriMesh } from '../src/mesh/types';
import { boxMesh } from './fixtures';

let k: ManifoldToplevel;
beforeAll(async () => { k = await initKernel(); });

/** Convert a Manifold solid into our triangle-soup format (and free it). */
function soup(m: Manifold, name = 'part'): TriMesh {
  const mesh = m.getMesh();
  const v = mesh.vertProperties, t = mesh.triVerts, np = mesh.numProp;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = v[t[i] * np + c];
  m.delete();
  return { name, positions: out };
}
const rotated = (m: TriMesh, r: Mat3): TriMesh => {
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) p.set(apply(r, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]), i);
  return { name: m.name, positions: p };
};

describe('2D helpers', () => {
  it('convex hull and inside test', () => {
    const h = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
    expect(h).toHaveLength(4);
    expect(insideConvex(h, [2, 2])).toBe(true);
    expect(insideConvex(h, [5, 2])).toBe(false);
    expect(insideConvex(h, [0.05, 2], 0.1)).toBe(false);
  });

  it('finds the angle that squares up a rotated rectangle, long side on X', () => {
    const t = 0.6, c = Math.cos(t), s = Math.sin(t);
    const rect = ([[0, 0], [30, 0], [30, 10], [0, 10]] as [number, number][]).map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]);
    const a = minAreaRectAngle(rect);
    const xs = rect.map(([x, y]) => x * Math.cos(a) - y * Math.sin(a)), ys = rect.map(([x, y]) => x * Math.sin(a) + y * Math.cos(a));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 5);
  });

  it('rotationToDown sends the normal to -Z and is a proper rotation', () => {
    const n: [number, number, number] = [0.6, 0, 0.8];
    const r = rotationToDown(n);
    const d = apply(r, n);
    expect(d[0]).toBeCloseTo(0); expect(d[1]).toBeCloseTo(0); expect(d[2]).toBeCloseTo(-1);
    const rt = mul(r, [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]);
    rt.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY[i]));
  });
});

describe('silhouette', () => {
  it('welds a box to 8 vertices and makes a valid solid', () => {
    const w = weld(boxMesh(10, 20, 30).positions);
    expect(w.verts.length / 3).toBe(8);
    const m = toManifold(k, boxMesh(10, 20, 30))!;
    expect(m.volume()).toBeCloseTo(6000);
    m.delete();
  });

  it('box: rectangle outline, height, centred on the bed', () => {
    const p = posePart(k, boxMesh(40, 20, 10), IDENTITY);
    expect(p.solid).toBe(true);
    expect(p.height).toBeCloseTo(10);
    expect(p.silhouetteArea).toBeCloseTo(800, 3);
    expect(p.silhouette).toHaveLength(1);
    const xs = p.silhouette[0].map((q) => q[0]);
    expect(Math.min(...xs)).toBeCloseTo(-20); expect(Math.max(...xs)).toBeCloseTo(20);
  });

  it('cylinder: outline area ≈ πr²', () => {
    const p = posePart(k, soup(k.Manifold.cylinder(30, 12, 12, 128)), IDENTITY);
    expect(p.silhouetteArea / (Math.PI * 144)).toBeCloseTo(1, 2);
    expect(p.height).toBeCloseTo(30);
  });

  it('washer: keeps the hole (outer CCW, hole CW)', () => {
    const outer = k.Manifold.cylinder(3, 20, 20, 96), inner = k.Manifold.cylinder(3, 8, 8, 96);
    const p = posePart(k, soup(outer.subtract(inner)), IDENTITY);
    outer.delete(); inner.delete();
    expect(p.silhouette).toHaveLength(2);
    expect(p.silhouetteArea / (Math.PI * (400 - 64))).toBeCloseTo(1, 2);
  });

  it('mushroom: outline is the widest section, not the base', () => {
    const stem = k.Manifold.cylinder(20, 5, 5, 64), cap = k.Manifold.cylinder(5, 15, 15, 64).translate([0, 0, 20]);
    const p = posePart(k, soup(stem.add(cap)), IDENTITY);
    stem.delete(); cap.delete();
    expect(p.silhouetteArea / (Math.PI * 225)).toBeCloseTo(1, 2);
    expect(p.height).toBeCloseTo(25);
  });

  it('L-bracket: concave outline when viewed along its extrusion', () => {
    const a = k.Manifold.cube([30, 10, 10]), b = k.Manifold.cube([10, 30, 10]);
    const p = posePart(k, soup(a.add(b)), IDENTITY);
    a.delete(); b.delete();
    expect(p.silhouetteArea).toBeCloseTo(500, 2);
    expect(p.silhouette[0]).toHaveLength(6);
  });

  it('open (non-watertight) mesh: still gets an outline', () => {
    const box = boxMesh(40, 20, 10);
    const open = { name: 'open', positions: box.positions.slice(18) }; // drop the bottom face
    const p = posePart(k, open, IDENTITY);
    expect(p.solid).toBe(false);
    expect(p.silhouetteArea).toBeCloseTo(800, 2);
    expect(p.height).toBeCloseTo(10);
  });
});

describe('auto pose', () => {
  it('lays a tilted plate flat with its long side along X', () => {
    const tilted = rotated(boxMesh(60, 30, 4), mul(rotZ(0.4), mul(ROT_X90, rotZ(0.9))));
    const [best] = poseCandidates(k, tilted);
    expect(best.stable).toBe(true);
    const p = posePart(k, tilted, best.rotation);
    expect(p.height).toBeCloseTo(4, 3);
    expect(p.size[0]).toBeCloseTo(60, 3);
    expect(p.size[1]).toBeCloseTo(30, 3);
  });

  it('lays a pen-like cylinder on its side, not on its end', () => {
    const pen = soup(k.Manifold.cylinder(140, 5, 5, 48));
    const [best] = poseCandidates(k, pen);
    const p = posePart(k, pen, best.rotation);
    expect(p.height).toBeLessThan(10.01);
    expect(p.size[0]).toBeCloseTo(140, 1);
  });

  it('offers several clearly different poses, best first', () => {
    const c = poseCandidates(k, boxMesh(50, 30, 10));
    expect(c.length).toBe(6);
    expect(c[0].height).toBeCloseTo(10);
    expect(c.every((x) => x.stable)).toBe(true);
  });

  it('always offers the best pose turned 90° every way (on its sides and ends)', () => {
    // A round bar has no flat side faces, but "standing on end" and "on its side" must still be offered.
    const bar = soup(k.Manifold.cylinder(80, 6, 6, 64));
    const heights = poseCandidates(k, bar).map((c) => posePart(k, bar, c.rotation).height);
    expect(heights[0]).toBeCloseTo(12, 0); // lying down first
    expect(heights.filter((h) => Math.abs(h - 80) < 0.01).length).toBeGreaterThanOrEqual(2); // both ends
    expect(heights.filter((h) => Math.abs(h - 12) < 0.2).length).toBeGreaterThanOrEqual(4); // four sides
    // An L-bracket: standing on each leg end is offered even though the best pose is flat.
    const a = k.Manifold.cube([40, 10, 6]), b = k.Manifold.cube([10, 30, 6]);
    const l = soup(a.add(b));
    a.delete(); b.delete();
    const sizes = poseCandidates(k, l).map((c) => posePart(k, l, c.rotation).height);
    expect(sizes[0]).toBeCloseTo(6);
    expect(sizes.some((h) => Math.abs(h - 40) < 0.01)).toBe(true);
    expect(sizes.some((h) => Math.abs(h - 30) < 0.01)).toBe(true);
  });

  it('rejects poses where the part would tip over', () => {
    // A tall L: resting on the short foot's end face would topple.
    const a = k.Manifold.cube([10, 10, 60]), b = k.Manifold.cube([40, 10, 10]);
    const l = soup(a.add(b));
    a.delete(); b.delete();
    const c = poseCandidates(k, l);
    expect(c[0].stable).toBe(true);
    expect(posePart(k, l, c[0].rotation).height).toBeCloseTo(10, 3); // lying flat
  });
});

// Real parts exported from Fusion (not committed). Run when present locally.
const LIB = 'test-results/lib';
describe.skipIf(!existsSync(LIB))('real parts', () => {
  const files = existsSync(LIB) ? readdirSync(LIB).filter((f) => f.endsWith('.3mf')) : [];
  it.each(files)('%s poses and outlines', (f) => {
    const buf = readFileSync(`${LIB}/${f}`);
    const meshes = parse3MF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, f);
    for (const m of meshes) {
      const c = poseCandidates(k, m);
      const p = posePart(k, m, c[0].rotation);
      console.log(`${f.padEnd(24)} ${m.name.slice(0, 18).padEnd(18)} tris=${String(m.positions.length / 9).padStart(6)} solid=${p.solid} stable=${c[0].stable} size=${p.size.map((v) => v.toFixed(1)).join('×')} loops=${p.silhouette.length} area=${p.silhouetteArea.toFixed(0)} poses=${c.length}`);
      expect(p.silhouetteArea).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });
});
