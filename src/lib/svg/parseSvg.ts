import type { Poly, Ring, Vec2 } from '../../types';
import { flattenPath, type SubPath } from './parsePath';
import { ringAreaAbs, ringBBox, pointInRing, normalisePoly } from '../geom2d';

export interface ParsedSvg {
  poly: Poly;
  notes: string[];
  /** Width/height of the silhouette in mm. */
  size: { w: number; h: number };
}

type Mat = [number, number, number, number, number, number]; // a b c d e f

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const apply = (m: Mat, p: Vec2): Vec2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

function parseTransform(s: string | null): Mat {
  if (!s) return IDENTITY;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(s))) {
    const a = (g[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    let t: Mat = IDENTITY;
    switch (g[1]) {
      case 'matrix': t = [a[0], a[1], a[2], a[3], a[4], a[5]] as Mat; break;
      case 'translate': t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        const rot: Mat = [cos, sin, -sin, cos, 0, 0];
        if (a.length >= 3) {
          t = mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]);
        } else t = rot;
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

const UNIT_MM: Record<string, number> = {
  mm: 1, cm: 10, m: 1000, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, q: 0.25,
};

/** Parse a length such as "123.4mm" into millimetres, or null when absent. */
function lengthMm(v: string | null): number | null {
  if (!v) return null;
  const m = /^\s*([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === '' ) return n * UNIT_MM.px; // unitless user units are CSS px
  if (unit === '%') return null;
  const f = UNIT_MM[unit];
  return f === undefined ? null : n * f;
}

function rectRing(x: number, y: number, w: number, h: number, rx: number, ry: number): Ring {
  if (rx <= 0 && ry <= 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const a = Math.min(rx || ry, w / 2);
  const b = Math.min(ry || rx, h / 2);
  const seg = 12;
  const out: Ring = [];
  const corner = (cx: number, cy: number, s: number, e: number) => {
    for (let i = 0; i <= seg; i++) {
      const t = s + ((e - s) * i) / seg;
      out.push([cx + a * Math.cos(t), cy + b * Math.sin(t)]);
    }
  };
  corner(x + w - a, y + b, -Math.PI / 2, 0);
  corner(x + w - a, y + h - b, 0, Math.PI / 2);
  corner(x + a, y + h - b, Math.PI / 2, Math.PI);
  corner(x + a, y + b, Math.PI, 1.5 * Math.PI);
  return out;
}

/**
 * Circles are circumscribed rather than inscribed: an inscribed polygon would
 * make a round pocket very slightly too small for its part.
 */
function ellipseRing(cx: number, cy: number, rx: number, ry: number): Ring {
  const r = Math.max(rx, ry);
  const tol = 0.02;
  const n = r > tol
    ? Math.min(256, Math.max(24, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / r)))))
    : 24;
  const k = 1 / Math.cos(Math.PI / n);
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + rx * k * Math.cos(t), cy + ry * k * Math.sin(t)]);
  }
  return out;
}

const numAttr = (el: Element, name: string, dflt = 0) => {
  const v = el.getAttribute(name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

function collect(el: Element, m: Mat, out: SubPath[], tol: number) {
  const local = mul(m, parseTransform(el.getAttribute('transform')));
  const tag = el.tagName.toLowerCase().replace(/^.*:/, '');

  const emit = (ring: Ring, closed: boolean) =>
    out.push({ points: ring.map((p) => apply(local, p)), closed });

  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d');
      if (d) for (const sp of flattenPath(d, tol)) emit(sp.points, sp.closed);
      break;
    }
    case 'rect':
      emit(rectRing(numAttr(el, 'x'), numAttr(el, 'y'), numAttr(el, 'width'), numAttr(el, 'height'),
        numAttr(el, 'rx'), numAttr(el, 'ry')), true);
      break;
    case 'circle': {
      const r = numAttr(el, 'r');
      if (r > 0) emit(ellipseRing(numAttr(el, 'cx'), numAttr(el, 'cy'), r, r), true);
      break;
    }
    case 'ellipse': {
      const rx = numAttr(el, 'rx'), ry = numAttr(el, 'ry');
      if (rx > 0 && ry > 0) emit(ellipseRing(numAttr(el, 'cx'), numAttr(el, 'cy'), rx, ry), true);
      break;
    }
    case 'polygon':
    case 'polyline': {
      const nums = (el.getAttribute('points')?.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
      const pts: Vec2[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      if (pts.length > 2) emit(pts, tag === 'polygon');
      break;
    }
    case 'defs':
    case 'clippath':
    case 'mask':
    case 'symbol':
      return; // never rendered geometry
  }

  for (const child of Array.from(el.children)) collect(child, local, out, tol);
}

/**
 * Convert an SVG document into a single silhouette in millimetres.
 * Y is flipped so the result is in a conventional Y-up CAD frame.
 */
export function parseSvgSilhouette(text: string): ParsedSvg {
  const notes: string[] = [];
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Could not parse this file as SVG.');
  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase().replace(/^.*:/, '') !== 'svg') throw new Error('Root element is not <svg>.');

  // Resolve user units -> mm from width/height against viewBox.
  const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const wMm = lengthMm(svg.getAttribute('width'));
  const hMm = lengthMm(svg.getAttribute('height'));

  let scale = UNIT_MM.px; // default: user units are CSS px
  if (hasVb && wMm !== null && hMm !== null) {
    const sx = wMm / vb[2], sy = hMm / vb[3];
    scale = (sx + sy) / 2;
    if (Math.abs(sx - sy) > 1e-3 * Math.max(sx, sy)) {
      notes.push('Non-uniform viewBox scaling detected; used the average scale.');
    }
  } else if (hasVb && wMm !== null) {
    scale = wMm / vb[2];
  } else if (hasVb && hMm !== null) {
    scale = hMm / vb[3];
  } else if (!hasVb && (wMm !== null || hMm !== null)) {
    scale = 1; // width/height are the user-unit extent already in real units
    notes.push('No viewBox found; assuming user units are millimetres.');
  } else {
    notes.push('No real-world units found; assuming 96 dpi pixels.');
  }

  // viewBox origin offset, then unit scale, then Y flip.
  let root: Mat = [scale, 0, 0, -scale, 0, 0];
  if (hasVb) root = mul(root, [1, 0, 0, 1, -vb[0], -vb[1]]);

  const subs: SubPath[] = [];
  collect(svg, root, subs, 0.05 * Math.max(scale, 0.01));

  const rings = subs
    .map((s) => s.points)
    .filter((r) => r.length >= 3 && ringAreaAbs(r) > 0.02);
  if (rings.length === 0) throw new Error('No closed outlines with area were found in this SVG.');

  const open = subs.filter((s) => !s.closed && s.points.length >= 3).length;
  if (open > 0) notes.push(`${open} open path${open > 1 ? 's were' : ' was'} treated as closed.`);

  rings.sort((a, b) => ringAreaAbs(b) - ringAreaAbs(a));
  const outer = rings[0];
  const holes: Ring[] = [];
  const separate: Ring[] = [];
  for (const r of rings.slice(1)) {
    // Test a vertex plus the bbox centre so slivers classify correctly.
    const bb = ringBBox(r);
    const mid: Vec2 = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
    if (pointInRing(r[0], outer) || pointInRing(mid, outer)) holes.push(r);
    else separate.push(r);
  }
  if (separate.length) {
    notes.push(`${separate.length} outline${separate.length > 1 ? 's' : ''} outside the main silhouette ${separate.length > 1 ? 'were' : 'was'} ignored.`);
  }
  if (holes.length) notes.push(`${holes.length} interior outline${holes.length > 1 ? 's' : ''} detected (kept as holes only when "keep holes" is on).`);

  const poly = normalisePoly([outer, ...holes]);
  const bb = ringBBox(poly[0]);
  return { poly, notes, size: { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY } };
}
