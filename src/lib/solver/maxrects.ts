export interface Rect { x: number; y: number; w: number; h: number }
export interface Placement extends Rect { rotated: boolean }

const EPS = 1e-6;

/**
 * Maximal-rectangles bin packer with best-short-side-fit scoring.
 * Good enough for the tens-of-parts instances this app deals with, and it
 * leaves large contiguous free areas, which matters when trays are later
 * shrunk to the smallest grid multiple that still holds them.
 */
export class MaxRects {
  free: Rect[];
  used: Rect[] = [];

  constructor(public readonly W: number, public readonly H: number) {
    this.free = W > 0 && H > 0 ? [{ x: 0, y: 0, w: W, h: H }] : [];
  }

  clone(): MaxRects {
    const c = new MaxRects(this.W, this.H);
    c.free = this.free.map((r) => ({ ...r }));
    c.used = this.used.map((r) => ({ ...r }));
    return c;
  }

  /** Area of everything placed so far. */
  usedArea(): number {
    return this.used.reduce((a, r) => a + r.w * r.h, 0);
  }

  /** Bounding box of everything placed so far. */
  extent(): { w: number; h: number } {
    let w = 0, h = 0;
    for (const r of this.used) { w = Math.max(w, r.x + r.w); h = Math.max(h, r.y + r.h); }
    return { w, h };
  }

  private score(fr: Rect, w: number, h: number) {
    const dw = fr.w - w, dh = fr.h - h;
    return { short: Math.min(dw, dh), long: Math.max(dw, dh) };
  }

  insert(w: number, h: number, allowRot: boolean): Placement | null {
    let best: Placement | null = null;
    let bestShort = Infinity, bestLong = Infinity;

    for (const fr of this.free) {
      for (const rotated of allowRot && Math.abs(w - h) > EPS ? [false, true] : [false]) {
        const rw = rotated ? h : w;
        const rh = rotated ? w : h;
        if (rw > fr.w + EPS || rh > fr.h + EPS) continue;
        const s = this.score(fr, rw, rh);
        if (s.short < bestShort - EPS || (Math.abs(s.short - bestShort) <= EPS && s.long < bestLong - EPS)) {
          bestShort = s.short;
          bestLong = s.long;
          best = { x: fr.x, y: fr.y, w: rw, h: rh, rotated };
        }
      }
    }
    if (!best) return null;
    this.place(best);
    return best;
  }

  /** Reserve a fixed region, e.g. a thumb-notch zone. */
  occupy(r: Rect): void {
    this.place({ ...r, rotated: false });
  }

  private place(p: Placement) {
    const next: Rect[] = [];
    for (const fr of this.free) {
      if (!this.splitFree(fr, p, next)) next.push(fr);
    }
    this.free = prune(next);
    this.used.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  }

  private splitFree(fr: Rect, cut: Rect, out: Rect[]): boolean {
    if (cut.x >= fr.x + fr.w - EPS || cut.x + cut.w <= fr.x + EPS ||
        cut.y >= fr.y + fr.h - EPS || cut.y + cut.h <= fr.y + EPS) return false;

    if (cut.x > fr.x + EPS) out.push({ x: fr.x, y: fr.y, w: cut.x - fr.x, h: fr.h });
    if (cut.x + cut.w < fr.x + fr.w - EPS) {
      const x = cut.x + cut.w;
      out.push({ x, y: fr.y, w: fr.x + fr.w - x, h: fr.h });
    }
    if (cut.y > fr.y + EPS) out.push({ x: fr.x, y: fr.y, w: fr.w, h: cut.y - fr.y });
    if (cut.y + cut.h < fr.y + fr.h - EPS) {
      const y = cut.y + cut.h;
      out.push({ x: fr.x, y, w: fr.w, h: fr.y + fr.h - y });
    }
    return true;
  }
}

const contains = (a: Rect, b: Rect) =>
  b.x >= a.x - EPS && b.y >= a.y - EPS &&
  b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS;

function prune(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    let keep = rects[i].w > EPS && rects[i].h > EPS;
    for (let j = 0; keep && j < rects.length; j++) {
      if (i !== j && contains(rects[j], rects[i]) && !(contains(rects[i], rects[j]) && j > i)) keep = false;
    }
    if (keep) out.push(rects[i]);
  }
  return out;
}
