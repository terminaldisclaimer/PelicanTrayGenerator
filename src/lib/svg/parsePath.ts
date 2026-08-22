import type { Vec2 } from '../../types';
import { cubicPoints } from '../geom2d';

/** A flattened subpath, plus whether the source closed it with Z. */
export interface SubPath {
  points: Vec2[];
  closed: boolean;
}

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

interface Cmd { op: string; args: number[] }

function tokenize(d: string): Cmd[] {
  const cmds: Cmd[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const nums = (m[2].match(NUM) ?? []).map(Number);
    cmds.push({ op: m[1], args: nums });
  }
  return cmds;
}

/** Number of arguments each command consumes per repetition. */
const ARITY: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 4 /*placeholder*/, A: 7, Z: 0,
};
ARITY.T = 2;

function arcToCubics(
  x0: number, y0: number, rx: number, ry: number, phiDeg: number,
  largeArc: boolean, sweep: boolean, x1: number, y1: number,
): Vec2[][] {
  if (rx === 0 || ry === 0) return [];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: Vec2[][] = [];
  let th = theta1;
  let px = x0, py = y0;
  for (let i = 0; i < segs; i++) {
    const th2 = th + delta;
    const cos1 = Math.cos(th), sin1 = Math.sin(th);
    const cos2 = Math.cos(th2), sin2 = Math.sin(th2);
    const e = (c: number, s: number): Vec2 => [
      cx + rx * cosP * c - ry * sinP * s,
      cy + rx * sinP * c + ry * cosP * s,
    ];
    const eP = (c: number, s: number): Vec2 => [
      -rx * cosP * s - ry * sinP * c,
      -rx * sinP * s + ry * cosP * c,
    ];
    const p2 = e(cos2, sin2);
    const d1 = eP(cos1, sin1);
    const d2 = eP(cos2, sin2);
    out.push([
      [px, py],
      [px + t * d1[0], py + t * d1[1]],
      [p2[0] - t * d2[0], p2[1] - t * d2[1]],
      p2,
    ]);
    px = p2[0]; py = p2[1];
    th = th2;
  }
  return out;
}

/**
 * Flatten an SVG path `d` attribute into polylines.
 * `tol` is the chord tolerance in user units.
 */
export function flattenPath(d: string, tol = 0.05): SubPath[] {
  const cmds = tokenize(d);
  const subs: SubPath[] = [];
  let cur: Vec2[] | null = null;
  let curClosed = false;
  let x = 0, y = 0, startX = 0, startY = 0;
  let prevCtrl: Vec2 | null = null;
  let prevOp = '';

  const push = (p: Vec2) => { if (cur) cur.push(p); };
  const finish = () => {
    if (cur && cur.length > 1) subs.push({ points: cur, closed: curClosed });
    cur = null;
    curClosed = false;
  };

  for (const { op, args } of cmds) {
    const rel = op === op.toLowerCase();
    const OP = op.toUpperCase();
    const n = ARITY[OP] ?? 0;

    if (OP === 'Z') {
      if (cur) curClosed = true;
      finish();
      x = startX; y = startY;
      prevOp = OP;
      continue;
    }

    const reps = n > 0 ? Math.max(1, Math.floor(args.length / n)) : 1;
    for (let k = 0; k < reps; k++) {
      const a = args.slice(k * n, k * n + n);
      if (a.length < n) break;
      switch (OP) {
        case 'M': {
          const nx = rel ? x + a[0] : a[0];
          const ny = rel ? y + a[1] : a[1];
          if (k === 0) {
            finish();
            cur = [[nx, ny]];
            startX = nx; startY = ny;
          } else {
            push([nx, ny]);
          }
          x = nx; y = ny;
          prevCtrl = null;
          break;
        }
        case 'L': {
          x = rel ? x + a[0] : a[0];
          y = rel ? y + a[1] : a[1];
          push([x, y]);
          prevCtrl = null;
          break;
        }
        case 'H': {
          x = rel ? x + a[0] : a[0];
          push([x, y]);
          prevCtrl = null;
          break;
        }
        case 'V': {
          y = rel ? y + a[0] : a[0];
          push([x, y]);
          prevCtrl = null;
          break;
        }
        case 'C':
        case 'S': {
          let c1: Vec2, c2: Vec2, p: Vec2;
          if (OP === 'C') {
            c1 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
            c2 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
            p = [rel ? x + a[4] : a[4], rel ? y + a[5] : a[5]];
          } else {
            const reflect: Vec2 = prevCtrl && 'CS'.includes(prevOp)
              ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]]
              : [x, y];
            c1 = reflect;
            c2 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
            p = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
          }
          for (const q of cubicPoints([x, y], c1, c2, p, tol)) push(q);
          prevCtrl = c2;
          x = p[0]; y = p[1];
          break;
        }
        case 'Q':
        case 'T': {
          let q: Vec2, p: Vec2;
          if (OP === 'Q') {
            q = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
            p = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
          } else {
            q = prevCtrl && 'QT'.includes(prevOp) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
            p = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          }
          // Elevate the quadratic to a cubic and reuse the flattener.
          const c1: Vec2 = [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)];
          const c2: Vec2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])];
          for (const pt of cubicPoints([x, y], c1, c2, p, tol)) push(pt);
          prevCtrl = q;
          x = p[0]; y = p[1];
          break;
        }
        case 'A': {
          const nx = rel ? x + a[5] : a[5];
          const ny = rel ? y + a[6] : a[6];
          const curves = arcToCubics(x, y, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, nx, ny);
          if (curves.length === 0) push([nx, ny]);
          for (const c of curves) for (const pt of cubicPoints(c[0], c[1], c[2], c[3], tol)) push(pt);
          x = nx; y = ny;
          prevCtrl = null;
          break;
        }
      }
      prevOp = OP;
    }
  }
  finish();
  return subs;
}
