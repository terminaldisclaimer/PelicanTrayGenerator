export type Units = 'mm' | 'in';
export const MM_PER_IN = 25.4;

export function fmtLen(mm: number, units: Units, digits = units === 'mm' ? 1 : 2): string {
  const v = units === 'mm' ? mm : mm / MM_PER_IN;
  return `${v.toFixed(digits)}`;
}

export function fmtDims(s: [number, number, number], units: Units): string {
  return `${s.map((v) => fmtLen(v, units)).join(' × ')} ${units}`;
}
