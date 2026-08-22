import Module from 'manifold-3d';
// Vite resolves this to a hashed asset URL so the WASM ships with the build.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldToplevel, Manifold as ManifoldT, CrossSection as CrossSectionT } from 'manifold-3d';
import type { Poly, Ring, Vec2 } from '../../types';

let toplevel: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel> | null = null;

/**
 * `wasmOverride` lets non-browser callers (tests, scripts) point at the .wasm
 * file on disk; the browser build uses the bundled asset URL.
 */
export async function initCad(wasmOverride?: string): Promise<ManifoldToplevel> {
  if (toplevel) return toplevel;
  if (!loading) {
    loading = Module({ locateFile: () => wasmOverride ?? wasmUrl }).then((m) => {
      m.setup();
      // Smooth enough for 2-3 mm fillets without exploding triangle counts.
      m.setMinCircularAngle(6);
      m.setMinCircularEdgeLength(0.2);
      toplevel = m;
      return m;
    });
  }
  return loading;
}

export function cad(): ManifoldToplevel {
  if (!toplevel) throw new Error('CAD kernel not initialised - call initCad() first.');
  return toplevel;
}

export type Solid = ManifoldT;
export type Section = CrossSectionT;

/** Build a CrossSection from a silhouette (outer ring + holes), even-odd filled. */
export function sectionFromPoly(poly: Poly): Section {
  return new (cad().CrossSection)(poly as Vec2[][], 'EvenOdd');
}

/** Offset a silhouette outwards, returning rings. Used for pocket clearance. */
export function offsetPoly(poly: Poly, delta: number, circularSegments = 24): Poly {
  const cs = sectionFromPoly(poly);
  if (delta === 0) {
    const result = cs.toPolygons() as Poly;
    cs.delete();
    return result;
  }
  const grown = cs.offset(delta, 'Round', 2, circularSegments);
  const clean = grown.simplify(0.01);
  const result = clean.toPolygons() as Poly;
  cs.delete();
  grown.delete();
  clean.delete();
  return result;
}

/**
 * Loft a stack of equal-topology rings into a closed solid.
 * Rings must be CCW in XY and listed bottom to top.
 */
export function loft(sections: { ring: Ring; z: number }[]): Solid {
  const n = sections[0].ring.length;
  for (const s of sections) {
    if (s.ring.length !== n) throw new Error('loft() requires every section to have the same vertex count');
  }
  const layers = sections.length;
  const verts: number[] = [];
  for (const s of sections) for (const [x, y] of s.ring) verts.push(x, y, s.z);

  // Cap centroids, appended after the ring vertices.
  const bottomC = verts.length / 3;
  const c0 = centroid(sections[0].ring);
  verts.push(c0[0], c0[1], sections[0].z);
  const topC = verts.length / 3;
  const c1 = centroid(sections[layers - 1].ring);
  verts.push(c1[0], c1[1], sections[layers - 1].z);

  const tris: number[] = [];
  for (let k = 0; k < layers - 1; k++) {
    const lo = k * n, hi = (k + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = lo + i, b = lo + j, c = hi + j, d = hi + i;
      tris.push(a, b, c, a, c, d);
    }
  }
  const last = (layers - 1) * n;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(bottomC, j, i);          // bottom cap, normal -Z
    tris.push(topC, last + i, last + j); // top cap, normal +Z
  }

  const { Mesh, Manifold } = cad();
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
  });
  return Manifold.ofMesh(mesh);
}

function centroid(ring: Ring): Vec2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

export interface TriMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export function toTriMesh(solid: Solid): TriMesh {
  const m = solid.getMesh();
  const numProp = m.numProp;
  const count = m.vertProperties.length / numProp;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = m.vertProperties[i * numProp];
    positions[i * 3 + 1] = m.vertProperties[i * numProp + 1];
    positions[i * 3 + 2] = m.vertProperties[i * numProp + 2];
  }
  return { positions, indices: new Uint32Array(m.triVerts) };
}
