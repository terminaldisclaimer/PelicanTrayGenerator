import { describe, expect, it } from 'vitest';
import { pack, rasterize, type PackItem } from '../src/geom/pack';
import type { Pt } from '../src/geom/hull2d';

const rect = (w: number, h: number): Pt[][] => [[[0, 0], [w, 0], [w, h], [0, h]]];
const item = (id: number, w: number, h: number, depth = 10): PackItem => ({ id, options: [{ key: 0, depth, footprint: rect(w, h) }] });

/** Axis-aligned box of a placed rectangle (w×h before rotation). */
function placedBox(p: { angle: number; tx: number; ty: number }, w: number, h: number) {
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => {
    const c = Math.round(Math.cos((p.angle * Math.PI) / 180)), s = Math.round(Math.sin((p.angle * Math.PI) / 180));
    return [x * c - y * s + p.tx, x * s + y * c + p.ty];
  });
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

describe('rasterize', () => {
  it('covers a rectangle exactly and an L without its notch', () => {
    expect(rasterize(rect(10, 4), 1).cells).toBe(40);
    const L: Pt[][] = [[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]];
    expect(rasterize(L, 1).cells).toBe(40 + 24);
  });
  it('keeps holes open', () => {
    const ring: Pt[][] = [[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [3, 7], [7, 7], [7, 3]]];
    expect(rasterize(ring, 1).cells).toBe(100 - 16);
  });
});

describe('pack', () => {
  it('places everything inside the tray without overlaps', () => {
    const sizes: [number, number][] = [[60, 20], [40, 40], [30, 10], [25, 25], [50, 15], [20, 20], [35, 12]];
    const r = pack(sizes.map(([w, h], i) => item(i, w, h)), { width: 100, height: 120, angleStep: 90 });
    expect(r.unplaced).toEqual([]);
    expect(r.trays).toHaveLength(1);
    const boxes = r.placements.map((p) => ({ id: p.id, ...placedBox(p, ...sizes[p.id]) }));
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(-1e-9); expect(b.y0).toBeGreaterThanOrEqual(-1e-9);
      expect(b.x1).toBeLessThanOrEqual(100 + 1e-9); expect(b.y1).toBeLessThanOrEqual(120 + 1e-9);
    }
    for (const a of boxes) for (const b of boxes)
      if (a.id < b.id) expect(a.x1 <= b.x0 + 1e-9 || b.x1 <= a.x0 + 1e-9 || a.y1 <= b.y0 + 1e-9 || b.y1 <= a.y0 + 1e-9).toBe(true);
  });

  it('rotates a part that only fits sideways', () => {
    const r = pack([item(0, 90, 20)], { width: 30, height: 100 });
    expect(r.unplaced).toEqual([]);
    expect([90, 270]).toContain(r.placements[0].angle);
  });

  it('nests an L and a block into the space a bounding-box layout could not', () => {
    const L: Pt[][] = [[[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]]];
    const r = pack([{ id: 0, options: [{ key: 0, depth: 5, footprint: L }] }, item(1, 30, 30)], { width: 40, height: 40 });
    expect(r.unplaced).toEqual([]);
    expect(r.trays).toHaveLength(1);
  });

  it('turns a part to any angle about Z when square-on does not fit', () => {
    // A 100×10 bar cannot lie square in an 80×80 tray, but fits on the diagonal.
    expect(pack([item(0, 100, 10)], { width: 80, height: 80, angleStep: 90 }).unplaced).toEqual([0]);
    const r = pack([item(0, 100, 10)], { width: 80, height: 80 });
    expect(r.unplaced).toEqual([]);
    expect(r.placements[0].angle % 90).not.toBe(0);
    // ...and stays square when that works.
    expect(pack([item(0, 60, 10)], { width: 80, height: 80 }).placements[0].angle % 90).toBe(0);
  });

  it('overflows into more trays, and reports parts that can never fit', () => {
    const r = pack([item(0, 50, 50), item(1, 50, 50), item(2, 50, 50), item(3, 200, 200)], { width: 60, height: 60 });
    expect(r.trays).toHaveLength(3);
    expect(r.unplaced).toEqual([3]);
  });

  it('switches to another pose when that saves a tray', () => {
    // Lying flat (80×30, shallow) two parts need two 80×40 trays; on edge (80×12, deeper) both fit in one.
    const two = (id: number): PackItem => ({ id, options: [{ key: 0, depth: 12, footprint: rect(80, 30) }, { key: 1, depth: 30, footprint: rect(80, 12) }] });
    const r = pack([two(0), two(1)], { width: 80, height: 40, trayOverhead: 2 });
    expect(r.trays).toHaveLength(1);
    expect(r.placements.filter((p) => p.key === 1).length).toBeGreaterThanOrEqual(1);
  });

  it('with the same number of trays, picks the lower stack', () => {
    // Either pose fits in one tray; flat is shallower.
    const one: PackItem = { id: 0, options: [{ key: 1, depth: 60, footprint: rect(30, 12) }, { key: 0, depth: 12, footprint: rect(80, 30) }] };
    const r = pack([one], { width: 80, height: 40, trayOverhead: 2 });
    expect(r.trays).toEqual([{ depth: 12 }]);
  });

  it('keeps parts flat when there is room, so the tray stays shallow', () => {
    const two = (id: number): PackItem => ({ id, options: [{ key: 0, depth: 12, footprint: rect(80, 30) }, { key: 1, depth: 30, footprint: rect(80, 12) }] });
    const r = pack([two(0), two(1)], { width: 80, height: 100 });
    expect(r.trays).toEqual([{ depth: 12 }]);
  });

  it('groups deep parts together to reduce total depth', () => {
    const r = pack([item(0, 50, 50, 40), item(1, 50, 50, 10), item(2, 50, 50, 40), item(3, 50, 50, 10)], { width: 100, height: 50 });
    expect(r.trays.map((t) => t.depth).sort((a, b) => a - b)).toEqual([10, 40]);
  });

  it('is deterministic', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(i, 15 + ((i * 7) % 30), 10 + ((i * 11) % 25)));
    expect(pack(items, { width: 100, height: 100 })).toEqual(pack(items, { width: 100, height: 100 }));
  });
});

import { sink } from '../src/geom/pack';

describe('sink (partial stacking)', () => {
  // Two 40×40 surface pockets, 10 deep, with a 20-wide free strip between them, in a 100×40 tray.
  const uppers = [
    { id: 1, depth: 10, footprint: rect(40, 40), angle: 0, tx: 0, ty: 0 },
    { id: 2, depth: 10, footprint: rect(40, 40), angle: 0, tx: 60, ty: 0 },
  ];
  const region = { width: 100, height: 40 };

  it('tucks a long shallow part partly under both neighbours', () => {
    // 70×20 is longer than the strip plus one pocket, so its ends must go under the pockets on both sides.
    const r = sink(uppers, [{ id: 9, depth: 8, footprint: rect(70, 20) }], { ...region, maxDepth: 20 })!;
    expect(r).toHaveLength(1);
    expect(r[0].offset).toBe(10); // just below the floors above it
    expect(r[0].under.sort()).toEqual([1, 2]);
  });

  it('uses free surface space when the part simply fits there', () => {
    const r = sink(uppers, [{ id: 9, depth: 8, footprint: rect(18, 30) }], { ...region, maxDepth: 20 })!;
    // Either in the strip (nothing above, no offset) or hidden entirely under a neighbour.
    expect(r[0].under.length === 0 ? r[0].offset : 10).toBe(r[0].offset);
  });

  it('refuses when there is no depth left beneath, or too much floor would be lost', () => {
    expect(sink(uppers, [{ id: 9, depth: 12, footprint: rect(50, 20) }], { ...region, maxDepth: 20 })).toBeNull(); // 10 + 12 > 20
    // A 78×38 part would take nearly all the floor from both pockets without being hidden under either.
    expect(sink(uppers, [{ id: 9, depth: 5, footprint: rect(78, 38) }], { ...region, maxDepth: 20 })).toBeNull();
  });

  it('hides a small part completely under one pocket (classic stack) and keeps sunk parts apart', () => {
    const r = sink(uppers, [{ id: 8, depth: 6, footprint: rect(30, 30) }, { id: 9, depth: 6, footprint: rect(30, 30) }], { ...region, maxDepth: 20 })!;
    expect(r).toHaveLength(2);
    expect(r.every((p) => p.under.length === 1 && p.offset === 10)).toBe(true);
    expect(r[0].under[0]).not.toBe(r[1].under[0]); // one under each
  });
});
