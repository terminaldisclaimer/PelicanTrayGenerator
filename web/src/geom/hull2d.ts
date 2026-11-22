export type Pt = [number, number];

/** Convex hull (Andrew monotone chain), counter-clockwise, no repeated last point. */
export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** True if `q` is inside the CCW convex polygon, at least `margin` from every edge. */
export function insideConvex(hull: Pt[], q: Pt, margin = 0): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    if ((ex * (q[1] - a[1]) - ey * (q[0] - a[0])) / len < margin) return false;
  }
  return true;
}

/**
 * Angle (radians) to rotate the points by so their minimum-area bounding
 * rectangle is axis-aligned with its long side along X.
 */
export function minAreaRectAngle(points: Pt[]): number {
  const h = convexHull(points);
  if (h.length < 3) return 0;
  let best = { area: Infinity, angle: 0 };
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-t), s = Math.sin(-t);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of h) {
      const rx = x * c - y * s, ry = x * s + y * c;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    }
    const w = maxX - minX, d = maxY - minY;
    const area = w * d;
    if (area < best.area - 1e-9) best = { area, angle: w >= d ? -t : -t + Math.PI / 2 };
  }
  return best.angle;
}
