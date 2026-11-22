/**
 * Whole-layout search for fitting every part into ONE tray.
 *
 * Each part has a pose, an angle about the vertical axis, a position, and a
 * level: on the tray surface, or sunk beneath other parts. A layout is scored
 * as a whole — how much pockets collide or break the stacking rules — and
 * improved by simulated annealing: move, turn, re-pose, swap or sink one part
 * at a time, always keeping improvements and sometimes accepting a worse
 * layout to get out of dead ends. The amount of work is fixed (not timed) and
 * the random numbers are seeded, so the same input gives the same result.
 *
 * Rules a valid layout satisfies (footprints are pre-grown by half a wall):
 *  - surface parts do not overlap each other; sunk parts do not overlap each other;
 *  - a sunk part may lie under surface parts whose pocket depth plus its own
 *    (plus the stacking gap of the pair) fits within `maxDepth`; it sits that
 *    gap below the deepest pocket above it;
 *  - finger holes may overlap each other but stay out of other parts'
 *    footprints (same level) and inside the tray;
 *  - a surface part keeps at least (1 − maxCover) of its floor, not counting
 *    sunk parts hidden entirely beneath it (it rests on those).
 */
import { rasterizeOption, type PackOption, type Shape } from './pack';

export interface AnnealItem {
  id: number;
  options: PackOption[];
  /** May this part be sunk under others, or have others sunk under it? */
  stackable: boolean;
  /** Vertical room (mm) to leave between this part and one stacked with it. Default 0. */
  gap?: number;
  /** Where a previous layout put it (optional warm start). */
  start?: { key: number; angle: number; tx: number; ty: number };
}
export interface AnnealSettings {
  width: number; height: number; cell?: number;
  /** Cells of tray material a finger hole must leave to the edge of the region. */
  softMargin?: number;
  /** Deepest pocket allowed, including anything stacked. */
  maxDepth: number;
  allowSink: boolean;
  maxCover?: number;
  angleStep?: number;
  /** Moves per round and number of rounds (work is fixed, not timed). */
  iterations?: number;
  rounds?: number;
  seed?: number;
}
export interface AnnealPlacement {
  id: number; key: number; angle: number; tx: number; ty: number; depth: number;
  /** Depth of the pocket top below the tray surface (0 = at the surface). */
  offset: number;
  /** Surface parts lying (partly) above this one. */
  under: number[];
}

/** Largest leftover overlap (in grid cells) that is still accepted as a valid layout. */
const TOLERANCE = 1.5;

interface Sh extends Shape { rows: Int32Array }

function withRows(s: Shape): Sh {
  const rows = new Int32Array(s.h + 1);
  let r = 0;
  for (let y = 0; y <= s.h; y++) {
    while (r < s.runs.length && s.runs[r] < y) r += 3;
    rows[y] = r;
  }
  return Object.assign(s, { rows });
}

/** Number of grid cells two placed shapes share. */
function overlap(A: Sh, ax: number, ay: number, B: Sh, bx: number, by: number): number {
  if (ax + A.w <= bx || bx + B.w <= ax) return 0;
  const y0 = Math.max(ay, by), y1 = Math.min(ay + A.h, by + B.h);
  let sum = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y - ay, rb = y - by;
    for (let i = A.rows[ra]; i < A.rows[ra + 1]; i += 3) {
      const a0 = ax + A.runs[i + 1], a1 = ax + A.runs[i + 2];
      for (let j = B.rows[rb]; j < B.rows[rb + 1]; j += 3) {
        const lo = Math.max(a0, bx + B.runs[j + 1]), hi = Math.min(a1, bx + B.runs[j + 2]);
        if (hi >= lo) sum += hi - lo + 1;
      }
    }
  }
  return sum;
}

/** Cells of A's finger holes that fall on B's footprint. */
function intrusion(A: Sh, ax: number, ay: number, B: Sh, bx: number, by: number): number {
  const f = A.soft;
  if (!f || !f.length) return 0;
  let sum = 0;
  for (let i = 0; i < f.length; i += 3) {
    const rb = ay + f[i] - by;
    if (rb < 0 || rb >= B.h) continue;
    const a0 = ax + f[i + 1], a1 = ax + f[i + 2];
    if (a1 < bx || a0 >= bx + B.w) continue;
    for (let j = B.rows[rb]; j < B.rows[rb + 1]; j += 3) {
      const lo = Math.max(a0, bx + B.runs[j + 1]), hi = Math.min(a1, bx + B.runs[j + 2]);
      if (hi >= lo) sum += hi - lo + 1;
    }
  }
  return sum;
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

/** Find a valid one-tray layout, or null if none was found. */
export function anneal(items: AnnealItem[], settings: AnnealSettings): AnnealPlacement[] | null {
  const n = items.length;
  if (!n) return [];
  const cell = settings.cell ?? 1, maxCover = settings.maxCover ?? 0.5, D = settings.maxDepth + 1e-9;
  const W = Math.floor(settings.width / cell + 1e-9), H = Math.floor(settings.height / cell + 1e-9);
  const step = Math.min(90, Math.max(1, settings.angleStep ?? 15));
  const angles: number[] = [0, 90, 180, 270];
  for (let a = step; a < 360; a += step) if (a % 90 !== 0) angles.push(a);
  const rand = mulberry32(settings.seed ?? 1);
  const ri = (k: number) => Math.floor(rand() * k);

  // Rasterised footprint of item i, option o, angle a — made on first use.
  const cache: (Sh | null | undefined)[][][] = items.map((it) => it.options.map(() => new Array(angles.length).fill(undefined)));
  const shape = (i: number, o: number, a: number): Sh | null => {
    let s = cache[i][o][a];
    if (s === undefined) {
      const r = withRows(rasterizeOption(items[i].options[o], angles[a], cell));
      s = r.w <= W && r.h <= H ? r : null; // null = does not fit the tray at this angle
      cache[i][o][a] = s;
    }
    return s;
  };

  // ---- state ----
  const opt = new Int32Array(n), ang = new Int32Array(n), px = new Int32Array(n), py = new Int32Array(n), sunk = new Uint8Array(n);
  const sh: Sh[] = new Array(n);
  const ov = new Float64Array(n * n); // pairwise shared footprint cells
  const fv = new Float64Array(n * n); // finger holes of either cutting into the other's footprint
  const out = new Float64Array(n); // finger-hole cells too close to, or past, the tray edge
  const margin = settings.softMargin ?? 0;
  const covered = new Float64Array(n);
  const outside = new Float64Array(n);

  const place = (i: number, o: number, a: number, x: number, y: number): boolean => {
    const s = shape(i, o, a);
    if (!s) return false;
    opt[i] = o; ang[i] = a; sh[i] = s;
    px[i] = Math.max(0, Math.min(W - s.w, x)); py[i] = Math.max(0, Math.min(H - s.h, y));
    return true;
  };
  const refresh = (i: number) => {
    let o = 0;
    const f = sh[i].soft;
    if (f)
      for (let r = 0; r < f.length; r += 3) {
        const row = py[i] + f[r], x0 = px[i] + f[r + 1], x1 = px[i] + f[r + 2];
        if (row < margin || row >= H - margin) { o += x1 - x0 + 1; continue; }
        if (x0 < margin) o += Math.min(x1, margin - 1) - x0 + 1;
        if (x1 >= W - margin) o += x1 - Math.max(x0, W - margin) + 1;
      }
    out[i] = o;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const v = overlap(sh[i], px[i], py[i], sh[j], px[j], py[j]);
      ov[i * n + j] = v; ov[j * n + i] = v;
      const f = intrusion(sh[i], px[i], py[i], sh[j], px[j], py[j]) + intrusion(sh[j], px[j], py[j], sh[i], px[i], py[i]);
      fv[i * n + j] = f; fv[j * n + i] = f;
    }
  };
  const depthOf = (i: number) => items[i].options[opt[i]].depth;
  /** Room to leave between two stacked parts: the larger of what each asks for. */
  const gapOf = (i: number, j: number) => Math.max(items[i].gap ?? 0, items[j].gap ?? 0);

  /** [rule violations in cells, secondary cost (stack count and tray depth)]. */
  const score = (): [number, number] => {
    let bad = 0;
    covered.fill(0);
    outside.fill(0);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const v = ov[i * n + j];
        if (sunk[i] === sunk[j]) { bad += v + fv[i * n + j]; continue; } // same level: no overlap, no finger hole in a neighbour's pocket
        if (!v) continue;
        const u = sunk[i] ? j : i, l = sunk[i] ? i : j; // u on the surface, l beneath
        if (!items[u].stackable || depthOf(u) + gapOf(u, l) + depthOf(l) > D) { bad += v; continue; }
        if (v < sh[l].cells) { covered[u] += v; outside[u] += sh[l].cells - v; } // not hidden entirely: u loses that much floor
      }
    let stacked = 0, depth = 0;
    for (let i = 0; i < n; i++) {
      bad += out[i];
      if (!sunk[i]) {
        // Too much floor lost: valid again either by uncovering some, or by pushing
        // what is beneath fully under — charge whichever is nearer, so the search
        // is led towards a fix instead of over a cliff.
        const excess = covered[i] - maxCover * sh[i].cells;
        if (excess > 0) bad += Math.min(excess, outside[i]);
        depth = Math.max(depth, depthOf(i));
      } else {
        let offset = 0;
        for (let j = 0; j < n; j++) if (!sunk[j] && ov[i * n + j]) offset = Math.max(offset, depthOf(j) + gapOf(i, j));
        if (offset) stacked++;
        depth = Math.max(depth, offset + depthOf(i));
      }
    }
    return [bad, stacked * 4 + depth * 0.2];
  };

  // ---- starting layout ----
  for (let i = 0; i < n; i++) {
    const it = items[i];
    let ok = false;
    if (it.start) {
      const o = it.options.findIndex((x) => x.key === it.start!.key), a = angles.indexOf(it.start.angle);
      const s = o >= 0 && a >= 0 ? shape(i, o, a) : null;
      if (s) ok = place(i, o, a, Math.round((it.start.tx + s.minX) / cell), Math.round((it.start.ty + s.minY) / cell));
    }
    for (let o = 0; o < it.options.length && !ok; o++)
      for (let a = 0; a < angles.length && !ok; a++) ok = place(i, o, a, ri(W), ri(H));
    if (!ok) return null; // some part does not fit the tray in any pose
  }
  for (let i = 0; i < n; i++) refresh(i);

  const snapshot = () => ({ opt: opt.slice(), ang: ang.slice(), px: px.slice(), py: py.slice(), sunk: sunk.slice() });
  const restore = (s: ReturnType<typeof snapshot>) => {
    opt.set(s.opt); ang.set(s.ang); px.set(s.px); py.set(s.py); sunk.set(s.sunk);
    for (let i = 0; i < n; i++) sh[i] = shape(i, opt[i], ang[i])!;
    for (let i = 0; i < n; i++) refresh(i);
  };

  let cur = score(), best = cur, bestState = snapshot();
  const iterations = settings.iterations ?? 60000, rounds = settings.rounds ?? 4;
  const canSink = (i: number) => settings.allowSink && items[i].stackable;
  const rowBackup = new Float64Array(n), rowBackup2 = new Float64Array(n), fBackup = new Float64Array(n), fBackup2 = new Float64Array(n);
  let heat = 0;
  for (let i = 0; i < n; i++) heat += sh[i].cells;
  heat = (0.15 * heat) / n;

  /** One annealing pass from the current state, cooling from T0 to T1. `weigh` turns a score into the number being minimised. */
  const run = (T0: number, T1: number, moves: number, weigh: (s: [number, number]) => number) => {
    const total = weigh;
    for (let it = 0; it < moves; it++) {
      const T = T0 * Math.pow(T1 / T0, it / moves);
      const i = ri(n);
      const old = { o: opt[i], a: ang[i], x: px[i], y: py[i], k: sunk[i], s: sh[i], out: out[i] };
      for (let j = 0; j < n; j++) { rowBackup[j] = ov[i * n + j]; fBackup[j] = fv[i * n + j]; }
      let j2 = -1, old2: typeof old | null = null;
      const r = rand();
      let ok = true;
      if (r < 0.4) { // nudge, further while hot
        const reach = Math.max(2, Math.round(Math.max(W, H) * 0.5 * (T / T0)));
        ok = place(i, opt[i], ang[i], px[i] + ri(2 * reach + 1) - reach, py[i] + ri(2 * reach + 1) - reach);
      } else if (r < 0.55) { // turn about its centre (quarter turns half the time)
        const a = rand() < 0.5 ? ri(4) : ri(angles.length);
        const cx = px[i] + sh[i].w / 2, cy = py[i] + sh[i].h / 2, s = shape(i, opt[i], a);
        ok = !!s && place(i, opt[i], a, Math.round(cx - s.w / 2), Math.round(cy - s.h / 2));
      } else if (r < 0.65) { // another pose
        if (items[i].options.length < 2) continue;
        const o = ri(items[i].options.length);
        const cx = px[i] + sh[i].w / 2, cy = py[i] + sh[i].h / 2, s = shape(i, o, ang[i]);
        ok = !!s && place(i, o, ang[i], Math.round(cx - s.w / 2), Math.round(cy - s.h / 2));
      } else if (r < 0.7) { // jump anywhere
        ok = place(i, opt[i], ang[i], ri(W), ri(H));
      } else if (r < 0.8) { // butt up against a wall or another part (finds tight fits)
        const k = ri(n + 1); // n = the tray walls
        let x = px[i], y = py[i];
        const side = ri(4);
        if (k === n || k === i) {
          if (side === 0) x = 0; else if (side === 1) x = W - sh[i].w; else if (side === 2) y = 0; else y = H - sh[i].h;
        } else if (side === 0) x = px[k] + sh[k].w; else if (side === 1) x = px[k] - sh[i].w; else if (side === 2) y = py[k] + sh[k].h; else y = py[k] - sh[i].h;
        ok = place(i, opt[i], ang[i], x, y);
      } else if (r < 0.88) { // swap places with another part
        if (n < 2) continue;
        j2 = (i + 1 + ri(n - 1)) % n;
        old2 = { o: opt[j2], a: ang[j2], x: px[j2], y: py[j2], k: sunk[j2], s: sh[j2], out: out[j2] };
        for (let j = 0; j < n; j++) { rowBackup2[j] = ov[j2 * n + j]; fBackup2[j] = fv[j2 * n + j]; }
        const cix = px[i] + sh[i].w / 2, ciy = py[i] + sh[i].h / 2, cjx = px[j2] + sh[j2].w / 2, cjy = py[j2] + sh[j2].h / 2;
        place(i, opt[i], ang[i], Math.round(cjx - sh[i].w / 2), Math.round(cjy - sh[i].h / 2));
        place(j2, opt[j2], ang[j2], Math.round(cix - sh[j2].w / 2), Math.round(ciy - sh[j2].h / 2));
      } else { // sink it under others, or bring it back to the surface
        if (!canSink(i)) continue;
        sunk[i] = sunk[i] ? 0 : 1;
      }
      if (!ok) { opt[i] = old.o; ang[i] = old.a; px[i] = old.x; py[i] = old.y; sh[i] = old.s; continue; }
      refresh(i);
      if (j2 >= 0) refresh(j2);
      const next = score(), delta = total(next) - total(cur);
      if (delta <= 0 || rand() < Math.exp(-delta / T)) {
        cur = next;
        if (total(cur) < total(best)) { best = cur; bestState = snapshot(); }
      } else {
        opt[i] = old.o; ang[i] = old.a; px[i] = old.x; py[i] = old.y; sunk[i] = old.k; sh[i] = old.s; out[i] = old.out;
        if (j2 >= 0 && old2) {
          out[j2] = old2.out;
          opt[j2] = old2.o; ang[j2] = old2.a; px[j2] = old2.x; py[j2] = old2.y; sunk[j2] = old2.k; sh[j2] = old2.s;
          for (let j = 0; j < n; j++) { ov[j2 * n + j] = rowBackup2[j]; ov[j * n + j2] = rowBackup2[j]; fv[j2 * n + j] = fBackup2[j]; fv[j * n + j2] = fBackup2[j]; }
        }
        for (let j = 0; j < n; j++) { ov[i * n + j] = rowBackup[j]; ov[j * n + i] = rowBackup[j]; fv[i * n + j] = fBackup[j]; fv[j * n + i] = fBackup[j]; }
        if (j2 >= 0) { refresh(i); }
      }
    }
  };

  let totalCells = 0;
  for (let i = 0; i < n; i++) totalCells += sh[i].cells;
  const feasibility = (s: [number, number]) => s[0] + 0.01 * s[1];
  for (let round = 0; round < rounds && best[0] > TOLERANCE; round++) {
    if (round % 2 === 1) {
      // Odd rounds: a fresh random layout, in case the starting one sits in a dead end.
      for (let i = 0; i < n; i++) { place(i, opt[i], ang[i], ri(W), ri(H)); sunk[i] = 0; }
      for (let i = 0; i < n; i++) refresh(i);
      cur = score();
    } else if (round) { restore(bestState); cur = best; }
    // Start hot enough that a whole part's worth of overlap is often accepted, so
    // parts can pass through each other early on; cool to near-greedy.
    run(heat / (1 + Math.floor(round / 2)), 0.3, iterations, feasibility);
  }
  // Nearly there (a sliver of overlap left)? Keep working on the best layout, gently.
  for (let extra = 0; extra < 6 && best[0] > TOLERANCE && best[0] < 0.03 * totalCells; extra++) {
    restore(bestState); cur = best;
    run(heat * 0.08, 0.2, iterations, feasibility);
  }
  if (best[0] <= TOLERANCE) {
    // A valid layout exists. Now improve it without breaking it: fewer stacked
    // parts first, then a shallower tray.
    const quality = (s: [number, number]) => s[0] * 1000 + s[1];
    restore(bestState); cur = best;
    const before = best, beforeState = bestState;
    best = cur;
    run(3, 0.05, Math.round(iterations / 2), quality);
    if (best[0] > before[0] || quality(best) > quality(before)) { best = before; bestState = beforeState; }
  }
  restore(bestState);
  // Footprints carry about 1 mm of slack each beyond the half wall (for the
  // grid), so a leftover overlap of a single 1 mm cell still leaves the full
  // wall between pockets. Anything more is a real clash.
  if (best[0] > TOLERANCE) return null;

  // ---- tidy up: square parts to the tray and settle them down/left where that changes nothing else ----
  cur = score();
  const tryKeep = (i: number, o: number, a: number, x: number, y: number): boolean => {
    const old = { o: opt[i], a: ang[i], x: px[i], y: py[i], s: sh[i] };
    if (!place(i, o, a, x, y) || (px[i] === old.x && py[i] === old.y && ang[i] === old.a)) { opt[i] = old.o; ang[i] = old.a; px[i] = old.x; py[i] = old.y; sh[i] = old.s; return false; }
    refresh(i);
    const next = score();
    if (next[0] <= cur[0] && next[1] <= cur[1] + 1e-9) { cur = next; return true; }
    opt[i] = old.o; ang[i] = old.a; px[i] = old.x; py[i] = old.y; sh[i] = old.s;
    refresh(i);
    return false;
  };
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < n; i++) {
      let touching = false;
      for (let j = 0; j < n; j++) if (j !== i && (ov[i * n + j] || fv[i * n + j])) touching = true;
      if (out[i]) touching = true;
      if (touching) continue; // leave stacked parts exactly as found
      if (angles[ang[i]] % 90 !== 0) {
        const q = Math.round(angles[ang[i]] / 90) % 4, s = shape(i, opt[i], q);
        if (s) tryKeep(i, opt[i], q, Math.round(px[i] + sh[i].w / 2 - s.w / 2), Math.round(py[i] + sh[i].h / 2 - s.h / 2));
      }
      while (py[i] > 0 && tryKeep(i, opt[i], ang[i], px[i], py[i] - 1)) { /* settle down */ }
      while (px[i] > 0 && tryKeep(i, opt[i], ang[i], px[i] - 1, py[i])) { /* settle left */ }
    }

  return items.map((it, i) => {
    const under: number[] = [];
    let offset = 0;
    if (sunk[i]) for (let j = 0; j < n; j++) if (!sunk[j] && ov[i * n + j]) { under.push(items[j].id); offset = Math.max(offset, depthOf(j) + gapOf(i, j)); }
    return { id: it.id, key: it.options[opt[i]].key, angle: angles[ang[i]], tx: px[i] * cell - sh[i].minX, ty: py[i] * cell - sh[i].minY, depth: depthOf(i), offset, under };
  });
}
