import { describe, expect, it } from 'vitest';
import { anneal, type AnnealItem } from '../src/geom/anneal';
import { rasterize, rotate } from '../src/geom/pack';
import type { Pt } from '../src/geom/hull2d';

const rect = (w: number, h: number): Pt[][] => [[[0, 0], [w, 0], [w, h], [0, h]]];
const item = (id: number, w: number, h: number, depth = 10, stackable = true): AnnealItem => ({ id, stackable, options: [{ key: 0, depth, footprint: rect(w, h) }] });

/** Independent check of a layout against the rules, on a 1 mm grid. */
function check(items: AnnealItem[], out: NonNullable<ReturnType<typeof anneal>>, W: number, H: number, maxDepth: number) {
  const cellsOf = (p: (typeof out)[0]) => {
    const it = items.find((x) => x.id === p.id)!, o = it.options.find((x) => x.key === p.key)!;
    const s = rasterize(rotate(o.footprint, p.angle), 1);
    const px = Math.round(p.tx + s.minX), py = Math.round(p.ty + s.minY), set = new Set<number>();
    for (let r = 0; r < s.runs.length; r += 3) for (let x = s.runs[r + 1]; x <= s.runs[r + 2]; x++) {
      const X = px + x, Y = py + s.runs[r];
      expect(X).toBeGreaterThanOrEqual(0); expect(X).toBeLessThan(W); expect(Y).toBeGreaterThanOrEqual(0); expect(Y).toBeLessThan(H);
      set.add(Y * 1000 + X);
    }
    return set;
  };
  const cells = out.map(cellsOf);
  const shared = (a: Set<number>, b: Set<number>) => { let n = 0; for (const c of a) if (b.has(c)) n++; return n; };
  out.forEach((p, i) => out.forEach((q, j) => {
    if (j <= i) return;
    const n = shared(cells[i], cells[j]);
    if (!n) return;
    const pu = p.under.includes(q.id), qu = q.under.includes(p.id);
    expect(pu || qu).toBe(true); // overlapping parts must be one above the other
    expect(p.depth + q.depth).toBeLessThanOrEqual(maxDepth + 1e-9);
  }));
  for (const p of out) {
    expect(p.offset + p.depth).toBeLessThanOrEqual(maxDepth + 1e-9);
    if (p.under.length) expect(p.offset).toBe(Math.max(...p.under.map((id) => out.find((q) => q.id === id)!.depth)));
  }
  // Every surface part keeps at least half its floor, unless what is beneath is hidden entirely under it.
  out.forEach((u, i) => {
    let lost = 0;
    out.forEach((l, j) => { if (l.under.includes(u.id)) { const n = shared(cells[i], cells[j]); if (n < cells[j].size) lost += n; } });
    expect(lost).toBeLessThanOrEqual(0.5 * cells[i].size + 1e-9);
  });
}

describe('anneal (whole-layout search)', () => {
  it('packs parts that a row-by-row placement would spill', () => {
    // Four 25×60 parts fill a 100×60 tray only if all stand the same way.
    const items = [0, 1, 2, 3].map((i) => item(i, 25, 60));
    const out = anneal(items, { width: 100, height: 60, maxDepth: 10, allowSink: false })!;
    expect(out).not.toBeNull();
    check(items, out, 100, 60, 10);
    expect(out.every((p) => p.under.length === 0)).toBe(true);
  });

  it('chooses the pose that makes everything fit', () => {
    // The big part fits beside the other only in its narrower, taller pose.
    const big: AnnealItem = { id: 0, stackable: false, options: [{ key: 0, depth: 30, footprint: rect(100, 60) }, { key: 1, depth: 33, footprint: rect(100, 50) }] };
    const items = [big, item(1, 100, 40, 20, false)];
    const out = anneal(items, { width: 100, height: 92, maxDepth: 40, allowSink: true })!;
    expect(out).not.toBeNull();
    check(items, out, 100, 92, 40);
    expect(out.find((p) => p.id === 0)!.key).toBe(1);
  });

  it('sinks a part under others only when there is depth for it', () => {
    // Two 50×40 pockets fill the tray; a third part must go underneath.
    const items = [item(0, 50, 40, 10), item(1, 50, 40, 10), item(2, 40, 30, 8)];
    const out = anneal(items, { width: 100, height: 40, maxDepth: 20, allowSink: true })!;
    expect(out).not.toBeNull();
    check(items, out, 100, 40, 20);
    expect(out.filter((p) => p.under.length).length).toBe(1);
    // Not enough depth for any pair (10 + 8 > 17), stacking switched off, or parts that must not stack: no layout.
    expect(anneal(items, { width: 100, height: 40, maxDepth: 17, allowSink: true, rounds: 2, iterations: 20000 })).toBeNull();
    expect(anneal(items, { width: 100, height: 40, maxDepth: 20, allowSink: false, rounds: 2, iterations: 20000 })).toBeNull();
    expect(anneal(items.map((x) => ({ ...x, stackable: false })), { width: 100, height: 40, maxDepth: 20, allowSink: true, rounds: 2, iterations: 20000 })).toBeNull();
  });

  it('leaves the stacking gap between stacked parts, and counts it against the depth', () => {
    const base = [item(0, 50, 40, 10), item(1, 50, 40, 10), item(2, 40, 30, 8)];
    const s = { width: 100, height: 40, maxDepth: 20, allowSink: true };
    // 2 mm asked for by every part: the lower one sits 12 below the surface (10 + 2 + 8 = 20 just fits).
    const out = anneal(base.map((x) => ({ ...x, gap: 2 })), s)!;
    expect(out.find((p) => p.under.length)!.offset).toBe(12);
    // The larger of the two parts' gaps applies, even if only one part asks for it.
    const one = anneal(base.map((x) => ({ ...x, gap: x.id === 2 ? 1.5 : 0 })), s)!;
    const low = one.find((p) => p.under.length)!;
    expect(low.offset).toBe(low.id === 2 || low.under.includes(2) ? 11.5 : 10);
    // 3 mm no longer fits in the depth (10 + 3 + 8 > 20).
    expect(anneal(base.map((x) => ({ ...x, gap: 3 })), { ...s, rounds: 2, iterations: 20000 })).toBeNull();
  });

  it('tucks a long part partly under two neighbours, leaving each half its floor', () => {
    // 40×40 pockets either side of a 20-wide gap; a 70×20 strip cannot hide under one of them.
    const items = [item(0, 40, 40, 10), item(1, 40, 40, 10), item(2, 70, 20, 8)];
    const out = anneal(items, { width: 100, height: 40, maxDepth: 20, allowSink: true })!;
    expect(out).not.toBeNull();
    check(items, out, 100, 40, 20);
    expect(out.find((p) => p.id === 2)!.offset).toBe(10);
  });

  it('gives the same answer every time, and uses a warm start when it is already valid', () => {
    const items = [item(0, 50, 40, 10), item(1, 50, 40, 10), item(2, 40, 30, 8), item(3, 20, 20, 5)];
    const s = { width: 100, height: 40, maxDepth: 20, allowSink: true };
    expect(anneal(items, s)).toEqual(anneal(items, s));
    const placed = [{ ...item(0, 30, 30), start: { key: 0, angle: 0, tx: 0, ty: 0 } }, { ...item(1, 30, 30), start: { key: 0, angle: 0, tx: 40, ty: 0 } }];
    expect(anneal(placed, { width: 100, height: 40, maxDepth: 10, allowSink: false })!.map((p) => [p.tx, p.ty])).toEqual([[0, 0], [30, 0]]);
  });
});
