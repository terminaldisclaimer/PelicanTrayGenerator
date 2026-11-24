import type { TriMesh } from '../mesh/types';

/**
 * A round cable wound as a stacked rounded-rectangle coil (each turn directly
 * on top of the one before), with a lead at each end:
 *
 *  - J lead: along one long side the cable carries straight on past the corner,
 *    curls outward in a U whose bottom is level with the end of the coil, and
 *    finishes in a straight leg running back along the outside of that side.
 *  - Centre lead: at the other end of the stack the cable peels off at a short
 *    end, bends inward and runs along the long axis into the hollow middle. If
 *    a connector is fitted there, the lead climbs (two bends) so the top of the
 *    connector is level with the top of the stack.
 *
 * The total length, both leads and the whole number of half turns before the
 * peel-off over-constrain the coil, so the footprint length flexes by a few
 * millimetres to make the length come out exactly.
 *
 * This is a port of the owner's Fusion 360 "SnakedWire" script; names follow it.
 * All lengths are mm. Pure maths: no kernel needed.
 */
export interface CableSpec {
  /** Cable diameter. */
  wireD: number;
  /** Cable length end to end (both leads and the climb included; connectors are extra). */
  totalLen: number;
  /** Target footprint length over the outside of the cable (flexes to fit the length). */
  outerL: number;
  /** Footprint width over the outside of the cable. */
  outerW: number;
  /** Corner radius at the cable's centreline. */
  cornerR: number;
  /** Air gap between stacked turns. */
  gap: number;
  /** How the footprint length may flex. */
  fit: 'nearest' | 'grow' | 'shrink';
  /** The lead on the outside of the coil, or null for none. */
  j: {
    /** Width across the U, outside of cable to outside of cable. */
    width: number;
    /** From the bottom of the U to the tip of the free end. */
    length: number;
    /** Which end of the coil the bottom of the U lines up with. */
    end: 'left' | 'right';
    /** Which long side it sticks out past. */
    side: 'top' | 'bottom';
    /** Which turn it leaves from; the centre lead leaves from the other end of the stack. */
    layer: 'top' | 'bottom';
  } | null;
  /** Bend radius where the cable leaves its turn for the middle. */
  turnInR: number;
  /** Flat run along the long axis after the turn-in bend, before any climb. */
  centerRun: number;
  /** Radius of the two bends in the climb. */
  climbR: number;
  /** Level run after the climb, ending at the cable's end. */
  centerLead: number;
  /**
   * Connector on the centre lead (sets how high the lead climbs): its height,
   * how far its top sits above the stack, and how far it reaches past the
   * cable's end. null = the lead stays flat.
   */
  din: { diameter: number; above: number; length: number; width?: number } | null;
}

export const DEFAULT_CABLE: CableSpec = {
  wireD: 6, totalLen: 1151, outerL: 115, outerW: 40, cornerR: 12, gap: 0.2, fit: 'nearest',
  j: { width: 20, length: 50, end: 'left', side: 'top', layer: 'top' },
  turnInR: 8, centerRun: 0, climbR: 8, centerLead: 5, din: null,
};

export class CableError extends Error {}

type P3 = [number, number, number];
type Seg = { kind: 'line'; a: [number, number]; b: [number, number]; len: number } | { kind: 'arc'; c: [number, number]; start: number; len: number };
const FINE = 1.0;
const DIN_CLEARANCE = 0.5;

interface JSpec { rj: number; stem: number; tail: number; length: number }
interface Layout {
  outerL: number; lc: number; wc: number; at: (u: number) => P3; segs: Seg[]; perim: number;
  rise: number; stretch: number; uS: number; uPeel: number; side0: number;
  phi0: number; turn: number; center: [number, number]; xIn: number; bendLen: number;
}
interface Center { uEnd: number; zEnd: number; dz: number; sgn: number; theta: number; straight: number; rb: number; run: number; lead: number; x1: number; xE: number; xW: number; tail: number }

function jSpec(s: CableSpec): JSpec | null {
  const j = s.j;
  if (!j) return null;
  if (j.width < 2 * s.wireD + s.gap - 1e-9) throw new CableError(`The outside lead must be at least ${(2 * s.wireD + s.gap).toFixed(1)} mm wide so its two legs do not touch.`);
  const rj = (j.width - s.wireD) / 2;
  const stem = Math.max(s.cornerR - rj, 0);
  let tail = j.length - s.wireD / 2 - rj;
  if (tail < -1e-9) throw new CableError(`The outside lead must be at least ${(j.width / 2).toFixed(1)} mm long (half its width).`);
  tail = Math.max(tail, 0);
  return { rj, stem, tail, length: tail + Math.PI * rj + stem };
}

function layout(s: CableSpec, outerL: number, j: JSpec | null): Layout {
  const r = s.cornerR, R = s.turnInR;
  const lc = outerL - s.wireD, wc = s.outerW - s.wireD;
  if (!(s.wireD / 2 < r && r <= Math.min(lc, wc) / 2 + 1e-9))
    throw new CableError(`Corner radius must be more than ${(s.wireD / 2).toFixed(1)} and at most ${(Math.min(lc, wc) / 2).toFixed(1)} mm.`);
  const a = lc - 2 * r, b = wc - 2 * r, arc = (Math.PI * r) / 2;
  // Footprint loop, counter-clockwise, starting at the left end of the bottom long side.
  const segs: Seg[] = [
    { kind: 'line', a: [-a / 2, -wc / 2], b: [a / 2, -wc / 2], len: a },
    { kind: 'arc', c: [a / 2, -b / 2], start: -90, len: arc },
    { kind: 'line', a: [lc / 2, -b / 2], b: [lc / 2, b / 2], len: b },
    { kind: 'arc', c: [a / 2, b / 2], start: 0, len: arc },
    { kind: 'line', a: [a / 2, wc / 2], b: [-a / 2, wc / 2], len: a },
    { kind: 'arc', c: [-a / 2, b / 2], start: 90, len: arc },
    { kind: 'line', a: [-lc / 2, b / 2], b: [-lc / 2, -b / 2], len: b },
    { kind: 'arc', c: [-a / 2, -b / 2], start: 180, len: arc },
  ];
  const perim = segs.reduce((t, g) => t + g.len, 0);
  const pitch = s.wireD + s.gap;
  const rise = pitch / perim;
  const stretch = Math.sqrt(1 + rise * rise);

  // Peel-off toward the middle at the right-hand end: an arc of radius R that leaves
  // the outline tangentially and finishes heading -X on the long axis.
  if (R <= s.wireD / 2) throw new CableError(`The turn-in bend radius must be more than ${(s.wireD / 2).toFixed(1)} mm.`);
  let phi0: number, uR: number, center: [number, number];
  if (R <= b / 2 + 1e-9) { // leaves from the short straight
    phi0 = 0; uR = a + arc + (b / 2 - R); center = [lc / 2 - R, -R];
  } else if (R < r && R <= (r + b / 2) / 2 + 1e-9) { // leaves from the corner arc
    phi0 = Math.asin(Math.max(-1, Math.min(1, (b / 2 - R) / (r - R))));
    uR = a + r * (phi0 + Math.PI / 2);
    center = [a / 2 + (r - R) * Math.cos(phi0), -b / 2 + (r - R) * Math.sin(phi0)];
  } else throw new CableError(`The turn-in bend radius must be at most ${Math.max(b / 2, (r + b / 2) / 2).toFixed(1)} mm with this corner radius and coil width.`);
  const turn = Math.PI / 2 - phi0;

  // The coil starts where the J joins it, on the bottom long side near the left end.
  let uS = 0;
  if (j) {
    const xT = -lc / 2 + j.rj;
    if (xT > a / 2 - 1e-9) throw new CableError(`The outside lead is too wide for this coil (at most ${(2 * (lc - r) + s.wireD).toFixed(1)} mm).`);
    uS = Math.max(-a / 2, xT) + a / 2;
  }
  const half = perim / 2;
  const rel = uR - uS;
  const m = Math.ceil((1e-6 - rel) / half);
  const uPeel = rel + m * half;
  const side0 = ((m % 2) + 2) % 2;

  const xy = (g: Seg, t: number): [number, number] => {
    if (g.kind === 'line') return [g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t];
    const ang = ((g.start + 90 * t) * Math.PI) / 180;
    return [g.c[0] + r * Math.cos(ang), g.c[1] + r * Math.sin(ang)];
  };
  const at = (u: number): P3 => {
    let rem = (((u + uS) % perim) + perim) % perim;
    for (const g of segs) {
      if (g.len <= 1e-12) continue;
      if (rem <= g.len) { const [x, y] = xy(g, rem / g.len); return [x, y, rise * u]; }
      rem -= g.len;
    }
    const [x, y] = xy(segs[segs.length - 1], 1);
    return [x, y, rise * u];
  };
  return { outerL, lc, wc, at, segs, perim, rise, stretch, uS, uPeel, side0, phi0, turn, center, xIn: center[0], bendLen: R * turn };
}

function centerGeom(s: CableSpec, g: Layout, n: number): Center {
  const uEnd = g.uPeel + (n * g.perim) / 2;
  const zEnd = g.rise * uEnd;
  const run = s.centerRun, lead = s.centerLead, rb = s.climbR;
  let dz = 0;
  if (s.din) {
    // Final frame: the stack spans z = -wireD/2 .. zEnd + wireD/2. The connector's axis
    // (= the cable's end) sits so its top is level with the top of the stack.
    const zAxis = zEnd + s.wireD / 2 + s.din.above - s.din.diameter / 2;
    dz = (s.j?.layer ?? 'top') === 'top' ? -zAxis : zAxis - zEnd;
  }
  const h = Math.abs(dz), sgn = dz >= 0 ? 1 : -1;
  let theta = 0, straight = 0;
  if (h >= 1e-9) {
    if (h >= 2 * rb) { theta = Math.PI / 2; straight = h - 2 * rb; }
    else theta = Math.acos(1 - h / (2 * rb)); // too short a climb for 90 degrees: a shallower S-bend
  }
  const climbDx = 2 * rb * Math.sin(theta) + straight * Math.cos(theta);
  const x1 = g.xIn - run, xE = x1 - climbDx, xW = xE - lead;
  return { uEnd, zEnd, dz, sgn, theta, straight, rb, run, lead, x1, xE, xW, tail: g.bendLen + run + 2 * rb * theta + straight + lead };
}

function centerProblems(s: CableSpec, g: Layout, c: Center): string[] {
  const far = -g.lc / 2;
  const probs: string[] = [];
  if (c.xW < far + s.wireD + s.gap - 1e-9) probs.push(`the centre lead reaches ${(far + s.wireD + s.gap - c.xW).toFixed(1)} mm too far toward the far end of the coil`);
  if (s.din) {
    const tip = c.xW - s.din.length, limit = far + s.wireD / 2 + DIN_CLEARANCE;
    if (tip < limit - 1e-9) probs.push(`the centre connector would run ${(limit - tip).toFixed(1)} mm into the far end of the coil`);
  }
  return probs;
}

export interface SolvedCable {
  /** Centreline from the free end of the outside lead to the end of the centre lead. */
  path: P3[];
  /** The two cable ends: where a connector attaches and the direction it points (unit, level). */
  ends: { outside: { at: P3; dir: P3 } | null; center: { at: P3; dir: P3 } };
  turns: number;
  /** Footprint of the coil itself over the outside of the cable. */
  footprint: { length: number; width: number; height: number };
  /** Hollow middle, inside the cable. */
  hollow: { length: number; width: number };
}

/** Work out the coil for these settings, or throw a CableError saying what does not fit. */
export function solveCable(s: CableSpec): SolvedCable {
  for (const [name, v] of [['Cable diameter', s.wireD], ['Cable length', s.totalLen], ['Coil length', s.outerL], ['Coil width', s.outerW]] as const)
    if (!(v > 0) || !Number.isFinite(v)) throw new CableError(`${name} must be more than 0.`);
  if (!(s.gap > 0)) throw new CableError('The gap between turns must be more than 0.');
  if (s.centerRun < 0 || s.centerLead < 0) throw new CableError('Lead lengths must be 0 or more.');
  if (s.climbR <= s.wireD / 2) throw new CableError(`The climb bend radius must be more than ${(s.wireD / 2).toFixed(1)} mm.`);
  const j = jSpec(s);
  const avail = s.totalLen - (j ? j.length : 0);
  if (s.din) {
    const room = s.outerW - 2 * s.wireD - 2 * DIN_CLEARANCE;
    const w = s.din.width ?? s.din.diameter;
    if (w > room + 1e-9) throw new CableError(`The centre connector (${w.toFixed(1)} mm wide) is wider than the hollow middle of the coil (${room.toFixed(1)} mm across). Make the coil wider or turn the connector.`);
  }
  const length = (g: Layout, n: number) => g.stretch * centerGeom(s, g, n).uEnd + centerGeom(s, g, n).tail;

  const g0 = layout(s, s.outerL, j);
  let nFloor = -1;
  while (length(g0, nFloor + 1) <= avail) {
    nFloor++;
    if (nFloor > 10000) throw new CableError('The cable is far too long for this coil size.');
  }
  const lMin = 2 * s.cornerR + s.wireD + 1e-6;
  const fit = (n: number, grow: boolean): { g: Layout; n: number } | null => {
    if (n < 0) return null;
    let lo: number, hi: number;
    try {
      if (grow) {
        lo = s.outerL; hi = s.outerL + 10;
        while (length(layout(s, hi, j), n) < avail) { hi += 10; if (hi > s.outerL + 1000) return null; }
      } else {
        lo = lMin; hi = s.outerL;
        if (length(layout(s, lo, j), n) > avail) return null;
      }
      for (let i = 0; i < 100; i++) {
        const mid = 0.5 * (lo + hi);
        if (length(layout(s, mid, j), n) < avail) lo = mid; else hi = mid;
      }
      return { g: layout(s, hi, j), n };
    } catch (e) {
      if (e instanceof CableError) return null;
      throw e;
    }
  };
  const tries: [number, boolean][] = [];
  if (s.fit !== 'grow') tries.push([nFloor + 1, false]);
  if (s.fit !== 'shrink') tries.push([nFloor, true], [nFloor - 1, true], [nFloor - 2, true]);
  const feasible: { g: Layout; n: number }[] = [], rejected: { g: Layout; probs: string[] }[] = [];
  for (const [n, grow] of tries) {
    const f = fit(n, grow);
    if (!f) continue;
    const probs = centerProblems(s, f.g, centerGeom(s, f.g, n));
    if (probs.length) rejected.push({ g: f.g, probs }); else feasible.push(f);
  }
  const nearest = <T extends { g: Layout }>(list: T[]) => list.reduce((best, x) => (Math.abs(x.g.outerL - s.outerL) < Math.abs(best.g.outerL - s.outerL) ? x : best));
  if (!feasible.length) {
    if (rejected.length) throw new CableError(`No coil fits these settings: ${nearest(rejected).probs.join('; ')}. Shorten the centre lead, use a shorter connector, or make the coil longer.`);
    throw new CableError('No coil fits these settings; the cable may be too short for the two leads.');
  }
  const { g, n } = nearest(feasible);
  const c = centerGeom(s, g, n);
  const side = (g.side0 + n) % 2;

  // ---- centreline, in the construction frame (J on the bottom long side at the left end, z = 0) ----
  const pts: P3[] = [];
  const line = (p: P3, q: P3, spacing: number): P3[] => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < 1e-6) return [];
    const k = Math.max(1, Math.ceil(d / spacing));
    return Array.from({ length: k }, (_, i) => [0, 1, 2].map((a) => p[a] + ((q[a] - p[a]) * (i + 1)) / k) as P3);
  };
  if (j) {
    const ySide = -g.wc / 2, xT = -g.lc / 2 + j.rj, cy = ySide - j.rj, yo = ySide - 2 * j.rj;
    if (j.tail > 1e-6) {
      const k = Math.max(1, Math.ceil(j.tail / FINE));
      for (let i = 0; i < k; i++) pts.push([xT + j.tail - (j.tail * i) / k, yo, 0]);
    }
    const k = Math.max(8, Math.ceil((Math.PI * j.rj) / FINE));
    for (let i = 0; i <= k; i++) { const t = -Math.PI / 2 - (Math.PI * i) / k; pts.push([xT + j.rj * Math.cos(t), cy + j.rj * Math.sin(t), 0]); }
    if (j.stem > 1e-6) {
      const k2 = Math.max(2, Math.ceil(j.stem / (FINE / 2)));
      for (let i = 1; i <= k2; i++) pts.push([xT + (j.stem * i) / k2, ySide, 0]);
    }
    pts.pop(); // the coil supplies the joining point
  }
  { // the coil, including every line/arc tangent point of the footprint
    const step = 2, start = g.uS, end = g.uS + c.uEnd, us: number[] = [];
    let uo = 0;
    while (uo < end) {
      for (const sg of g.segs) {
        if (sg.len <= 1e-9) continue;
        const k = Math.max(1, Math.ceil(sg.len / step));
        for (let i = 0; i < k; i++) { const v = uo + (sg.len * i) / k; if (start + 0.25 * step < v && v < end - 0.25 * step) us.push(v - start); }
        uo += sg.len;
      }
    }
    for (const u of [0, ...us, c.uEnd]) pts.push(g.at(u));
  }
  { // the centre lead: turn-in bend, flat run, climb, level run
    const R = s.turnInR, z0 = c.zEnd, [cx, cy] = g.center, tail: P3[] = [];
    let k = Math.max(4, Math.ceil((R * g.turn) / FINE));
    for (let i = 1; i <= k; i++) { const phi = g.phi0 + (g.turn * i) / k; tail.push([cx + R * Math.cos(phi), cy + R * Math.sin(phi), z0]); }
    tail.push(...line([g.xIn, 0, z0], [c.x1, 0, z0], FINE));
    const { rb, theta: th, sgn: sg } = c, zE = z0 + c.dz;
    if (th > 1e-9) {
      k = Math.max(4, Math.ceil((rb * th) / FINE));
      for (let i = 1; i <= k; i++) { const p = (th * i) / k; tail.push([c.x1 - rb * Math.sin(p), 0, z0 + sg * rb * (1 - Math.cos(p))]); }
      tail.push(...line(tail[tail.length - 1], [c.xE + rb * Math.sin(th), 0, zE - sg * rb * (1 - Math.cos(th))], FINE));
      for (let i = k - 1; i >= 0; i--) { const p = (th * i) / k; tail.push([c.xE + rb * Math.sin(p), 0, zE - sg * rb * (1 - Math.cos(p))]); }
    }
    tail.push(...line([c.xE, 0, zE], [c.xE - c.lead, 0, zE], FINE));
    for (const p of tail) pts.push(side === 1 ? [-p[0], -p[1], p[2]] : p);
  }

  // ---- mirror / flip to where the settings put the J ----
  const sx = s.j?.end === 'right' ? -1 : 1, sy = (s.j?.side ?? 'top') === 'top' ? -1 : 1, flip = (s.j?.layer ?? 'top') === 'top';
  const place = (p: P3): P3 => [sx * p[0], sy * p[1], flip ? c.zEnd - p[2] : p[2]];
  const path: P3[] = [];
  for (const p of pts.map(place)) {
    const q = path[path.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-4) path.push(p);
  }

  // The cable must not run into itself (compare points more than 40 mm apart along it).
  {
    const along = [0];
    for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
    const cell = s.wireD, grid = new Map<string, number[]>();
    const key = (p: P3) => p.map((v) => Math.floor(v / cell)) as P3;
    path.forEach((p, i) => { const kk = key(p).join(','); (grid.get(kk) ?? grid.set(kk, []).get(kk)!).push(i); });
    const need = (s.wireD - 1e-3) ** 2;
    for (let i = 0; i < path.length; i++) {
      const [kx, ky, kz] = key(path[i]);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dzz = -1; dzz <= 1; dzz++)
        for (const k of grid.get(`${kx + dx},${ky + dy},${kz + dzz}`) ?? []) {
          if (k <= i || along[k] - along[i] < 40) continue;
          const d2 = (path[i][0] - path[k][0]) ** 2 + (path[i][1] - path[k][1]) ** 2 + (path[i][2] - path[k][2]) ** 2;
          if (d2 < need) throw new CableError(`The cable would run into itself (${Math.sqrt(d2).toFixed(1)} mm between centres, needs ${s.wireD.toFixed(1)}). Try a different outside lead size, a shorter centre lead, or a wider coil.`);
        }
    }
  }

  const centerDir: P3 = [sx * (side === 1 ? 1 : -1), 0, 0];
  return {
    path,
    ends: { outside: j ? { at: path[0], dir: [sx, 0, 0] } : null, center: { at: path[path.length - 1], dir: centerDir } },
    turns: c.uEnd / g.perim,
    footprint: { length: g.outerL, width: s.outerW, height: c.zEnd + s.wireD },
    hollow: { length: g.outerL - 2 * s.wireD, width: s.outerW - 2 * s.wireD },
  };
}

/** A closed round tube along a centreline, ends cut square. */
export function tubeMesh(path: P3[], diameter: number, name = 'cable', sides = 12): TriMesh {
  const r = diameter / 2, n = path.length;
  if (n < 2) throw new CableError('The cable is too short to draw.');
  const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (a: P3): P3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tangent = (i: number) => unit(sub(path[Math.min(i + 1, n - 1)], path[Math.max(i - 1, 0)]));
  // Carry a frame along the path without twisting it (so rings line up from one point to the next).
  let t = tangent(0);
  let u = unit(cross(Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], t));
  const rings: P3[][] = [];
  for (let i = 0; i < n; i++) {
    const t2 = tangent(i);
    u = unit(sub(u, [t2[0] * dot(u, t2), t2[1] * dot(u, t2), t2[2] * dot(u, t2)]));
    t = t2;
    const v = cross(t, u);
    rings.push(Array.from({ length: sides }, (_, k) => {
      const a = (2 * Math.PI * k) / sides, c = r * Math.cos(a), sn = r * Math.sin(a);
      return [path[i][0] + c * u[0] + sn * v[0], path[i][1] + c * u[1] + sn * v[1], path[i][2] + c * u[2] + sn * v[2]] as P3;
    }));
  }
  const out: number[] = [];
  const tri = (a: P3, b: P3, c: P3) => out.push(...a, ...b, ...c);
  for (let i = 0; i + 1 < n; i++)
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides, a = rings[i][k], b = rings[i][k2], c = rings[i + 1][k], d = rings[i + 1][k2];
      tri(a, b, d); tri(a, d, c);
    }
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    tri(path[0], rings[0][k2], rings[0][k]); // start cap faces back along the path
    tri(path[n - 1], rings[n - 1][k], rings[n - 1][k2]);
  }
  return { name, positions: new Float32Array(out) };
}

/** Number of ways a connector can be turned: 6 choices of which way the model points, times 4 rolls. */
export const CONNECTOR_TURNS = 6;
export const CONNECTOR_ROLLS = 4;

/**
 * A connector model turned for fitting on a cable end. Coordinates are local:
 * u runs along the cable away from its end (the model spans u = 0..length),
 * v is sideways (centred on 0), w is up (centred on 0).
 */
export interface OrientedConnector { uvw: Float32Array; length: number; width: number; height: number }

/** The model axis (0..5 = +X −X +Y −Y +Z −Z) that should run along the cable by default: its longest dimension. */
export function defaultConnectorAxis(mesh: TriMesh): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) { const a = i % 3, v = mesh.positions[i]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  const d = [0, 1, 2].map((a) => hi[a] - lo[a]);
  return 2 * d.indexOf(Math.max(...d));
}

/** Turn a connector so model axis `axis` runs along the cable, rolled `roll` quarter turns about it. */
export function orientConnector(mesh: TriMesh, axis: number, roll: number): OrientedConnector {
  const a = Math.floor(axis / 2) % 3, sign = axis % 2 === 0 ? 1 : -1;
  const b = (a + 1) % 3, c = (a + 2) % 3; // (a, b, c) is a right-handed order of model axes
  const ang = (Math.PI / 2) * (((roll % 4) + 4) % 4), cs = Math.round(Math.cos(ang)), sn = Math.round(Math.sin(ang));
  const p = mesh.positions, uvw = new Float32Array(p.length);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    // Pointing the other way along the same axis is a half turn about c, which keeps the model right-handed.
    const u = sign * p[i + a], v0 = sign * p[i + b], w0 = p[i + c];
    const v = cs * v0 - sn * w0, w = sn * v0 + cs * w0;
    uvw[i] = u; uvw[i + 1] = v; uvw[i + 2] = w;
    for (let k = 0; k < 3; k++) { const x = uvw[i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
  }
  const mid = [lo[0], (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  for (let i = 0; i < uvw.length; i++) uvw[i] -= mid[i % 3];
  return { uvw, length: hi[0] - lo[0], width: hi[1] - lo[1], height: hi[2] - lo[2] };
}

/** Put an oriented connector on a cable end. `overlap` pushes it back onto the cable so the two join. */
export function placeConnector(o: OrientedConnector, end: { at: P3; dir: P3 }, name: string, overlap = 0.5): TriMesh {
  const [dx, dy] = end.dir; // level unit vector
  const vx = -dy, vy = dx; // sideways: up × dir
  const out = new Float32Array(o.uvw.length);
  for (let i = 0; i < out.length; i += 3) {
    const u = o.uvw[i] - overlap, v = o.uvw[i + 1], w = o.uvw[i + 2];
    out[i] = end.at[0] + u * dx + v * vx;
    out[i + 1] = end.at[1] + u * dy + v * vy;
    out[i + 2] = end.at[2] + w;
  }
  return { name, positions: out };
}
