import { describe, expect, it } from 'vitest';
import { parseSTL, writeSTL } from '../src/mesh/stl';
import { parse3MF } from '../src/mesh/threemf';
import { centerOnBed, looksLikeInches, meshBounds, scaleMesh, size } from '../src/mesh/bounds';
import { asciiSTL, box3MF, boxMesh } from './fixtures';

describe('STL', () => {
  it('round-trips binary STL', () => {
    const box = boxMesh(10, 20, 30);
    const back = parseSTL(writeSTL(box));
    expect(back.positions.length).toBe(12 * 9);
    expect(Array.from(back.positions)).toEqual(Array.from(box.positions));
  });

  it('parses ASCII STL', () => {
    const text = asciiSTL(boxMesh(4, 5, 6));
    const m = parseSTL(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(size(meshBounds(m))).toEqual([4, 5, 6]);
  });

  it('treats a binary file whose header starts with "solid" as binary', () => {
    const buf = writeSTL(boxMesh(1, 2, 3));
    new Uint8Array(buf).set(new TextEncoder().encode('solid exported-by-cad'), 0);
    expect(parseSTL(buf).positions.length).toBe(108);
  });

  it('rejects garbage', () => {
    expect(() => parseSTL(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow();
  });
});

describe('3MF', () => {
  it('parses a simple model with its name', () => {
    const [m] = parse3MF(box3MF());
    expect(m.name).toBe('widget');
    expect(size(meshBounds(m))).toEqual([10, 20, 5]);
  });

  it('converts units to mm', () => {
    const [m] = parse3MF(box3MF({ unit: 'inch' }));
    expect(size(meshBounds(m))[0]).toBeCloseTo(254);
  });

  it('applies build item transforms (90° about Z + translate)', () => {
    const [m] = parse3MF(box3MF({ transform: '0 1 0 -1 0 0 0 0 1 50 0 0' }));
    const b = meshBounds(m);
    expect(size(b)[0]).toBeCloseTo(20);
    expect(size(b)[1]).toBeCloseTo(10);
    expect(b.max[0]).toBeCloseTo(50);
  });

  it('flattens components', () => {
    const [m] = parse3MF(box3MF({ component: true }));
    expect(meshBounds(m).min[0]).toBeCloseTo(100);
    expect(m.name).toBe('assembly');
  });
});

describe('bounds & units', () => {
  it('centres on bed', () => {
    const b = meshBounds(centerOnBed(boxMesh(10, 20, 30)));
    expect(b.min).toEqual([-5, -10, 0]);
    expect(b.max).toEqual([5, 10, 30]);
  });

  it('flags inch-sized parts and scales them', () => {
    const tiny = boxMesh(2, 3, 1);
    expect(looksLikeInches(meshBounds(tiny))).toBe(true);
    const mm = scaleMesh(tiny, 25.4);
    expect(looksLikeInches(meshBounds(mm))).toBe(false);
    expect(size(meshBounds(mm))[0]).toBeCloseTo(50.8);
  });
});
