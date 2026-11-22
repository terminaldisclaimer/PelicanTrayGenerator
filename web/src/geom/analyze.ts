import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import { convexHull, insideConvex, minAreaRectAngle, type Pt } from './hull2d';
import { apply, cross, dot, mul, norm, rotationToDown, rotZ, type Mat3, type Vec3 } from './vec';

/** Top-down outline: outer loops are counter-clockwise, holes clockwise (mm). */
export type Silhouette = Pt[][];

export interface PosedPart {
  mesh: TriMesh; // rotated, resting on z=0, centred on the XY origin
  size: Vec3;
  height: number;
  silhouette: Silhouette;
  silhouetteArea: number;
  /** False when the mesh was not watertight and only the outline could be computed. */
  solid: boolean;
}

export interface PoseCandidate { rotation: Mat3; height: number; supportArea: number; stable: boolean }

const SILHOUETTE_TOLERANCE = 0.05; // mm

/** Weld identical vertices so the triangle soup becomes an indexed mesh. */
export function weld(positions: Float32Array, tolerance = 1e-4): { verts: Float32Array; tris: Uint32Array } {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  const inv = 1 / tolerance;
  for (let t = 0; t < positions.length; t += 9) {
    const idx = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const x = positions[t + k * 3], y = positions[t + k * 3 + 1], z = positions[t + k * 3 + 2];
      const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      let i = map.get(key);
      if (i === undefined) { i = verts.length / 3; map.set(key, i); verts.push(x, y, z); }
      idx[k] = i;
    }
    if (idx[0] !== idx[1] && idx[1] !== idx[2] && idx[0] !== idx[2]) tris.push(idx[0], idx[1], idx[2]);
  }
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris) };
}

/** Build a Manifold solid from a triangle soup, or null if it is not watertight. Caller must delete(). */
export function toManifold(k: ManifoldToplevel, mesh: TriMesh): Manifold | null {
  const { verts, tris } = weld(mesh.positions);
  if (tris.length < 12) return null;
  try {
    const m = new k.Mesh({ numProp: 3, vertProperties: verts, triVerts: tris });
    m.merge();
    const solid = new k.Manifold(m);
    if (solid.isEmpty() || solid.volume() <= 0) { solid.delete(); return null; }
    return solid;
  } catch {
    return null;
  }
}

function rotateMesh(mesh: TriMesh, r: Mat3): TriMesh {
  const p = mesh.positions, out = new Float32Array(p.length);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = r[0] * p[i] + r[1] * p[i + 1] + r[2] * p[i + 2];
    const y = r[3] * p[i] + r[4] * p[i + 1] + r[5] * p[i + 2];
    const z = r[6] * p[i] + r[7] * p[i + 1] + r[8] * p[i + 2];
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let i = 0; i < out.length; i += 3) { out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= minZ; }
  return { name: mesh.name, positions: out };
}

function polygonArea(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Outline of a non-watertight mesh: union of all triangles projected onto XY. */
function projectSoup(k: ManifoldToplevel, positions: Float32Array): Silhouette {
  const tris: Pt[][] = [];
  for (let t = 0; t < positions.length; t += 9) {
    const a: Pt = [positions[t], positions[t + 1]], b: Pt = [positions[t + 3], positions[t + 4]], c: Pt = [positions[t + 6], positions[t + 7]];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) continue;
    tris.push(area > 0 ? [a, b, c] : [a, c, b]); // all counter-clockwise
  }
  const cs = k.CrossSection.ofPolygons(tris, 'Positive');
  const simple = cs.simplify(SILHOUETTE_TOLERANCE);
  const out = simple.toPolygons() as Pt[][];
  cs.delete(); simple.delete();
  return out;
}

/** Rotate the part by `rotation`, drop it on the bed and compute outline + height. */
export function posePart(k: ManifoldToplevel, original: TriMesh, rotation: Mat3): PosedPart {
  const mesh = rotateMesh(original, rotation);
  let maxX = 0, maxY = 0, maxZ = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    maxX = Math.max(maxX, Math.abs(mesh.positions[i]));
    maxY = Math.max(maxY, Math.abs(mesh.positions[i + 1]));
    maxZ = Math.max(maxZ, mesh.positions[i + 2]);
  }
  const solid = toManifold(k, mesh);
  let silhouette: Silhouette;
  if (solid) {
    const proj = solid.project();
    const simple = proj.simplify(SILHOUETTE_TOLERANCE);
    silhouette = simple.toPolygons() as Pt[][];
    proj.delete(); simple.delete(); solid.delete();
  } else {
    silhouette = projectSoup(k, mesh.positions);
  }
  const silhouetteArea = silhouette.reduce((s, loop) => s + polygonArea(loop), 0);
  return { mesh, size: [maxX * 2, maxY * 2, maxZ], height: maxZ, silhouette, silhouetteArea, solid: !!solid };
}

/** Volume centroid of a closed mesh (falls back to the vertex average). */
function centroid(verts: Float32Array, tris: Uint32Array): Vec3 {
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const v =
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) -
      verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c]) +
      verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
    vol += v;
    cx += v * (verts[a] + verts[b] + verts[c]);
    cy += v * (verts[a + 1] + verts[b + 1] + verts[c + 1]);
    cz += v * (verts[a + 2] + verts[b + 2] + verts[c + 2]);
  }
  if (Math.abs(vol) > 1e-9) return [cx / (4 * vol), cy / (4 * vol), cz / (4 * vol)];
  let sx = 0, sy = 0, sz = 0;
  const n = verts.length / 3;
  for (let i = 0; i < verts.length; i += 3) { sx += verts[i]; sy += verts[i + 1]; sz += verts[i + 2]; }
  return [sx / n, sy / n, sz / n];
}

/**
 * Candidate resting poses, best first. Each flat face of the convex hull is a
 * way the part could sit on a table; a face is "stable" when the centre of
 * mass is above it. For a tray we prefer the *lowest* stable pose (shallowest
 * pocket, thinnest tray). The list always holds the six axis-aligned
 * orientations (each of the model's ±X, ±Y, ±Z faces down); other flat resting
 * faces follow. Each rotation also spins the part so its bounding rectangle is
 * axis-aligned, long side on X (the packer chooses the final spin).
 */
export function poseCandidates(k: ManifoldToplevel, original: TriMesh, max = 8): PoseCandidate[] {
  const welded = weld(original.positions);
  const pts: Vec3[] = [];
  const step = Math.max(1, Math.floor(welded.verts.length / 3 / 20000));
  for (let i = 0; i < welded.verts.length; i += 3 * step) pts.push([welded.verts[i], welded.verts[i + 1], welded.verts[i + 2]]);
  if (pts.length < 4) return [{ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], height: 0, supportArea: 0, stable: false }];

  const solid = toManifold(k, original);
  const hull = k.Manifold.hull(pts);
  const hm = hull.getMesh();
  const hv = hm.vertProperties as Float32Array, ht = hm.triVerts as Uint32Array, np = hm.numProp;
  const V = (i: number): Vec3 => [hv[i * np], hv[i * np + 1], hv[i * np + 2]];
  const hullVerts: Vec3[] = [];
  for (let i = 0; i < hv.length / np; i++) hullVerts.push(V(i));
  const com = solid ? centroid(welded.verts, welded.tris) : centroid(Float32Array.from(hullVerts.flat()), ht);
  solid?.delete();
  hull.delete();

  // Group hull triangles into flat faces by normal.
  interface Face { n: Vec3; area: number; verts: Set<number> }
  const tri: { n: Vec3; area: number; v: [number, number, number] }[] = [];
  for (let t = 0; t < ht.length; t += 3) {
    const a = V(ht[t]), b = V(ht[t + 1]), c = V(ht[t + 2]);
    const cr = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const area = Math.hypot(cr[0], cr[1], cr[2]) / 2;
    if (area > 1e-9) tri.push({ n: norm(cr), area, v: [ht[t], ht[t + 1], ht[t + 2]] });
  }
  tri.sort((p, q) => q.area - p.area);
  const faces: Face[] = [];
  for (const t of tri) {
    let f = faces.find((g) => dot(g.n, t.n) > 0.9995);
    if (!f) {
      if (faces.length >= 400) continue;
      f = { n: t.n, area: 0, verts: new Set() };
      faces.push(f);
    }
    f.area += t.area;
    for (const i of t.v) f.verts.add(i);
  }

  let diag = 0;
  for (const p of hullVerts) diag = Math.max(diag, Math.hypot(p[0] - com[0], p[1] - com[1], p[2] - com[2]));
  const cands = faces.map((f) => {
    const r = rotationToDown(f.n);
    const poly = convexHull([...f.verts].map((i) => { const q = apply(r, hullVerts[i]); return [q[0], q[1]] as Pt; }));
    const c = apply(r, com);
    let lo = Infinity, hi = -Infinity;
    for (const p of hullVerts) { const d = dot(p, f.n); if (d < lo) lo = d; if (d > hi) hi = d; }
    return { n: f.n, r, height: hi - lo, supportArea: f.area, // No safety margin: round parts rest on a thin strip with the centre of mass
    // exactly above it. They would roll on a table, but a pocket holds them.
    stable: insideConvex(poly, [c[0], c[1]], -diag * 1e-6) };
  });
  cands.sort((a, b) => {
    if (a.stable !== b.stable) return a.stable ? -1 : 1;
    const tol = 0.02 * Math.max(a.height, b.height);
    if (Math.abs(a.height - b.height) > tol) return a.height - b.height;
    return b.supportArea - a.supportArea;
  });

  // The list is: the part resting on each of its six sides — its own X, Y and
  // Z axes pointing up or down, i.e. every 90° turn in every direction — plus
  // any other flat resting face that is not square to those axes. Best first.
  const finish = (r: Mat3) => {
    const flat: Pt[] = hullVerts.map((p) => { const q = apply(r, p); return [q[0], q[1]] as Pt; });
    return mul(rotZ(minAreaRectAngle(flat)), r);
  };
  const order = (a: (typeof cands)[0], b: (typeof cands)[0]) => {
    if (a.stable !== b.stable) return a.stable ? -1 : 1;
    const tol = 0.02 * Math.max(a.height, b.height);
    if (Math.abs(a.height - b.height) > tol) return a.height - b.height;
    return b.supportArea - a.supportArea;
  };
  const axes: Vec3[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
  const six = axes.map((n) => {
    const face = cands.find((c) => dot(c.n, n) > 0.9995);
    if (face) return face;
    let lo = Infinity, hi = -Infinity;
    for (const p of hullVerts) { const d = dot(p, n); if (d < lo) lo = d; if (d > hi) hi = d; }
    return { n, r: rotationToDown(n), height: hi - lo, supportArea: 0, stable: false };
  });
  // A side with no flat face (a round bar on its side) still holds in a pocket:
  // rank the six by height alone, lowest first.
  six.sort((a, b) => a.height - b.height || b.supportArea - a.supportArea);
  const extras = cands.filter((c) => c.stable && six.every((p) => dot(p.n, c.n) < 0.94)).sort(order);
  const picked: typeof cands = [...six];
  for (const c of extras) {
    if (picked.length >= max) break;
    if (picked.slice(6).every((p) => dot(p.n, c.n) < 0.5)) picked.push(c);
  }
  // If an off-axis face is clearly the lowest stable rest, offer it first.
  if (picked.length > 6 && picked[6].height < picked[0].height * 0.9) picked.unshift(picked.splice(6, 1)[0]);
  return picked.map((c) => ({ rotation: finish(c.r), height: c.height, supportArea: c.supportArea, stable: c.stable }));
}
