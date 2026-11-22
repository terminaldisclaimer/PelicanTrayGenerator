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
  /** True when the tray depth is fixed by the user: a deeper pose then costs nothing. */
  fixedDepth?: boolean;
  /** Height every tray adds on top of its deepest pocket (the floor), mm. */
  trayOverhead?: number;
}


interface Shape { runs: Int32Array; w: number; h: number; minX: number; minY: number; cells: number }
interface Opt { key: number; depth: number; shapes: Shape[]; angles: number[] }
interface Prepared { id: number; opts: Opt[]; area: number; maxDim: number; minDepth: number; /** Option indices by footprint size, smallest first. */ bySize: number[] }

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
  right = 0; // rightmost occupied column + 1
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

function attempt(order: Prepared[], W: number, H: number, cell: number, depthWeight: number, overhead: number, policy: Policy = 0, choose?: (item: Prepared) => Opt[]): Solution {
  const bins: Bin[] = [];
  const placements: PackPlacement[] = [];
  const unplaced: number[] = [];
  for (const item of order) {
    let done = false;
    for (let b = 0; b <= bins.length && !done; b++) {
      const bin = b < bins.length ? bins[b] : new Bin(W, H);
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
    const opts = it.options.map((o) => ({ key: o.key, depth: o.depth, angles, shapes: angles.map((a) => rasterize(rotate(o.footprint, a), cell)) }));
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
        consider(attempt(order, W, H, cell, weights[(done + policy) % 3], overhead, policy as Policy, plans[p]));
        done++;
        if (best!.score[0] === 0 && best!.score[1] === 1 && (settings.fixedDepth || done >= 3)) break search; // everything in one tray
      }
  }
  return { trays: best!.bins.map((b) => ({ depth: b.depth })), placements: best!.placements, unplaced: best!.unplaced };
}

// ---------------------------------------------------------------------------
// Partial stacking: sink extra parts under the ones already laid out.
// ---------------------------------------------------------------------------

/** A part already placed at the tray surface (from `pack`). */
export interface SinkUpper { id: number; depth: number; footprint: Pt[][]; angle: number; tx: number; ty: number; /** True = nothing may be tucked under this part. */ noCover?: boolean }
/** A part to tuck underneath. */
export interface SinkLower { id: number; depth: number; footprint: Pt[][] }
export interface SinkPlacement {
  id: number; angle: number; tx: number; ty: number;
  /** How far the top of this part's pocket sits below the tray surface. */
  offset: number;
  /** Surface parts that lie (partly) above this one. */
  under: number[];
}
export interface SinkSettings {
  width: number; height: number; cell?: number;
  /** Deepest pocket allowed (set by the deepest part). */
  maxDepth: number;
  /** Most of a surface part's footprint that may hang over lower pockets (it rests on the remainder). */
  maxCover?: number;
}

const SINK_ANGLES = [0, 90, 180, 270, 45, 135, 225, 315];

/**
 * Place each lower part somewhere in the tray where every cell of its
 * footprint is either free at the surface (its open shaft) or lies under a
 * surface part whose pocket is shallow enough to leave room beneath:
 * offset = deepest pocket above it, and offset + its own depth ≤ maxDepth.
 * A surface part may lose at most `maxCover` of its floor this way, unless
 * the lower part is hidden entirely beneath it (then it rests on that part).
 * Lower parts never overlap each other. Positions that hide the most of the
 * lower part win. Returns null if any part cannot be placed.
 */
export function sink(uppers: SinkUpper[], lowers: SinkLower[], settings: SinkSettings): SinkPlacement[] | null {
  const cell = settings.cell ?? 1, maxCover = settings.maxCover ?? 0.5;
  const W = Math.floor(settings.width / cell + 1e-9), H = Math.floor(settings.height / cell + 1e-9);
  // owner[y*W+x]: 0 = free at the surface, k>0 = index+1 of the surface part there, -1 = shaft of a sunk part.
  const owner = new Int16Array(W * H);
  const lowerGrid = new Uint8Array(W * H);
  const cells = new Int32Array(uppers.length + 1); // footprint size of each surface part
  const covered = new Int32Array(uppers.length + 1); // how much of it already hangs over lower pockets
  uppers.forEach((u, i) => {
    const s = rasterize(rotate(u.footprint, u.angle), cell);
    const px = Math.round((u.tx + s.minX) / cell), py = Math.round((u.ty + s.minY) / cell);
    for (let r = 0; r < s.runs.length; r += 3) {
      const y = py + s.runs[r];
      if (y < 0 || y >= H) continue;
      for (let x = Math.max(0, px + s.runs[r + 1]); x <= Math.min(W - 1, px + s.runs[r + 2]); x++) { owner[y * W + x] = i + 1; cells[i + 1]++; }
    }
  });

  const out: SinkPlacement[] = [];
  const order = lowers.map((l) => ({ l, shapes: SINK_ANGLES.map((a) => rasterize(rotate(l.footprint, a), cell)) })).sort((a, b) => b.shapes[0].cells - a.shapes[0].cells);
  const hit = new Int32Array(uppers.length + 1);
  for (const { l, shapes } of order) {
    let best: { hidden: number; a: number; px: number; py: number; offset: number; under: number[] } | null = null;
    for (let a = 0; a < shapes.length; a++) {
      const s = shapes[a];
      if (s.w > W || s.h > H) continue;
      for (let py = 0; py <= H - s.h; py += 2)
        position: for (let px = 0; px <= W - s.w; px += 2) {
          hit.fill(0);
          let hidden = 0;
          for (let r = 0; r < s.runs.length; r += 3) {
            const row = (py + s.runs[r]) * W + px;
            for (let i = row + s.runs[r + 1], e = row + s.runs[r + 2]; i <= e; i++) {
              if (lowerGrid[i] || owner[i] < 0) continue position; // another sunk part or its shaft
              const o = owner[i];
              if (o > 0) {
                if (uppers[o - 1].noCover) continue position;
                hit[o]++; hidden++;
              }
            }
          }
          if (best && hidden <= best.hidden) continue; // cannot beat the best so far
          let offset = 0;
          const under: number[] = [];
          let ok = true;
          for (let o = 1; o < hit.length && ok; o++) {
            if (!hit[o]) continue;
            const whollyBeneath = hit[o] === s.cells; // classic stack: the top part rests on this one
            if (!whollyBeneath && (covered[o] + hit[o]) / cells[o] > maxCover) ok = false;
            offset = Math.max(offset, uppers[o - 1].depth);
            under.push(uppers[o - 1].id);
          }
          if (!ok || offset + l.depth > settings.maxDepth + 1e-9) continue;
          best = { hidden, a, px, py, offset, under };
        }
    }
    if (!best) return null;
    const s = shapes[best.a];
    for (let r = 0; r < s.runs.length; r += 3) {
      const row = (best.py + s.runs[r]) * W + best.px;
      for (let i = row + s.runs[r + 1], e = row + s.runs[r + 2]; i <= e; i++) {
        lowerGrid[i] = 1;
        if (owner[i] > 0) covered[owner[i]]++;
        else owner[i] = -1;
      }
    }
    out.push({ id: l.id, angle: SINK_ANGLES[best.a], tx: best.px * cell - s.minX, ty: best.py * cell - s.minY, offset: best.offset, under: best.under });
  }
  return out;
}
