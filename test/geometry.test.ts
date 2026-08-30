import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import type { PartInput, Poly, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { initCad, cad, offsetPoly, toTriMesh } from '../src/lib/cad/manifold';
import { footSolid, socketSolid, REG, cellCentre, trayFootprint } from '../src/lib/cad/profile';
import { buildTrayMesh } from '../src/lib/cad/tray';
import { solve } from '../src/lib/solver/solve';
import { meshToStl } from '../src/lib/export/stl';
import { meshTo3mf } from '../src/lib/export/threemf';
import { flattenPath } from '../src/lib/svg/parsePath';
import { ringAreaAbs, minAreaRotation, rotateRing, ringBBox } from '../src/lib/geom2d';

const require = createRequire(import.meta.url);
const WASM = require.resolve('manifold-3d/manifold.wasm');

beforeAll(async () => {
  await initCad(WASM);
}, 120000);

const rect = (w: number, h: number): Poly => [[[0, 0], [w, 0], [w, h], [0, h]]];

const part = (over: Partial<PartInput> = {}): PartInput => ({
  id: 'a', name: 'A', poly: rect(60, 40), keepHoles: false, depth: 18, qty: 1,
  groupId: null, sourceFile: 'a.svg', notes: [], sourceUnitMm: 1, unitOverrideMm: null,
  unitsAmbiguous: false, fingerNotches: [], ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('svg path flattening', () => {
  it('closes a rounded rectangle and keeps its area', () => {
    const subs = flattenPath('M 10 0 H 90 A 10 10 0 0 1 100 10 V 90 A 10 10 0 0 1 90 100 H 10 A 10 10 0 0 1 0 90 V 10 A 10 10 0 0 1 10 0 Z');
    expect(subs).toHaveLength(1);
    expect(subs[0].closed).toBe(true);
    // 100x100 square with four 10 mm corner radii.
    const expected = 100 * 100 - (4 - Math.PI) * 100;
    expect(ringAreaAbs(subs[0].points)).toBeCloseTo(expected, 0);
  });

  it('handles relative commands and smooth curves', () => {
    const subs = flattenPath('m 0 0 c 10 0 20 10 20 20 s -10 20 -20 20 z');
    expect(subs[0].points.length).toBeGreaterThan(8);
    expect(ringAreaAbs(subs[0].points)).toBeGreaterThan(0);
  });
});

describe('minimum-area orientation', () => {
  it('squares up a rectangle rotated off axis', () => {
    const r = rotateRing([[0, 0], [80, 0], [80, 20], [0, 20]], 0.6);
    const { rad } = minAreaRotation(r);
    const bb = ringBBox(rotateRing(r, rad));
    const dims = [bb.maxX - bb.minX, bb.maxY - bb.minY].sort((a, b) => a - b);
    expect(dims[0]).toBeCloseTo(20, 3);
    expect(dims[1]).toBeCloseTo(80, 3);
  });
});

describe('pocket clearance', () => {
  it('grows the silhouette by the global offset', () => {
    const out = offsetPoly(rect(60, 40), 2);
    const bb = ringBBox(out[0]);
    expect(bb.maxX - bb.minX).toBeCloseTo(64, 1);
    expect(bb.maxY - bb.minY).toBeCloseTo(44, 1);
  });
});

describe('stacking interface', () => {
  it('lets a foot seat in the recess of the tray below without interference', () => {
    const { Manifold } = cad();
    const pitch = 25;
    const tol = 0.25;
    const foot = footSolid(pitch);
    const socket = socketSolid(pitch, tol);

    // A block with the recess cut into its top, and a foot lowered into it.
    const block = Manifold.cube([pitch, pitch, 10], false).translate(-pitch / 2, -pitch / 2, 0);
    const withRecess = block.subtract(socket.translate(0, 0, 10 - REG.height));
    const seated = foot.translate(0, 0, 10 - REG.height);

    const clash = withRecess.intersect(seated);
    expect(clash.volume()).toBeLessThan(0.01);

    // And the clearance really is small: growing the foot by more than the
    // tolerance must start to interfere.
    const tight = socketSolid(pitch, 0).translate(0, 0, 10 - REG.height);
    expect(withRecess.intersect(tight).volume()).toBeLessThan(0.01);
    expect(foot.volume()).toBeGreaterThan(0);
  });

  it('makes the recess exactly one pitch wide at the top by default', () => {
    const socket = socketSolid(25, 0.25);
    const bb = socket.boundingBox();
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(25, 3);
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(REG.height, 6);
  });
});

describe('tray geometry', () => {
  it('builds a watertight solid with the expected footprint and height', () => {
    const s = settings();
    const res = solve([part()], s);
    expect(res.trays).toHaveLength(1);
    const tray = res.trays[0];

    expect(tray.sizeX).toBeCloseTo(trayFootprint(tray.cellsX, s.gridPitch), 6);
    expect(tray.height).toBeCloseTo(REG.height + s.floor + tray.pocketZone + REG.height, 6);

    const mesh = buildTrayMesh(tray, s);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.positions.length).toBeGreaterThan(100);

    // Rebuilding through the kernel proves the mesh is manifold and closed.
    const { Manifold, Mesh } = cad();
    const solid = Manifold.ofMesh(new Mesh({
      numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices,
    }));
    expect(solid.status()).toBe('NoError');
    expect(solid.genus()).toBeGreaterThanOrEqual(0);
    expect(solid.volume()).toBeGreaterThan(0);

    // The solid must sit inside its declared envelope.
    const bb = solid.boundingBox();
    expect(bb.min[2]).toBeGreaterThanOrEqual(-1e-6);
    expect(bb.max[2]).toBeLessThanOrEqual(tray.height + 1e-6);
    expect(bb.max[0]).toBeLessThanOrEqual(tray.sizeX + 1e-6);
    expect(bb.max[1]).toBeLessThanOrEqual(tray.sizeY + 1e-6);
  });

  it('cuts a pocket of the requested depth', () => {
    const s = settings({ thumbNotches: false });
    const res = solve([part({ depth: 18 })], s);
    const tray = res.trays[0];
    const mesh = buildTrayMesh(tray, s);
    const { Manifold, Mesh } = cad();
    const solid = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));

    const p = tray.parts[0];
    const topRef = tray.height - REG.height;
    // A thin probe just under the pocket floor must hit material...
    const probe = (z: number) =>
      Manifold.cube([2, 2, 0.4], true)
        .translate(p.bbox.x + p.bbox.w / 2, p.bbox.y + p.bbox.h / 2, z)
        .intersect(solid)
        .volume();
    expect(probe(topRef - p.depth - 0.5)).toBeGreaterThan(1.0);
    // ...and one just above it must not.
    expect(probe(topRef - p.depth + 0.5)).toBeLessThan(0.01);
  });
});

describe('exports', () => {
  it('writes a binary STL and a 3MF package', () => {
    const s = settings();
    const res = solve([part()], s);
    const mesh = buildTrayMesh(res.trays[0], s);

    const stl = meshToStl(mesh, 'clr2 w2');
    const head = new TextDecoder().decode(stl.slice(0, 80));
    expect(head).toContain('clr2');
    const tris = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(tris).toBe(mesh.indices.length / 3);
    expect(stl.byteLength).toBe(84 + tris * 50);

    const mf = meshTo3mf(mesh, 'Tray 1');
    expect(mf.byteLength).toBeGreaterThan(200);
    expect(String.fromCharCode(mf[0], mf[1])).toBe('PK');
  });
});

describe('mesh conversion', () => {
  it('round-trips a solid through toTriMesh', () => {
    const { Manifold } = cad();
    const c = Manifold.cube([10, 10, 10], false);
    const m = toTriMesh(c);
    expect(m.positions.length / 3).toBeGreaterThanOrEqual(8);
    expect(m.indices.length).toBe(36);
  });
});
