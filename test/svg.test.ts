// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseSvgSilhouette } from '../src/lib/svg/parseSvg';
import { partSize } from '../src/lib/part';
import type { PartInput } from '../src/types';
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

describe('documents with no real-world size', () => {
  // An Illustrator export with only a viewBox: the SVG spec gives it no
  // intrinsic physical size, so the parser has to guess and must say so.
  const noSize = svg('viewBox="0 0 112.63 251.35"', '<rect x="0" y="0" width="112.63" height="251.35"/>');

  it('flags the guess instead of quietly getting it wrong', () => {
    const r = parseSvgSilhouette(noSize);
    expect(r.unitsAmbiguous).toBe(true);
    expect(r.unitMm).toBeCloseTo(25.4 / 96, 6);
    expect(r.notes.join(' ')).toMatch(/no real-world size/i);
    // 96 dpi reading of the same drawing.
    expect(r.size.h).toBeCloseTo(251.35 * (25.4 / 96), 2);
  });

  it('a unit override rescales the outline', () => {
    const r = parseSvgSilhouette(noSize);
    const base: PartInput = {
      id: 'x', name: 'x', poly: r.poly, keepHoles: false, depth: 10, qty: 1,
      groupId: null, sourceFile: '', notes: r.notes,
      sourceUnitMm: r.unitMm, unitOverrideMm: null, unitsAmbiguous: r.unitsAmbiguous,
    };
    expect(partSize(base).h).toBeCloseTo(251.35 * (25.4 / 96), 2);

    // Telling it the drawing is in points gives the true size.
    const asPoints = { ...base, unitOverrideMm: 25.4 / 72 };
    expect(partSize(asPoints).h).toBeCloseTo(251.35 * (25.4 / 72), 2);
    expect(partSize(asPoints).h / partSize(base).h).toBeCloseTo(96 / 72, 6);

    const asMm = { ...base, unitOverrideMm: 1 };
    expect(partSize(asMm).h).toBeCloseTo(251.35, 2);
  });

  it('leaves documents that do declare a size alone', () => {
    const r = parseSvgSilhouette(svg('width="100mm" height="60mm" viewBox="0 0 100 60"', '<rect width="80" height="40"/>'));
    expect(r.unitsAmbiguous).toBe(false);
    expect(r.size.w).toBeCloseTo(80, 3);
  });

  it('an override can correct a file whose declared size is a lie', () => {
    // Some exporters draw in millimetres but stamp width/height as if the
    // units were 96 dpi pixels - the declared size is exactly units*25.4/96.
    const lying = svg('width="26.458mm" height="26.458mm" viewBox="0 0 100 100"', '<rect width="100" height="60"/>');
    const r = parseSvgSilhouette(lying);
    expect(r.unitsAmbiguous).toBe(false);        // it *declares* a size...
    expect(r.size.w).toBeCloseTo(26.458, 2);     // ...and is honoured as-is
    const base: PartInput = {
      id: 'x', name: 'x', poly: r.poly, keepHoles: false, depth: 10, qty: 1,
      groupId: null, sourceFile: '', notes: r.notes,
      sourceUnitMm: r.unitMm, unitOverrideMm: null, unitsAmbiguous: r.unitsAmbiguous,
      fingerNotches: [], placements: [],
    };
    // Declaring the truth - the drawing is in millimetres - rescales exactly.
    const asMm = { ...base, unitOverrideMm: 1 };
    expect(partSize(asMm).w).toBeCloseTo(100, 2);
    expect(partSize(asMm).w / partSize(base).w).toBeCloseTo(96 / 25.4, 4);
  });
});

describe('CAM and plotter exports', () => {
  // One outline emitted as separate M-runs that continue from each other,
  // which is how Shaper Origin and similar exporters write polyline chains.
  const chained =
    'M 0,0 L 40,0 M 40,0 L 40,30 M 40,30 L 0,30 M 0,30 L 0,0';

  it('joins segments that share endpoints into one closed outline', () => {
    const r = parseSvgSilhouette(svg('width="100mm" height="100mm" viewBox="0 0 100 100"', `<path d="${chained}"/>`));
    expect(r.poly).toHaveLength(1);
    expect(r.size.w).toBeCloseTo(40, 3);
    expect(r.size.h).toBeCloseTo(30, 3);
    expect(ringAreaAbs(r.poly[0])).toBeCloseTo(1200, 1);
    expect(r.notes.join(' ')).toMatch(/joined end to end/);
  });

  it('joins segments regardless of their order or direction', () => {
    // Same rectangle, shuffled and with two segments reversed.
    const shuffled = 'M 40,30 L 0,30 M 0,0 L 40,0 M 0,0 L 0,30 M 40,0 L 40,30';
    const r = parseSvgSilhouette(svg('width="100mm" height="100mm" viewBox="0 0 100 100"', `<path d="${shuffled}"/>`));
    expect(r.poly).toHaveLength(1);
    expect(ringAreaAbs(r.poly[0])).toBeCloseTo(1200, 1);
  });

  it('ignores an artboard border drawn around the part', () => {
    // A page frame as four straight runs, plus the real outline inside it.
    const frame = 'M 0,0 L 100,0 M 100,0 L 100,100 M 100,100 L 0,100 M 0,100 L 0,0';
    const r = parseSvgSilhouette(svg(
      'width="100mm" height="100mm" viewBox="0 0 100 100"',
      `<path d="${frame}"/><path d="M 20,20 L 70,20 M 70,20 L 70,60 M 70,60 L 20,60 M 20,60 L 20,20"/>`,
    ));
    expect(r.size.w).toBeCloseTo(50, 3);
    expect(r.size.h).toBeCloseTo(40, 3);
    expect(r.notes.join(' ')).toMatch(/page border was ignored/);
  });

  it('keeps a part that genuinely fills the page', () => {
    // Only one outline, so there is nothing to fall back to: never drop it.
    const frame = 'M 0,0 L 100,0 M 100,0 L 100,100 M 100,100 L 0,100 M 0,100 L 0,0';
    const r = parseSvgSilhouette(svg('width="100mm" height="100mm" viewBox="0 0 100 100"', `<path d="${frame}"/>`));
    expect(r.size.w).toBeCloseTo(100, 3);
    expect(r.notes.join(' ')).not.toMatch(/page border/);
  });

  it('still treats a genuinely separate inner outline as a hole', () => {
    const r = parseSvgSilhouette(svg(
      'width="100mm" height="100mm" viewBox="0 0 100 100"',
      '<rect x="10" y="10" width="60" height="60"/><circle cx="40" cy="40" r="10"/>',
    ));
    expect(r.poly).toHaveLength(2);
    expect(r.size.w).toBeCloseTo(60, 3);
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
