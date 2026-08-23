import type { PartInput, Poly, Vec2 } from '../types';
import { polyBBox, bboxW, bboxH } from './geom2d';

/**
 * Units an SVG's user units might mean, in millimetres per unit.
 *
 * An SVG carrying only a viewBox has no intrinsic physical size, so the
 * parser has to guess. This is how that guess gets corrected.
 */
export const UNIT_CHOICES: { label: string; mm: number }[] = [
  { label: 'Millimetres', mm: 1 },
  { label: 'Points (72 dpi)', mm: 25.4 / 72 },
  { label: 'Pixels (96 dpi)', mm: 25.4 / 96 },
  { label: 'Centimetres', mm: 10 },
  { label: 'Inches', mm: 25.4 },
];

/** Scale to apply to the parsed outline to honour the user's unit choice. */
export function partScale(p: PartInput): number {
  if (p.unitOverrideMm == null || !(p.sourceUnitMm > 0)) return 1;
  return p.unitOverrideMm / p.sourceUnitMm;
}

/** The part's outline in millimetres, after any unit correction. */
export function partPoly(p: PartInput): Poly {
  const s = partScale(p);
  if (s === 1) return p.poly;
  return p.poly.map((ring) => ring.map(([x, y]) => [x * s, y * s] as Vec2));
}

export function partSize(p: PartInput): { w: number; h: number } {
  const bb = polyBBox(partPoly(p));
  return { w: bboxW(bb), h: bboxH(bb) };
}
