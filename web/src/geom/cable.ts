import type { TriMesh } from '../mesh/types';

/**
 * A round cable wound as a stacked rounded-rectangle coil (each turn directly
 * on top of the one before), with a lead at each end of the stack.
 *
 * A lead is described by where it leaves the coil and what it does next:
 * an optional straight run, a bend through any angle (positive = toward the
 * middle of the coil, negative = away from it, 0 = straight on, in line with
 * the coil), then a straight run to the cable's end. That covers a lead in
 * line with the coil, one into the hollow middle, a J doubling back beside
 * the coil, and anything between.
 *
 * A lead with a connector climbs or drops (two bends) so the connector sits
 * within the height of the stack: flush with the top for the top lead and for
 * a connector in the hollow, flush with the bottom for one outside the coil
 * on the bottom turn.
 *
 * The total length and where each lead leaves the coil over-constrain it, so
 * the footprint length flexes to make the length come out exactly.
 *
 * The coil, and the J and into-the-middle presets, follow the owner's Fusion
 * 360 "SnakedWire" script. All lengths are mm. Pure maths: no kernel needed.
 */
export interface LeadSpec {
  /**
   * Where the lead leaves the coil: the whole part is one of the loop's eight
   * pieces (0 near long side, 1 right-near corner, 2 right end, 3 right-far
   * corner, 4 far long side, 5 left-far corner, 6 left end, 7 left-near
   * corner, going counter-clockwise), the fraction how far along that piece.
   * Kept this way so a spot such as "where the corner starts" stays put when
   * the coil length flexes.
   */
  at: number;
  /** Straight run before the bend. */
  stem: number;
  /** Bend, in degrees: + toward the middle of the coil, − away from it, 0 = straight on. */
  angle: number;
  /** Bend radius at the cable's centreline. */
  radius: number;
  /** Straight run after the bend, to the cable's end. */
  length: number;
  /** Connector on this end: its height, width, and how far it reaches past the cable's end. null = bare. */
  connector: { height: number; width: number; length: number } | null;
}
export interface CableSpec {
  /** Cable diameter. */
  wireD: number;
  /** Cable length end to end (both leads and any climb included; connectors are extra). */
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
  /** Radius of the two bends in a climb. */
  climbR: number;
  /** Wind the other way round (mirrors the whole cable, swapping the near and far sides). */
  mirror: boolean;
  /** The lead leaving the top turn, and the one leaving the bottom turn. */
  top: LeadSpec;
  bottom: LeadSpec;
}

export class CableError extends Error {}

type P2 = [number, number];
type P3 = [number, number, number];
const FINE = 1.0;
const CLEARANCE = 0.5;
const NAME: Record<'top' | 'bottom', string> = { top: 'top-turn', bottom: 'bottom-turn' };
const RAD = Math.PI / 180;

interface Layout { outerL: number; lc: number; wc: number; a: number; b: number; r: number; perim: number; rise: number; stretch: number; start: number[]; len: number[]; xy: (u: number) => P2; heading: (u: number) => number }

function layout(s: Pick<CableSpec, 'wireD' | 'outerW' | 'cornerR' | 'gap'>, outerL: number): Layout {
  const r = s.cornerR;
  const lc = outerL - s.wireD, wc = s.outerW - s.wireD;
  if (!(s.wireD / 2 < r && r <= Math.min(lc, wc) / 2 + 1e-9))
    throw new CableError(`Corner radius must be more than ${(s.wireD / 2).toFixed(1)} and at most ${(Math.min(lc, wc) / 2).toFixed(1)} mm.`);
  const a = lc - 2 * r, b = wc - 2 * r, arc = (Math.PI * r) / 2;
  // Footprint loop, counter-clockwise from the left end of the near long side.
  const pieces: [number, (t: number) => P2, (t: number) => number][] = [
    [a, (t) => [-a / 2 + t, -wc / 2], () => 0],
    [arc, (t) => [a / 2 + r * Math.sin(t / r), -b / 2 - r * Math.cos(t / r)], (t) => t / r],
    [b, (t) => [lc / 2, -b / 2 + t], () => Math.PI / 2],
    [arc, (t) => [a / 2 + r * Math.cos(t / r), b / 2 + r * Math.sin(t / r)], (t) => Math.PI / 2 + t / r],
    [a, (t) => [a / 2 - t, wc / 2], () => Math.PI],
    [arc, (t) => [-a / 2 - r * Math.sin(t / r), b / 2 + r * Math.cos(t / r)], (t) => Math.PI + t / r],
    [b, (t) => [-lc / 2, b / 2 - t], () => 1.5 * Math.PI],
    [arc, (t) => [-a / 2 - r * Math.cos(t / r), -b / 2 - r * Math.sin(t / r)], (t) => 1.5 * Math.PI + t / r],
  ];
  const len = pieces.map((p) => p[0]), start: number[] = [];
  let perim = 0;
  for (const l of len) { start.push(perim); perim += l; }
  const on = <T>(u: number, pick: 1 | 2): T => {
    let rem = ((u % perim) + perim) % perim;
    for (const p of pieces) {
      if (p[0] <= 1e-12) continue;
      if (rem <= p[0]) return p[pick](rem) as T;
      rem -= p[0];
    }
    return pieces[0][pick](0) as T;
  };
  const rise = (s.wireD + s.gap) / perim;
  return { outerL, lc, wc, a, b, r, perim, rise, stretch: Math.sqrt(1 + rise * rise), start, len, xy: (u) => on<P2>(u, 1), heading: (u) => on<number>(u, 2) };
}

/** Loop distance of a lead's `at` (piece + fraction along it). */
function atToU(g: Layout, at: number): number {
  const w = ((at % 8) + 8) % 8, k = Math.min(7, Math.floor(w));
  return g.start[k] + (w - k) * g.len[k];
}

interface Lead { u: number; pts: P3[]; dir: P3; length: number; junction: P2; heading: number; turn: number }

/** The path of one end of a lead on the flat: a straight, a bend (left +), a straight. Returns its far end and final heading. */
export function leadTip(junction: P2, heading: number, turn: number, stem: number, angleDeg: number, radius: number, length: number): { at: P2; heading: number } {
  let [x, y] = junction, h = heading;
  x += Math.cos(h) * stem; y += Math.sin(h) * stem;
  const ang = angleDeg * RAD * turn;
  if (Math.abs(ang) > 1e-9) {
    const sg = Math.sign(ang), cx = x - sg * radius * Math.sin(h), cy = y + sg * radius * Math.cos(h);
    h += ang; x = cx + sg * radius * Math.sin(h); y = cy - sg * radius * Math.cos(h);
  }
  return { at: [x + Math.cos(h) * length, y + Math.sin(h) * length], heading: h };
}

/**
 * One lead, drawn from where it leaves the coil to its free end. `dz` is how
 * far it has to climb (+) or drop (−) before its level end.
 */
function makeLead(s: CableSpec, g: Layout, lead: LeadSpec, top: boolean, z: number, dz: number): Lead {
  const who = NAME[top ? 'top' : 'bottom'];
  if (!(lead.length >= 0) || !(lead.stem >= 0)) throw new CableError(`The ${who} lead's lengths must be 0 or more.`);
  if (!(Math.abs(lead.angle) <= 180)) throw new CableError(`The ${who} lead's bend must be between −180 and 180 degrees.`);
  if (Math.abs(lead.angle) > 1e-6 && !(lead.radius > s.wireD / 2)) throw new CableError(`The ${who} lead's bend radius must be more than ${(s.wireD / 2).toFixed(1)} mm (half the cable).`);
  const u = atToU(g, lead.at);
  const junction = g.xy(u);
  // The top lead carries on the way the coil is wound (counter-clockwise, hollow on its left);
  // the bottom lead leaves the other way, so the hollow is on its right.
  const heading = top ? g.heading(u) : g.heading(u) + Math.PI, turn = top ? 1 : -1;
  let [x, y] = junction, h = heading;
  const pts: P3[] = [];
  let len = 0;
  const straight = (d: number) => {
    if (d < 1e-6) return;
    const k = Math.max(1, Math.ceil(d / FINE)), x0 = x, y0 = y;
    for (let i = 1; i <= k; i++) pts.push([x0 + (Math.cos(h) * d * i) / k, y0 + (Math.sin(h) * d * i) / k, z]);
    x = x0 + Math.cos(h) * d; y = y0 + Math.sin(h) * d; len += d;
  };
  const bend = (ang: number, rad: number) => {
    if (Math.abs(ang) < 1e-9) return;
    const sg = Math.sign(ang), cx = x - sg * rad * Math.sin(h), cy = y + sg * rad * Math.cos(h);
    const k = Math.max(4, Math.ceil((rad * Math.abs(ang)) / FINE)), h0 = h;
    for (let i = 1; i <= k; i++) { const hh = h0 + (ang * i) / k; pts.push([cx + sg * rad * Math.sin(hh), cy - sg * rad * Math.cos(hh), z]); }
    h = h0 + ang; x = cx + sg * rad * Math.sin(h); y = cy - sg * rad * Math.cos(h); len += rad * Math.abs(ang);
  };
  const hgt = Math.abs(dz), rb = s.climbR;
  const th = hgt < 1e-6 ? 0 : hgt >= 2 * rb ? Math.PI / 2 : Math.acos(1 - hgt / (2 * rb)), mid = hgt >= 2 * rb ? hgt - 2 * rb : 0;
  const climbRun = 2 * rb * Math.sin(th) + mid * Math.cos(th);
  /** Two bends in the vertical plane, with a straight between when the climb is tall enough. */
  const climb = () => {
    if (th === 0) return;
    const sg = Math.sign(dz), k = Math.max(4, Math.ceil((rb * th) / FINE)), x0 = x, y0 = y, cs = Math.cos(h), sn = Math.sin(h);
    const put = (d: number, up: number) => pts.push([x0 + cs * d, y0 + sn * d, z + sg * up]);
    for (let i = 1; i <= k; i++) { const p = (th * i) / k; put(rb * Math.sin(p), rb * (1 - Math.cos(p))); }
    const d1 = rb * Math.sin(th), u1 = rb * (1 - Math.cos(th));
    if (mid > 1e-6) { const km = Math.max(1, Math.ceil(mid / FINE)); for (let i = 1; i <= km; i++) put(d1 + (mid * Math.cos(th) * i) / km, u1 + (mid * Math.sin(th) * i) / km); }
    for (let i = k - 1; i >= 0; i--) { const p = (th * i) / k; put(climbRun - rb * Math.sin(p), hgt - rb * (1 - Math.cos(p))); }
    x = x0 + cs * climbRun; y = y0 + sn * climbRun; z += dz; len += 2 * rb * th + mid;
  };

  straight(lead.stem);
  bend(lead.angle * RAD * turn, lead.radius);
  if (th === 0) straight(lead.length);
  else {
    // A lead that carries more or less straight on is still over (or under) the corner of the
    // other turns for a little way: it must be past them before it changes height.
    const clear = Math.abs(lead.angle) < 60 ? g.r + s.wireD / 2 + 1 : 0;
    straight(clear);
    climb();
    straight(Math.max(0, lead.length - clear - climbRun));
  }
  return { u, pts, dir: [Math.cos(h), Math.sin(h), 0], length: len, junction, heading, turn };
}

/** Something physically wrong with a cable that can still be drawn. `end` says which end it concerns, if one. */
export interface CableWarning { end: 'top' | 'bottom' | null; text: string }
export interface SolvedCable {
  /** Clashes found: a connector over the coil, or the cable crossing itself. Empty when it is sound. */
  warnings: CableWarning[];
  /** Centreline from the free end of the bottom-turn lead to the free end of the top-turn lead. */
  path: P3[];
  /** The two cable ends: where a connector attaches and the direction it points (unit, level). */
  ends: { top: { at: P3; dir: P3 }; bottom: { at: P3; dir: P3 } };
  /**
   * For drawing and dragging the leads from above: where each leaves the coil, the way it is
   * heading there, and which way a positive bend turns it (+1 left, −1 right).
   */
  leads: { top: { junction: P2; heading: number; turn: number }; bottom: { junction: P2; heading: number; turn: number } };
  turns: number;
  /** Footprint of the coil itself over the outside of the cable. */
  footprint: { length: number; width: number; height: number };
  /** Hollow middle, inside the cable. */
  hollow: { length: number; width: number };
}

interface Built { g: Layout; n: number; a: Lead; b: Lead; travel: number; zEnd: number; total: number }

/** Work out the coil for these settings, or throw a CableError saying what does not fit. */
export function solveCable(s: CableSpec): SolvedCable {
  for (const [name, v] of [['Cable diameter', s.wireD], ['Cable length', s.totalLen], ['Coil length', s.outerL], ['Coil width', s.outerW]] as const)
    if (!(v > 0) || !Number.isFinite(v)) throw new CableError(`${name} must be more than 0.`);
  if (!(s.gap > 0)) throw new CableError('The gap between turns must be more than 0.');
  if (s.climbR <= s.wireD / 2) throw new CableError(`The climb bend radius must be more than ${(s.wireD / 2).toFixed(1)} mm.`);

  const inHollow = (g: Layout, p: number[]) => Math.abs(p[0]) <= g.lc / 2 - s.wireD / 2 - CLEARANCE && Math.abs(p[1]) <= g.wc / 2 - s.wireD / 2 - CLEARANCE;
  const outside = (g: Layout, p: number[]) => Math.abs(p[0]) >= g.lc / 2 + s.wireD / 2 + CLEARANCE || Math.abs(p[1]) >= g.wc / 2 + s.wireD / 2 + CLEARANCE;
  const tipOf = (l: Lead): P3 => (l.pts.length ? l.pts[l.pts.length - 1] : [l.junction[0], l.junction[1], 0]);

  /** The whole cable for one footprint length and number of extra turns. */
  const build = (outerL: number, n: number): Built | null => {
    const g = layout(s, outerL);
    // A first pass with flat leads gives where each joins the coil, and so how tall the stack is.
    const b0 = makeLead(s, g, s.top, true, 0, 0), a0 = makeLead(s, g, s.bottom, false, 0, 0);
    let base = (((b0.u - a0.u) % g.perim) + g.perim) % g.perim;
    if (base < 1e-6) base = g.perim; // both leads at the same spot: one whole turn between them
    const travel = base + n * g.perim;
    if (travel <= 0) return null;
    const zEnd = g.rise * travel;
    const target = (l: LeadSpec, flat: Lead, top: boolean) => {
      if (!l.connector) return top ? zEnd : 0;
      const flushTop = zEnd + s.wireD / 2 - l.connector.height / 2, flushBottom = -s.wireD / 2 + l.connector.height / 2;
      return top || inHollow(g, tipOf(flat)) ? flushTop : flushBottom;
    };
    const b = makeLead(s, g, s.top, true, zEnd, target(s.top, b0, true) - zEnd);
    const a = makeLead(s, g, s.bottom, false, 0, target(s.bottom, a0, false));
    return { g, n, a, b, travel, zEnd, total: a.length + b.length + g.stretch * travel };
  };

  /** A connector has to lie wholly in the hollow or wholly outside the coil, not across the cable. */
  const problems = (bt: Built): CableWarning[] => {
    const probs: CableWarning[] = [];
    for (const [which, lead] of [['top', bt.b], ['bottom', bt.a]] as const) {
      const c = s[which].connector;
      if (!c) continue;
      const tip = tipOf(lead), [dx, dy] = lead.dir;
      // Checked from just past its near end, which is where the lead itself arrives.
      let hollow = 0, out = 0, across = 0;
      const steps = Math.max(4, Math.ceil(c.length / 4));
      for (let i = 1; i <= steps; i++) for (const fv of [-0.5, 0, 0.5]) {
        const fu = Math.max(i / steps, Math.min(1, 2 / c.length));
        const p = [tip[0] + dx * c.length * fu - dy * c.width * fv, tip[1] + dy * c.length * fu + dx * c.width * fv];
        if (inHollow(bt.g, p)) hollow++; else if (outside(bt.g, p)) out++; else across++;
      }
      if (across || (hollow && out)) probs.push({ end: which, text: `The connector on the ${NAME[which]} end overlaps the coil. Move or turn that end, make a J wider, or change the coil size.` });
    }
    return probs;
  };

  const lMin = 2 * s.cornerR + s.wireD + 1e-6;
  const feasible: Built[] = [], rejected: { bt: Built; probs: CableWarning[] }[] = [];
  let firstError: CableError | null = null;
  const b0 = build(s.outerL, 0); // throws for settings that can never work
  if (b0) {
    // Most whole turns that still fit in the cable at the asked-for coil length.
    let nFloor = -1;
    while (true) {
      const t = build(s.outerL, nFloor + 1);
      if (!t || t.total > s.totalLen) break;
      nFloor++;
      if (nFloor > 10000) throw new CableError('The cable is far too long for this coil size.');
    }
    const fit = (n: number, grow: boolean): Built | null => {
      if (n < 0) return null;
      try {
        let lo: number, hi: number;
        if (grow) {
          lo = s.outerL; hi = s.outerL + 10;
          while ((build(hi, n)?.total ?? Infinity) < s.totalLen) { hi += 10; if (hi > s.outerL + 1000) return null; }
        } else {
          lo = lMin; hi = s.outerL;
          if ((build(lo, n)?.total ?? Infinity) > s.totalLen) return null;
        }
        for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi); if ((build(mid, n)?.total ?? Infinity) < s.totalLen) lo = mid; else hi = mid; }
        return build(hi, n);
      } catch (e) { if (e instanceof CableError) { firstError ??= e; return null; } throw e; }
    };
    const tries: [number, boolean][] = [];
    if (s.fit !== 'grow') tries.push([nFloor + 1, false]);
    if (s.fit !== 'shrink') tries.push([nFloor, true], [nFloor - 1, true], [nFloor - 2, true]);
    for (const [n, grow] of tries) {
      const bt = fit(n, grow);
      if (!bt || Math.abs(bt.total - s.totalLen) > 0.01) continue;
      const probs = problems(bt);
      if (probs.length) rejected.push({ bt, probs }); else feasible.push(bt);
    }
  }
  const off = (bt: Built) => Math.abs(bt.g.outerL - s.outerL);
  if (!feasible.length && !rejected.length) throw firstError ?? new CableError('No coil fits these settings; the cable may be too short for the two leads.');
  // Closest to the asked-for coil length first, clean ones before any with a clash. A clash
  // (a connector over the coil, or the cable crossing itself) does not stop the cable being
  // drawn: it comes back with a warning, so it can be seen and put right.
  feasible.sort((x, y) => off(x) - off(y));
  rejected.sort((x, y) => off(x.bt) - off(y.bt));
  const order = [...feasible.map((bt) => ({ bt, probs: [] as CableWarning[] })), ...rejected];
  let fallback: SolvedCable | null = null;
  for (const { bt, probs } of order) {
    const done = finish(s, bt);
    done.warnings.push(...probs);
    if (!done.warnings.length) return done;
    fallback ??= done;
  }
  return fallback!;
}

/** The centreline and ends for one worked-out coil, with a warning if the cable would run into itself. */
function finish(s: CableSpec, bt: Built): SolvedCable {
  const { g } = bt;
  const pts: P3[] = [];
  for (let i = bt.a.pts.length - 1; i >= 0; i--) pts.push(bt.a.pts[i]);
  {
    const step = 2, us: number[] = [0], uA = bt.a.u;
    for (let lap = Math.floor(uA / g.perim) - 1; lap * g.perim < uA + bt.travel; lap++)
      for (let m = 0; m < 8; m++) {
        const from = lap * g.perim + g.start[m], len = g.len[m];
        if (len <= 1e-9) continue;
        const k = Math.max(1, Math.ceil(len / step));
        for (let i = 0; i < k; i++) { const v = from + (len * i) / k - uA; if (v > 0.25 * step && v < bt.travel - 0.25 * step) us.push(v); }
      }
    us.push(bt.travel);
    for (const v of us) { const [x, y] = g.xy(uA + v); pts.push([x, y, g.rise * v]); }
  }
  pts.push(...bt.b.pts);
  const sy = s.mirror ? -1 : 1;
  const path: P3[] = [];
  for (const p0 of pts) {
    const p: P3 = [p0[0], sy * p0[1], p0[2]];
    const q = path[path.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-4) path.push(p);
  }

  // The cable must not run into itself (compare points more than 40 mm apart along it).
  const warnings: CableWarning[] = [];
  crossing: {
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
          if (d2 < need) {
            warnings.push({ end: null, text: `The cable crosses itself (${Math.sqrt(d2).toFixed(1)} mm between centres where it needs ${s.wireD.toFixed(1)}). Move or turn an end, shorten it, or use a wider coil.` });
            break crossing;
          }
        }
    }
  }
  const seen = (l: Lead) => ({ junction: [l.junction[0], sy * l.junction[1]] as P2, heading: sy * l.heading, turn: sy * l.turn });
  return {
    path, warnings,
    ends: {
      bottom: { at: path[0], dir: [bt.a.dir[0], sy * bt.a.dir[1], 0] },
      top: { at: path[path.length - 1], dir: [bt.b.dir[0], sy * bt.b.dir[1], 0] },
    },
    leads: { top: seen(bt.b), bottom: seen(bt.a) },
    turns: bt.travel / g.perim,
    footprint: { length: g.outerL, width: s.outerW, height: bt.zEnd + s.wireD },
    hollow: { length: g.outerL - 2 * s.wireD, width: s.outerW - 2 * s.wireD },
  };
}

/**
 * The spot on the coil nearest a point seen from above, as a lead's `at`.
 * Snaps to where a straight meets a corner when within `snap` mm of it.
 */
export function nearestAt(s: Pick<CableSpec, 'wireD' | 'outerW' | 'cornerR' | 'gap' | 'mirror'>, outerL: number, x: number, y: number, snap = 4): number {
  const g = layout(s, outerL), py = s.mirror ? -y : y;
  let best = 0, bd = Infinity;
  for (let k = 0; k < 8; k++) {
    if (g.len[k] <= 1e-9) continue;
    const n = Math.max(2, Math.ceil(g.len[k]));
    for (let i = 0; i <= n; i++) {
      const [qx, qy] = g.xy(g.start[k] + (g.len[k] * i) / n), d = Math.hypot(qx - x, qy - py);
      if (d < bd - 1e-9) { bd = d; best = k + (i / n) * 0.999999; }
    }
  }
  const k = Math.floor(best), along = (best - k) * g.len[k];
  if (along < snap) return k;
  if (g.len[k] - along < snap) return (k + 1) % 8;
  return best;
}

export type LeadPreset = 'inline' | 'side' | 'j' | 'middle' | 'none';
/**
 * Ready-made leads. `end` is the end of the coil it sits at. For a J, `size`
 * is { width across the U, overall length from the bottom of the U to the tip }.
 */
export function presetLead(kind: LeadPreset, top: boolean, end: 'left' | 'right', s: Pick<CableSpec, 'wireD' | 'outerL' | 'outerW' | 'cornerR' | 'gap'>, length: number, j = { width: 20, length: 50 }): Omit<LeadSpec, 'connector'> {
  const g = layout(s, s.outerL), d = s.wireD;
  // Worked out for the top lead at the right-hand end, as (piece, fraction along it).
  let k = 0, f = 1, stem = 0, angle = 0, radius = Math.max(8, 1.3 * d), len = length;
  if (kind === 'side') k = 2;
  else if (kind === 'j') {
    radius = Math.max(d / 2 + 0.1, (j.width - d) / 2);
    stem = Math.max(g.r - radius, 0);
    if (radius > g.r && g.a > 0) f = Math.max(0, 1 - (radius - g.r) / g.a); // a wide U starts before the corner
    angle = -180;
    len = Math.max(0, j.length - d / 2 - radius);
  } else if (kind === 'middle') {
    // An arc that leaves the outline tangentially and finishes on the long axis, heading inward.
    const most = Math.max(g.b / 2, (g.r + g.b / 2) / 2) - 0.01;
    radius = Math.max(d / 2 + 0.5, Math.min(radius, most));
    if (radius <= g.b / 2 + 1e-9) { k = 2; f = g.b > 0 ? (g.b / 2 - radius) / g.b : 0; angle = 90; }
    else {
      const phi0 = Math.asin(Math.max(-1, Math.min(1, (g.b / 2 - radius) / (g.r - radius))));
      k = 1; f = (phi0 + Math.PI / 2) / (Math.PI / 2); angle = 90 - phi0 / RAD;
    }
  } else if (kind === 'none') len = 0;
  // The left-hand end is the same thing half a turn round; the bottom lead is the mirror image.
  const flip = top ? end === 'left' : end === 'right';
  if (flip) k = (k + 4) % 8;
  let at = k + f;
  if (!top) at = ((8 - k) % 8) + (1 - f);
  return { at: ((at % 8) + 8) % 8, stem, angle, radius, length: len };
}

export const DEFAULT_CABLE: CableSpec = (() => {
  const base = { wireD: 6, totalLen: 1151, outerL: 115, outerW: 40, cornerR: 12, gap: 0.2 };
  return {
    ...base, fit: 'nearest', climbR: 8, mirror: false,
    top: { ...presetLead('j', true, 'left', base, 0), connector: null },
    bottom: { ...presetLead('middle', false, 'left', base, 5), connector: null },
  } as CableSpec;
})();

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
