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
  /**
   * Finger holes (same coordinates, not grown). They need no wall between
   * each other and may overlap, but must stay out of other parts' footprints
   * and at least `softMargin` inside the tray region.
   */
  soft?: Pt[][];
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
  /** Cells of tray material a finger hole must leave to the edge of the region. */
  softMargin?: number;
  /** Areas nothing may be placed on (region coordinates, already grown by the clearance they need). */
  blocked?: Pt[][][];
  /** Areas blocked in the first tray only (parts pinned there). */
  blockedFirst?: Pt[][][];
  /** True when the tray depth is fixed by the user: a deeper pose then costs nothing. */
  fixedDepth?: boolean;
  /** Height every tray adds on top of its deepest pocket (the floor), mm. */
  trayOverhead?: number;
}


export interface Shape {
  runs: Int32Array; w: number; h: number; minX: number; minY: number; cells: number;
  /** Finger-hole cells as (row, x0, x1) relative to the same origin; may lie outside the w×h box. */
  soft?: Int32Array;
}
interface Opt { key: number; depth: number; shapes: Shape[]; angles: number[] }
interface Prepared { id: number; opts: Opt[]; area: number; maxDim: number; minDepth: number; /** Option indices by footprint size, smallest first. */ bySize: number[] }

export function rotate(loops: Pt[][], deg: number): Pt[][] {
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

/** Scanline cells of `loops` as (row, x0, x1) relative to a given origin, without clamping. */
export function rasterizeRel(loops: Pt[][], cell: number, minX: number, minY: number): Int32Array {
  let lo = Infinity, hi = -Infinity;
  for (const l of loops) for (const [, y] of l) { if (y < lo) lo = y; if (y > hi) hi = y; }
  const runs: number[] = [];
  if (lo === Infinity) return new Int32Array(0);
  for (let row = Math.floor((lo - minY) / cell); row <= Math.ceil((hi - minY) / cell); row++) {
    const y = minY + (row + 0.5) * cell;
    const xs: number[] = [];
    for (const l of loops)
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Finger holes are not grown, so count only cells whose centre is inside.
      const x0 = Math.ceil((xs[i] - minX) / cell - 0.5), x1 = Math.floor((xs[i + 1] - minX) / cell - 0.5);
      if (x1 >= x0) runs.push(row, x0, x1);
    }
  }
  return Int32Array.from(runs);
}

/** Footprint plus its finger holes, rasterised at one angle. */
export function rasterizeOption(o: PackOption, angle: number, cell: number): Shape {
  const s = rasterize(rotate(o.footprint, angle), cell);
  if (o.soft?.length) s.soft = rasterizeRel(rotate(o.soft, angle), cell, s.minX, s.minY);
  return s;
}

class Bin {
  depth = 0;
  top = 0; // highest occupied row + 1
  right = 0; // rightmost occupied column + 1
  private occ: Uint8Array;
  private prefix: Int32Array;
  /** Cells taken by finger holes (which other finger holes may share, but footprints may not). */
  private occSoft: Uint8Array;
  private prefixSoft: Int32Array;
  private anySoft = false;
  private hasBlocked = false;
  constructor(readonly W: number, readonly H: number, readonly softMargin = 0, blocked: Int32Array[] = []) {
    this.occ = new Uint8Array(W * H);
    this.prefix = new Int32Array((W + 1) * H);
    this.occSoft = new Uint8Array(W * H);
    this.prefixSoft = new Int32Array((W + 1) * H);
    // Blocked areas count as already occupied.
    for (const runs of blocked)
      for (let i = 0; i < runs.length; i += 3) {
        const row = runs[i];
        if (row < 0 || row >= H) continue;
        const x0 = Math.max(0, runs[i + 1]), x1 = Math.min(W - 1, runs[i + 2]);
        if (x1 >= x0) this.occ.fill(1, row * W + x0, row * W + x1 + 1);
      }
    this.hasBlocked = blocked.length > 0;
    if (blocked.length)
      for (let row = 0; row < H; row++) {
        let acc = 0;
        for (let x = 0; x < W; x++) { acc += this.occ[row * W + x]; this.prefix[row * (W + 1) + x + 1] = acc; }
      }
  }
  private free(s: Shape, px: number, py: number): boolean {
    const r = s.runs, P = this.prefix, stride = this.W + 1;
    for (let i = 0; i < r.length; i += 3) {
      const base = (py + r[i]) * stride + px;
      if (P[base + r[i + 2] + 1] - P[base + r[i + 1]] !== 0) return false;
    }
    if (this.anySoft) { // this footprint must not sit on anyone's finger hole
      const S = this.prefixSoft;
      for (let i = 0; i < r.length; i += 3) {
        const base = (py + r[i]) * stride + px;
        if (S[base + r[i + 2] + 1] - S[base + r[i + 1]] !== 0) return false;
      }
    }
    const f = s.soft;
    if (f) { // ...and its finger holes must stay on the tray and out of anyone's footprint
      const m = this.softMargin;
      for (let i = 0; i < f.length; i += 3) {
        const row = py + f[i], x0 = px + f[i + 1], x1 = px + f[i + 2];
        if (row < m || row >= this.H - m || x0 < m || x1 >= this.W - m) return false;
        if (P[row * stride + x1 + 1] - P[row * stride + x0] !== 0) return false;
      }
    }
    return true;
  }
  /** First free position scanning rows upward, columns left to right. */
  find(s: Shape): [number, number] | null {
    if (s.w > this.W || s.h > this.H) return null;
    // Rows above everything placed so far are empty, so the search can stop there.
    // A part with finger holes may need to sit a little in from the edge, so look further.
    const maxY = this.hasBlocked ? this.H - s.h : Math.min(this.H - s.h, this.top + (s.soft ? 40 : 0));
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
    const f = s.soft;
    if (f?.length) {
      this.anySoft = true;
      const rows = new Set<number>();
      for (let i = 0; i < f.length; i += 3) {
        const row = py + f[i];
        if (row < 0 || row >= this.H) continue;
        const x0 = Math.max(0, px + f[i + 1]), x1 = Math.min(this.W - 1, px + f[i + 2]);
        if (x1 < x0) continue;
        this.occSoft.fill(1, row * this.W + x0, row * this.W + x1 + 1);
        rows.add(row);
      }
      for (const row of rows) {
        let acc = 0;
        for (let x = 0; x < this.W; x++) { acc += this.occSoft[row * this.W + x]; this.prefixSoft[row * stride + x + 1] = acc; }
      }
    }
    this.top = Math.max(this.top, py + s.h);
    this.right = Math.max(this.right, px + s.w);
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

/**
 * How a greedy attempt picks among the positions on offer. No single rule is
 * best for every set of parts, so several are tried:
 *  0 = lowest top edge, any quarter turn;
 *  1 = lowest top edge, parts kept lengthwise (0/180°) when possible;
 *  2 = lowest top edge, parts kept crosswise (90/270°) when possible;
 *  3 = smallest bounding box around everything placed so far.
 */
type Policy = 0 | 1 | 2 | 3;
const PASSES: number[][][] = [[[0, 1, 2, 3]], [[0, 2], [1, 3]], [[1, 3], [0, 2]], [[0, 1, 2, 3]]];

function attempt(order: Prepared[], W: number, H: number, cell: number, depthWeight: number, overhead: number, policy: Policy = 0, choose?: (item: Prepared) => Opt[], softMargin = 0, blocked: Int32Array[] = [], blockedFirst: Int32Array[] = []): Solution {
  const bins: Bin[] = [];
  const placements: PackPlacement[] = [];
  const unplaced: number[] = [];
  for (const item of order) {
    let done = false;
    for (let b = 0; b <= bins.length && !done; b++) {
      const bin = b < bins.length ? bins[b] : new Bin(W, H, softMargin, b === 0 && blockedFirst.length ? [...blocked, ...blockedFirst] : blocked);
      let best = null as { cost: number; opt: Opt; a: number; px: number; py: number } | null;
      // Quarter turns first (in the order the policy prefers); other angles only
      // if the part will not go in square, so skewing is used to save a tray.
      const options = choose ? choose(item) : item.opts;
      const passes: number[][] = [...PASSES[policy], options[0].angles.map((_, i) => i).filter((i) => i >= 4)];
      for (const pass of passes) {
        for (const opt of options)
          for (const a of pass) {
            const s = opt.shapes[a];
            const pos = bin.find(s);
            if (!pos) continue;
            const deeper = depthWeight * Math.max(0, opt.depth - bin.depth);
            const cost = policy === 3
              ? Math.max(bin.top, pos[1] + s.h) * Math.max(bin.right, pos[0] + s.w) + deeper * W + pos[1] * 1e-3
              : pos[1] + s.h + pos[0] * 1e-3 + deeper; // low and left is good; a deeper tray is expensive
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
  const stackHeight = depthWeight === 0 && overhead < 0 ? 0 : bins.reduce((s, b) => s + b.depth + overhead, 0);
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
    const opts = it.options.map((o) => ({ key: o.key, depth: o.depth, angles, shapes: angles.map((a) => rasterizeOption(o, a, cell)) }));
    const first = opts[0].shapes[0];
    const bySize = opts.map((_, i) => i).sort((a, b) => opts[a].shapes[0].cells - opts[b].shapes[0].cells);
    return { id: it.id, opts, area: first.cells, maxDim: Math.max(first.w, first.h), minDepth: Math.min(...opts.map((o) => o.depth)), bySize };
  });
  if (W < 1 || H < 1) return { trays: [], placements: [], unplaced: items.map((i) => i.id) };

  const rand = mulberry32(settings.seed ?? 1);
  const byArea = [...prepared].sort((a, b) => b.area - a.area);
  const orders: Prepared[][] = [
    byArea,
    [...prepared].sort((a, b) => b.maxDim - a.maxDim || b.area - a.area),
    [...prepared].sort((a, b) => b.minDepth - a.minDepth || b.area - a.area),
  ];
  const blockedRuns = (settings.blocked ?? []).map((loops) => rasterizeRel(loops, cell, 0, 0));
  const firstRuns = (settings.blockedFirst ?? []).map((loops) => rasterizeRel(loops, cell, 0, 0));
  const attempts = settings.attempts ?? 96;
  const start = Date.now();
  const weights = settings.fixedDepth ? [0, 0, 0] : [1e6, 4, 0.25];
  const overhead = settings.fixedDepth ? -1 : settings.trayOverhead ?? 0;
  let best: Solution | null = null;
  const consider = (sol: Solution) => { if (!best || better(sol, best)) best = sol; };

  // The placement loop picks each part's pose greedily, which can miss a fit
  // that needs one particular pose of a big part. So, besides letting it
  // choose freely, systematically commit the largest parts to every
  // combination of their poses (the big parts decide whether a layout works),
  // and also try every part in its smallest footprint.
  type Choose = ((item: Prepared) => Opt[]) | undefined;
  const plans: Choose[] = [undefined];
  const multi = byArea.filter((p) => p.opts.length > 1);
  if (multi.length) {
    const lead: Prepared[] = [];
    let combos = 1;
    for (const p of multi) {
      if (combos * p.opts.length > 12) break;
      lead.push(p);
      combos *= p.opts.length;
    }
    if (lead.length) {
      for (let c = 0; c < combos; c++) {
        const fixed = new Map<number, Opt>();
        let n = c;
        for (const p of lead) { fixed.set(p.id, p.opts[n % p.opts.length]); n = Math.floor(n / p.opts.length); }
        plans.push((item) => (fixed.has(item.id) ? [fixed.get(item.id)!] : item.opts));
      }
    }
    plans.push((item) => [item.opts[item.bySize[0]]]);
  }

  // Every plan with every placement policy and base ordering, most promising
  // combinations first; then shuffled orderings while attempts remain.
  let done = 0;
  search: for (let round = 0; ; round++) {
    const base = round < orders.length;
    let order = orders[round % orders.length];
    if (!base) {
      order = [...byArea];
      const swaps = 1 + Math.floor(rand() * Math.max(1, order.length / 2));
      for (let s = 0; s < swaps; s++) {
        const a = Math.floor(rand() * order.length), b = Math.min(order.length - 1, a + 1 + Math.floor(rand() * 3));
        [order[a], order[b]] = [order[b], order[a]];
      }
    }
    for (let policy = 0; policy < 4; policy++)
      for (let p = 0; p < plans.length; p++) {
        if (done >= attempts) break search;
        // The time limit is only a safety net for slow devices; it never cuts the first pass short.
        if (round > 0 && settings.timeBudgetMs && Date.now() - start > settings.timeBudgetMs) break search;
        consider(attempt(order, W, H, cell, weights[(done + policy) % 3], overhead, policy as Policy, plans[p], settings.softMargin ?? 0, blockedRuns, firstRuns));
        done++;
        if (best!.score[0] === 0 && best!.score[1] === 1 && (settings.fixedDepth || done >= 3)) break search; // everything in one tray
      }
  }
  return { trays: best!.bins.map((b) => ({ depth: b.depth })), placements: best!.placements, unplaced: best!.unplaced };
}
