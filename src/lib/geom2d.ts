import type { Ring, Poly, Vec2 } from '../types';

export const TAU = Math.PI * 2;

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  }
  return a / 2;
}

export const ringAreaAbs = (r: Ring) => Math.abs(ringArea(r));

/** Signed area of a silhouette: outer ring minus holes. */
export function polyArea(p: Poly): number {
  if (p.length === 0) return 0;
  return p.reduce((acc, r, i) => acc + (i === 0 ? ringAreaAbs(r) : -ringAreaAbs(r)), 0);
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function ringBBox(r: Ring): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of r) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

export function polyBBox(p: Poly): BBox {
  return ringBBox(p[0] ?? []);
}

export const bboxW = (b: BBox) => b.maxX - b.minX;
export const bboxH = (b: BBox) => b.maxY - b.minY;

export function translateRing(r: Ring, dx: number, dy: number): Ring {
  return r.map(([x, y]) => [x + dx, y + dy] as Vec2);
}

export function translatePoly(p: Poly, dx: number, dy: number): Poly {
  return p.map((r) => translateRing(r, dx, dy));
}

export function rotateRing(r: Ring, rad: number): Ring {
  const c = Math.cos(rad), s = Math.sin(rad);
  return r.map(([x, y]) => [x * c - y * s, x * s + y * c] as Vec2);
}

export function rotatePoly(p: Poly, rad: number): Poly {
  return p.map((r) => rotateRing(r, rad));
}

/** Normalise so the silhouette's bounding box starts at the origin. */
export function normalisePoly(p: Poly): Poly {
  const b = polyBBox(p);
  return translatePoly(p, -b.minX, -b.minY);
}

/** Andrew's monotone chain. Returns a CCW hull without the duplicate endpoint. */
export function convexHull(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Rotating-callipers minimum-area bounding rectangle.
 * Returns the rotation (radians, CCW) that should be applied to the polygon so
 * that its bounding box becomes axis-aligned and minimal.
 */
export function minAreaRotation(ring: Ring): { rad: number; w: number; h: number } {
  const hull = convexHull(ring);
  if (hull.length < 3) {
    const b = ringBBox(ring);
    return { rad: 0, w: bboxW(b), h: bboxH(b) };
  }
  let best = { rad: 0, w: Infinity, h: Infinity, area: Infinity };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edge = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const rot = rotateRing(hull, -edge);
    const bb = ringBBox(rot);
    const w = bboxW(bb), h = bboxH(bb);
    const area = w * h;
    if (area < best.area - 1e-9) best = { rad: -edge, w, h, area };
  }
  return { rad: best.rad, w: best.w, h: best.h };
}

/** Flatten a cubic bezier into line segments. */
export function cubicPoints(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number): Vec2[] {
  const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const poly =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(2, Math.min(96, Math.ceil(Math.sqrt((chord + poly) / Math.max(tol, 1e-4)) * 2)));
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** Axis-aligned rectangle with rounded corners, centred on the origin. */
export function roundedRect(w: number, h: number, r: number, segsPerCorner: number): Ring {
  const rr = Math.max(0.01, Math.min(r, w / 2 - 1e-6, h / 2 - 1e-6));
  const hx = w / 2 - rr, hy = h / 2 - rr;
  const centres: Vec2[] = [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]];
  const out: Ring = [];
  for (let c = 0; c < 4; c++) {
    const a0 = (c * Math.PI) / 2;
    for (let s = 0; s <= segsPerCorner; s++) {
      const a = a0 + (s / segsPerCorner) * (Math.PI / 2);
      out.push([centres[c][0] + rr * Math.cos(a), centres[c][1] + rr * Math.sin(a)]);
    }
  }
  return out;
}

export function pointInRing(pt: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
