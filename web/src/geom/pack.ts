/**
 * 2D packing of irregular footprints into equal-sized trays (pure TypeScript,
 * no kernel). Footprints are rasterised on a 1 mm grid at a set of angles about
 * the vertical axis (every 15° by default) and placed first-fit, lowest row first. Several orderings are tried and the
 * best result kept: fewest trays, then least total stacked height (pocket
 * depth plus floor, summed over trays), then most compact.
 */
import type { Pt } from './hull2d';

export interface PackOption {
  /** Caller's label for this way of laying the part (e.g. pose index). */
  key: number;
  /** Pocket depth this option needs (mm). */
  depth: number;
  /**
   * Footprint loops in mm (outer CCW, holes CW), already grown by half the
   * minimum wall plus raster slack, so touching footprints are a wall apart.
   */
  footprint: Pt[][];
}
export interface PackItem { id: number; options: PackOption[] }
export interface PackPlacement { id: number; tray: number; key: number; angle: number; tx: number; ty: number; depth: number }
export interface PackResult { trays: { depth: number }[]; placements: PackPlacement[]; unplaced: number[] }
export interface PackSettings {
  /** Usable region for footprints (mm), i.e. the tray minus edge margins. */
  width: number;
  height: number;
  cell?: number;
  /** Orderings to try; more = better packing, slower. */
  attempts?: number;
  seed?: number;
  timeBudgetMs?: number;
  /** Rotation step about Z in degrees (default 15; 90 = axis-aligned only). */
  angleStep?: number;
  /** Height every tray adds on top of its deepest pocket (the floor), mm. */
  trayOverhead?: number;
}


interface Shape { runs: Int32Array; w: number; h: number; minX: number; minY: number; cells: number }
interface Opt { key: number; depth: number; shapes: Shape[]; angles: number[] }
interface Prepared { id: number; opts: Opt[]; area: number; maxDim: number; minDepth: number }

function rotate(loops: Pt[][], deg: number): Pt[][] {
  if (deg === 0) return loops;
  let c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  if (deg % 90 === 0) { c = Math.round(c); s = Math.round(s); } // exact quarter turns
  return loops.map((l) => l.map(([x, y]) => [x * c - y * s, x * s + y * c] as Pt));
}

/** Scanline rasterisation (non-zero winding via even-odd on oriented loops) at cell centres. */
export function rasterize(loops: Pt[][], cell: number): Shape {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) for (const [x, y] of l) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = Math.max(1, Math.ceil((maxX - minX) / cell)), h = Math.max(1, Math.ceil((maxY - minY) / cell));
  const runs: number[] = [];
  let cells = 0;
  for (let row = 0; row < h; row++) {
    const y = minY + (row + 0.5) * cell;
    const xs: number[] = [];
    for (const l of loops)
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Cover every cell the span touches (conservative).
      const x0 = Math.max(0, Math.floor((xs[i] - minX) / cell)), x1 = Math.min(w - 1, Math.ceil((xs[i + 1] - minX) / cell) - 1);
      if (x1 < x0) continue;
      const last = runs.length - 3;
      if (last >= 0 && runs[last] === row && runs[last + 2] >= x0 - 1) runs[last + 2] = Math.max(runs[last + 2], x1);
      else runs.push(row, x0, x1);
    }
  }
  for (let i = 0; i < runs.length; i += 3) cells += runs[i + 2] - runs[i + 1] + 1;
  return { runs: Int32Array.from(runs), w, h, minX, minY, cells };
}

class Bin {
  depth = 0;
  top = 0; // highest occupied row + 1
  private occ: Uint8Array;
  private prefix: Int32Array;
  constructor(readonly W: number, readonly H: number) {
    this.occ = new Uint8Array(W * H);
    this.prefix = new Int32Array((W + 1) * H);
  }
  private free(s: Shape, px: number, py: number): boolean {
    const r = s.runs, P = this.prefix, stride = this.W + 1;
    for (let i = 0; i < r.length; i += 3) {
      const base = (py + r[i]) * stride + px;
      if (P[base + r[i + 2] + 1] - P[base + r[i + 1]] !== 0) return false;
    }
    return true;
  }
  /** First free position scanning rows upward, columns left to right. */
  find(s: Shape): [number, number] | null {
    if (s.w > this.W || s.h > this.H) return null;
    // Rows above everything placed so far are empty, so the search can stop there.
    const maxY = Math.min(this.H - s.h, this.top);
    for (let py = 0; py <= maxY; py++) for (let px = 0; px <= this.W - s.w; px++) if (this.free(s, px, py)) return [px, py];
    return null;
  }
  place(s: Shape, px: number, py: number, depth: number) {
    const r = s.runs, stride = this.W + 1;
    let lastRow = -1;
    const redo = (row: number) => {
      let acc = 0;
      const o = row * this.W, p = row * stride;
      for (let x = 0; x < this.W; x++) { acc += this.occ[o + x]; this.prefix[p + x + 1] = acc; }
    };
    for (let i = 0; i < r.length; i += 3) {
      const row = py + r[i];
      if (row !== lastRow && lastRow >= 0) redo(lastRow);
      lastRow = row;
      this.occ.fill(1, row * this.W + px + r[i + 1], row * this.W + px + r[i + 2] + 1);
    }
    if (lastRow >= 0) redo(lastRow);
    this.top = Math.max(this.top, py + s.h);
    this.depth = Math.max(this.depth, depth);
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Solution { bins: Bin[]; placements: PackPlacement[]; unplaced: number[]; score: [number, number, number, number] }

function attempt(order: Prepared[], W: number, H: number, cell: number, depthWeight: number, overhead: number): Solution {
  const bins: Bin[] = [];
  const placements: PackPlacement[] = [];
  const unplaced: number[] = [];
  for (const item of order) {
    let done = false;
    for (let b = 0; b <= bins.length && !done; b++) {
      const bin = b < bins.length ? bins[b] : new Bin(W, H);
      let best = null as { cost: number; opt: Opt; a: number; px: number; py: number } | null;
      // Quarter turns first; other angles only if the part will not go in square
      // (so skewing is used to save a tray, and the common case stays fast).
      for (const [from, to] of [[0, 4], [4, Infinity]]) {
        for (const opt of item.opts)
          for (let a = from; a < Math.min(to, opt.shapes.length); a++) {
            const s = opt.shapes[a];
            const pos = bin.find(s);
            if (!pos) continue;
            // Low and left is good; making the tray deeper is expensive.
            const cost = pos[1] + s.h + pos[0] * 1e-3 + depthWeight * Math.max(0, opt.depth - bin.depth);
            if (!best || cost < best.cost) best = { cost, opt, a, px: pos[0], py: pos[1] };
          }
        if (best) break;
      }
      if (!best) continue;
      if (b === bins.length) bins.push(bin);
      const s = best.opt.shapes[best.a];
      bin.place(s, best.px, best.py, best.opt.depth);
      placements.push({ id: item.id, tray: b, key: best.opt.key, angle: best.opt.angles[best.a], tx: best.px * cell - s.minX, ty: best.py * cell - s.minY, depth: best.opt.depth });
      done = true;
    }
    if (!done) unplaced.push(item.id);
  }
  const stackHeight = bins.reduce((s, b) => s + b.depth + overhead, 0);
  const extent = bins.reduce((s, b) => s + b.top, 0);
  return { bins, placements, unplaced, score: [unplaced.length, bins.length, stackHeight, extent] };
}

const better = (a: Solution, b: Solution) => {
  for (let i = 0; i < 4; i++) if (Math.abs(a.score[i] - b.score[i]) > 1e-9) return a.score[i] < b.score[i];
  return false;
};

/**
 * Pack items into as few trays as possible. Coordinates in the result are for
 * the usable region with its lower-left corner at (0, 0): a point p of the
 * option's footprint ends up at rotate(p, angle) + (tx, ty).
 */
export function pack(items: PackItem[], settings: PackSettings): PackResult {
  const cell = settings.cell ?? 1;
  const W = Math.floor(settings.width / cell + 1e-9), H = Math.floor(settings.height / cell + 1e-9);
  const step = Math.min(90, Math.max(1, settings.angleStep ?? 15));
  // Quarter turns first so they are preferred on equal cost.
  const angles: number[] = [0, 90, 180, 270];
  for (let a = step; a < 360; a += step) if (a % 90 !== 0) angles.push(a);
  const prepared: Prepared[] = items.map((it) => {
    const opts = it.options.map((o) => ({ key: o.key, depth: o.depth, angles, shapes: angles.map((a) => rasterize(rotate(o.footprint, a), cell)) }));
    const first = opts[0].shapes[0];
    return { id: it.id, opts, area: first.cells, maxDim: Math.max(first.w, first.h), minDepth: Math.min(...opts.map((o) => o.depth)) };
  });
  if (W < 1 || H < 1) return { trays: [], placements: [], unplaced: items.map((i) => i.id) };

  const rand = mulberry32(settings.seed ?? 1);
  const byArea = [...prepared].sort((a, b) => b.area - a.area);
  const orders: Prepared[][] = [
    byArea,
    [...prepared].sort((a, b) => b.maxDim - a.maxDim || b.area - a.area),
    [...prepared].sort((a, b) => b.minDepth - a.minDepth || b.area - a.area),
  ];
  const attempts = settings.attempts ?? 24;
  const start = Date.now();
  let best: Solution | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i >= 3 && settings.timeBudgetMs && Date.now() - start > settings.timeBudgetMs) break;
    let order: Prepared[];
    if (i < orders.length * 3) order = orders[Math.floor(i / 3)];
    else {
      // Perturb the area order: swap a few neighbours.
      order = [...byArea];
      const swaps = 1 + Math.floor(rand() * Math.max(1, order.length / 2));
      for (let s = 0; s < swaps; s++) {
        const a = Math.floor(rand() * order.length), b = Math.min(order.length - 1, a + 1 + Math.floor(rand() * 3));
        [order[a], order[b]] = [order[b], order[a]];
      }
    }
    // Cycle through "never deepen a tray if avoidable", "keep trays shallow"
    // and "fit as much as possible".
    const sol = attempt(order, W, H, cell, [1e6, 4, 0.25][i % 3], settings.trayOverhead ?? 0);
    if (!best || better(sol, best)) best = sol;
  }
  return { trays: best!.bins.map((b) => ({ depth: b.depth })), placements: best!.placements, unplaced: best!.unplaced };
}
