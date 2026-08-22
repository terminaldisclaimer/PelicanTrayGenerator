// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseSvgSilhouette } from '../src/lib/svg/parseSvg';
import { ringAreaAbs } from '../src/lib/geom2d';

const svg = (attrs: string, body: string) => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

describe('svg unit handling', () => {
  it('reads a millimetre document with a viewBox, the Shaper Origin convention', () => {
    // 100 x 60 mm document, viewBox in 96 dpi user units.
    const doc = svg(
      'width="100mm" height="60mm" viewBox="0 0 377.95 226.77"',
      '<rect x="37.795" y="37.795" width="302.36" height="151.18"/>',
    );
    const { poly, size } = parseSvgSilhouette(doc);
    expect(size.w).toBeCloseTo(80, 1);
    expect(size.h).toBeCloseTo(40, 1);
    expect(ringAreaAbs(poly[0])).toBeCloseTo(3200, 0);
  });

  it('reads a document whose user units are already millimetres', () => {
    const doc = svg('width="120mm" height="80mm" viewBox="0 0 120 80"', '<rect width="60" height="30"/>');
    const { size } = parseSvgSilhouette(doc);
    expect(size.w).toBeCloseTo(60, 3);
    expect(size.h).toBeCloseTo(30, 3);
  });

  it('falls back to 96 dpi when there are no real-world units', () => {
    const { size, notes } = parseSvgSilhouette(svg('viewBox="0 0 400 400"', '<rect width="96" height="192"/>'));
    expect(size.w).toBeCloseTo(25.4, 2);
    expect(size.h).toBeCloseTo(50.8, 2);
    expect(notes.join(' ')).toMatch(/96 dpi/);
  });

  it('handles inches', () => {
    const { size } = parseSvgSilhouette(svg('width="2in" height="1in" viewBox="0 0 200 100"', '<rect width="100" height="50"/>'));
    expect(size.w).toBeCloseTo(25.4, 2);
  });
});

describe('svg shape handling', () => {
  it('applies nested transforms', () => {
    const doc = svg(
      'width="200mm" height="200mm" viewBox="0 0 200 200"',
      '<g transform="translate(20,20)"><g transform="scale(2)"><rect width="30" height="10"/></g></g>',
    );
    const { size } = parseSvgSilhouette(doc);
    expect(size.w).toBeCloseTo(60, 3);
    expect(size.h).toBeCloseTo(20, 3);
  });

  it('detects an interior outline as a hole', () => {
    const doc = svg(
      'width="100mm" height="100mm" viewBox="0 0 100 100"',
      '<rect width="80" height="80"/><circle cx="40" cy="40" r="10"/>',
    );
    const { poly, notes } = parseSvgSilhouette(doc);
    expect(poly).toHaveLength(2);
    // Circles are circumscribed so a round pocket is never undersized.
    expect(ringAreaAbs(poly[1])).toBeGreaterThanOrEqual(Math.PI * 100);
    expect(ringAreaAbs(poly[1])).toBeLessThan(Math.PI * 100 * 1.005);
    expect(notes.join(' ')).toMatch(/interior outline/);
  });

  it('ignores outlines that sit outside the main silhouette', () => {
    const doc = svg(
      'width="300mm" height="100mm" viewBox="0 0 300 100"',
      '<rect width="80" height="80"/><rect x="200" y="10" width="20" height="20"/>',
    );
    const { poly, notes } = parseSvgSilhouette(doc);
    expect(poly).toHaveLength(1);
    expect(notes.join(' ')).toMatch(/ignored/);
  });

  it('supports circles, ellipses, polygons and paths', () => {
    for (const body of [
      '<circle cx="20" cy="20" r="15"/>',
      '<ellipse cx="30" cy="20" rx="25" ry="12"/>',
      '<polygon points="0,0 40,0 40,25 0,25"/>',
      '<path d="M0 0 L40 0 L40 25 Z"/>',
    ]) {
      const { poly } = parseSvgSilhouette(svg('width="100mm" height="100mm" viewBox="0 0 100 100"', body));
      expect(ringAreaAbs(poly[0])).toBeGreaterThan(100);
    }
  });

  it('skips geometry inside defs and clipPath', () => {
    const doc = svg(
      'width="300mm" height="100mm" viewBox="0 0 300 100"',
      '<defs><rect x="200" width="90" height="90"/></defs><rect width="40" height="40"/>',
    );
    const { size } = parseSvgSilhouette(doc);
    expect(size.w).toBeCloseTo(40, 3);
  });

  it('reports a helpful error when there is nothing to use', () => {
    expect(() => parseSvgSilhouette(svg('width="10mm" height="10mm" viewBox="0 0 10 10"', '<line x1="0" y1="0" x2="5" y2="5"/>')))
      .toThrow(/no closed outlines/i);
  });
});
