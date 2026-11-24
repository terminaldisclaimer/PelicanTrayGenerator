import type { TriMesh } from '../mesh/types';

/**
 * A round cable wound as a stacked rounded-rectangle coil (each turn directly
 * on top of the one before), with a lead at each end of the stack. Each lead
 * is set up on its own:
 *
 *  - 'inside': the cable peels off at a short end, bends inward and runs along
 *    the long axis into the hollow middle (at 90 degrees to that end).
 *  - 'end': the cable carries straight on past the corner, in line with the
 *    long side it was running along, and sticks out past the end of the coil.
 *  - 'side': the same from a short end, so it sticks out past a long side.
 *  - 'j': the cable carries on past the corner, curls outward in a U whose
 *    bottom is level with the end of the coil, and runs back along the
 *    outside of that long side.
 *  - 'none': the cable simply stops on the coil.
 *
 * A lead with a connector climbs or drops (two bends) so the connector sits
 * within the height of the stack: flush with the top for the top lead and for
 * any inside lead, flush with the bottom for an outside lead on the bottom turn.
 *
 * The total length, both leads and where each one leaves the coil
 * over-constrain it, so the footprint length flexes by a few millimetres to
 * make the length come out exactly.
 *
 * The coil, the J and the inside lead follow the owner's Fusion 360
 * "SnakedWire" script. All lengths are mm. Pure maths: no kernel needed.
 */
export type LeadStyle = 'inside' | 'end' | 'side' | 'j' | 'none';
export interface LeadSpec {
  style: LeadStyle;
  /** Which end of the coil the lead is at; 'auto' = whichever needs the smaller change to the coil length. */
  end: 'left' | 'right' | 'auto';
  /** Level straight run at the free end (for a J: overall length from the bottom of the U to the tip). */
  length: number;
  /** J only: width across the U, outside of cable to outside of cable. */
  jWidth: number;
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
  /** Bend radius where an inside lead leaves its turn for the middle. */
  turnInR: number;
  /** Radius of the two bends in a climb. */
  climbR: number;
  /** Wind the other way round (mirrors the whole cable, swapping the near and far sides). */
  mirror: boolean;
  /** The lead leaving the top turn, and the one leaving the bottom turn. */
  top: LeadSpec;
  bottom: LeadSpec;
}

export const DEFAULT_CABLE: CableSpec = {
  wireD: 6, totalLen: 1151, outerL: 115, outerW: 40, cornerR: 12, gap: 0.2, fit: 'nearest', turnInR: 8, climbR: 8, mirror: false,
  top: { style: 'j', end: 'left', length: 50, jWidth: 20, connector: null },
  bottom: { style: 'inside', end: 'auto', length: 5, jWidth: 20, connector: null },
};

export class CableError extends Error {}

type P3 = [number, number, number];
const FINE = 1.0;
const CLEARANCE = 0.5;
const NAME: Record<'top' | 'bottom', string> = { top: 'top-turn', bottom: 'bottom-turn' };

interface Layout { outerL: number; lc: number; wc: number; a: number; b: number; r: number; arc: number; perim: number; rise: number; stretch: number; xy: (u: number) => [number, number] }

function layout(s: CableSpec, outerL: number): Layout {
  const r = s.cornerR;
  const lc = outerL - s.wireD, wc = s.outerW - s.wireD;
  if (!(s.wireD / 2 < r && r <= Math.min(lc, wc) / 2 + 1e-9))
    throw new CableError(`Corner radius must be more than ${(s.wireD / 2).toFixed(1)} and at most ${(Math.min(lc, wc) / 2).toFixed(1)} mm.`);
  const a = lc - 2 * r, b = wc - 2 * r, arc = (Math.PI * r) / 2;
  const perim = 2 * a + 2 * b + 4 * arc;
  const rise = (s.wireD + s.gap) / perim;
  // Footprint loop, counter-clockwise from the left end of the near long side:
  // near straight, right-near corner, right straight, right-far corner, far straight, and so on.
  const pieces: [number, (t: number) => [number, number]][] = [
    [a, (t) => [-a / 2 + t, -wc / 2]],
    [arc, (t) => [a / 2 + r * Math.sin(t / r), -b / 2 - r * Math.cos(t / r)]],
    [b, (t) => [lc / 2, -b / 2 + t]],
    [arc, (t) => [a / 2 + r * Math.cos(t / r), b / 2 + r * Math.sin(t / r)]],
    [a, (t) => [a / 2 - t, wc / 2]],
    [arc, (t) => [-a / 2 - r * Math.sin(t / r), b / 2 + r * Math.cos(t / r)]],
    [b, (t) => [-lc / 2, b / 2 - t]],
    [arc, (t) => [-a / 2 - r * Math.cos(t / r), -b / 2 - r * Math.sin(t / r)]],
  ];
  const xy = (u: number): [number, number] => {
    let rem = ((u % perim) + perim) % perim;
    for (const [len, f] of pieces) {
      if (len <= 1e-12) continue;
      if (rem <= len) return f(rem);
      rem -= len;
    }
    return pieces[0][1](0);
  };
  return { outerL, lc, wc, a, b, r, arc, perim, rise, stretch: Math.sqrt(1 + rise * rise), xy };
}

/** Where on the loop the tangent points change (for sampling the coil exactly at them). */
const breaks = (g: Layout) => [0, g.a, g.a + g.arc, g.a + g.arc + g.b, g.a + 2 * g.arc + g.b, 2 * g.a + 2 * g.arc + g.b, 2 * g.a + 3 * g.arc + g.b, 2 * g.a + 3 * g.arc + 2 * g.b];

interface Lead { u: number; pts: P3[]; dir: P3; length: number }

/**
 * A lead leaving the coil in the direction of winding (counter-clockwise seen
 * from above), drawn from where it leaves the coil to its free end. `dz` is how
 * far it has to climb (+) or drop (−) before its level end.
 */
function leadOut(s: CableSpec, g: Layout, lead: LeadSpec, end: 'left' | 'right', z: number, dz: number, who: string): Lead {
  const { a, b, r, lc, wc, arc } = g;
  let x = 0, y = 0, h = 0, u = 0; // turtle: position, heading (radians), and loop position of the junction
  const pts: P3[] = [];
  let len = 0;
  const straight = (d: number) => {
    if (d < 1e-6) return;
    const k = Math.max(1, Math.ceil(d / FINE)), x0 = x, y0 = y;
    for (let i = 1; i <= k; i++) pts.push([x0 + (Math.cos(h) * d * i) / k, y0 + (Math.sin(h) * d * i) / k, z]);
    x = x0 + Math.cos(h) * d; y = y0 + Math.sin(h) * d; len += d;
  };
  /** Turn by `ang` (left +, right −) on radius `rad`. */
  const bend = (ang: number, rad: number) => {
    if (Math.abs(ang) < 1e-9) return;
    const sg = Math.sign(ang), cx = x - sg * rad * Math.sin(h), cy = y + sg * rad * Math.cos(h);
    const k = Math.max(4, Math.ceil((rad * Math.abs(ang)) / FINE)), h0 = h;
    for (let i = 1; i <= k; i++) { const hh = h0 + (ang * i) / k; pts.push([cx + sg * rad * Math.sin(hh), cy - sg * rad * Math.cos(hh), z]); }
    h = h0 + ang; x = cx + sg * rad * Math.sin(h); y = cy - sg * rad * Math.cos(h); len += rad * Math.abs(ang);
  };
  /** Two bends in the vertical plane, with a straight between when the climb is tall enough. Returns the level distance used. */
  const climbRun = (): number => {
    const hgt = Math.abs(dz);
    if (hgt < 1e-6) return 0;
    const rb = s.climbR;
    return hgt >= 2 * rb ? 2 * rb : 2 * rb * Math.sin(Math.acos(1 - hgt / (2 * rb)));
  };
  const climb = () => {
    const hgt = Math.abs(dz), sg = Math.sign(dz), rb = s.climbR;
    if (hgt < 1e-6) return;
    const th = hgt >= 2 * rb ? Math.PI / 2 : Math.acos(1 - hgt / (2 * rb)), mid = hgt >= 2 * rb ? hgt - 2 * rb : 0;
    const k = Math.max(4, Math.ceil((rb * th) / FINE)), x0 = x, y0 = y, cs = Math.cos(h), sn = Math.sin(h);
    const put = (d: number, up: number) => pts.push([x0 + cs * d, y0 + sn * d, z + sg * up]);
    for (let i = 1; i <= k; i++) { const p = (th * i) / k; put(rb * Math.sin(p), rb * (1 - Math.cos(p))); }
    const d1 = rb * Math.sin(th), u1 = rb * (1 - Math.cos(th)), dTot = 2 * d1 + mid * Math.cos(th);
    if (mid > 1e-6) { const km = Math.max(1, Math.ceil(mid / FINE)); for (let i = 1; i <= km; i++) put(d1 + (mid * Math.cos(th) * i) / km, u1 + (mid * Math.sin(th) * i) / km); }
    for (let i = k - 1; i >= 0; i--) { const p = (th * i) / k; put(dTot - rb * Math.sin(p), hgt - rb * (1 - Math.cos(p))); }
    x = x0 + cs * dTot; y = y0 + sn * dTot; z += dz; len += 2 * rb * th + mid;
  };

  // Everything is drawn for the right-hand end, then turned half way round for the left.
  if (lead.style === 'end' || lead.style === 'none') { u = a; x = a / 2; y = -wc / 2; h = 0; }
  else if (lead.style === 'side') { u = a + arc + b; x = lc / 2; y = b / 2; h = Math.PI / 2; }
  else if (lead.style === 'j') {
    if (lead.jWidth < 2 * s.wireD + s.gap - 1e-9) throw new CableError(`The ${who} J must be at least ${(2 * s.wireD + s.gap).toFixed(1)} mm wide so its two legs do not touch.`);
    const rj = (lead.jWidth - s.wireD) / 2, xt = lc / 2 - rj;
    if (xt < -a / 2 + 1e-9) throw new CableError(`The ${who} J is too wide for this coil (at most ${(2 * (lc - r) + s.wireD).toFixed(1)} mm).`);
    if (lead.length < lead.jWidth / 2 - 1e-9) throw new CableError(`The ${who} J must be at least ${(lead.jWidth / 2).toFixed(1)} mm long (half its width).`);
    const xj = Math.min(a / 2, xt);
    u = xj + a / 2; x = xj; y = -wc / 2; h = 0;
    straight(xt - xj);
    bend(-Math.PI, rj); // outward, so its bottom is level with the end of the coil
  } else { // inside: an arc that leaves the outline tangentially and finishes on the long axis, heading inward
    const R = s.turnInR;
    if (R <= s.wireD / 2) throw new CableError(`The turn-in bend radius must be more than ${(s.wireD / 2).toFixed(1)} mm.`);
    if (R <= b / 2 + 1e-9) { u = a + arc + (b / 2 - R); x = lc / 2; y = -R; h = Math.PI / 2; bend(Math.PI / 2, R); }
    else if (R < r && R <= (r + b / 2) / 2 + 1e-9) {
      const phi0 = Math.asin(Math.max(-1, Math.min(1, (b / 2 - R) / (r - R))));
      u = a + r * (phi0 + Math.PI / 2); x = a / 2 + r * Math.cos(phi0); y = -b / 2 + r * Math.sin(phi0); h = phi0 + Math.PI / 2;
      bend(Math.PI / 2 - phi0, R);
    } else throw new CableError(`The turn-in bend radius must be at most ${Math.max(b / 2, (r + b / 2) / 2).toFixed(1)} mm with this corner radius and coil width.`);
  }
  if (lead.style === 'j') {
    climb();
    // A J's length is its whole reach from the bottom of the U, so its level run is what is left of that.
    straight(Math.max(0, lead.length - s.wireD / 2 - (lead.jWidth - s.wireD) / 2 - climbRun()));
  } else if (lead.style === 'inside') {
    climb();
    straight(Math.max(0, lead.length));
  } else if (lead.style !== 'none') {
    // Straight out: it must be past the corner of the turns under or over it before it changes height.
    const clear = Math.abs(dz) < 1e-6 ? 0 : r + s.wireD / 2 + 1;
    straight(clear);
    climb();
    straight(Math.max(0, lead.length - clear - climbRun()));
  }
  const dir: P3 = [Math.cos(h), Math.sin(h), 0];
  if (end === 'left') return { u: u + g.perim / 2, pts: pts.map((p) => [-p[0], -p[1], p[2]]), dir: [-dir[0], -dir[1], 0], length: len };
  return { u, pts, dir, length: len };
}

export interface SolvedCable {
  /** Centreline from the free end of the bottom-turn lead to the free end of the top-turn lead. */
  path: P3[];
  /** The two cable ends: where a connector attaches and the direction it points (unit, level). */
  ends: { top: { at: P3; dir: P3 }; bottom: { at: P3; dir: P3 } };
  turns: number;
  /** Footprint of the coil itself over the outside of the cable. */
  footprint: { length: number; width: number; height: number };
  /** Hollow middle, inside the cable. */
  hollow: { length: number; width: number };
}

interface Built { g: Layout; n: number; lenA: Lead; lenB: Lead; uA: number; travel: number; zEnd: number; total: number }

/** Work out the coil for these settings, or throw a CableError saying what does not fit. */
export function solveCable(s: CableSpec): SolvedCable {
  for (const [name, v] of [['Cable diameter', s.wireD], ['Cable length', s.totalLen], ['Coil length', s.outerL], ['Coil width', s.outerW]] as const)
    if (!(v > 0) || !Number.isFinite(v)) throw new CableError(`${name} must be more than 0.`);
  if (!(s.gap > 0)) throw new CableError('The gap between turns must be more than 0.');
  if (s.climbR <= s.wireD / 2) throw new CableError(`The climb bend radius must be more than ${(s.wireD / 2).toFixed(1)} mm.`);
  for (const which of ['top', 'bottom'] as const) {
    const l = s[which];
    if (!(l.length >= 0)) throw new CableError(`The ${NAME[which]} lead length must be 0 or more.`);
    if (l.style === 'inside' && l.connector) {
      const room = s.outerW - 2 * s.wireD - 2 * CLEARANCE;
      if (l.connector.width > room + 1e-9) throw new CableError(`The ${NAME[which]} connector (${l.connector.width.toFixed(1)} mm wide) is wider than the hollow middle of the coil (${room.toFixed(1)} mm across). Make the coil wider, turn the connector, or put it outside.`);
    }
  }

  /** The whole cable for one footprint length, number of extra turns and choice of ends. */
  const build = (outerL: number, n: number, endTop: 'left' | 'right', endBottom: 'left' | 'right'): Built | null => {
    const g = layout(s, outerL);
    // First pass with flat leads gives where each joins the coil, and so how tall the stack is.
    const flip = (e: 'left' | 'right') => (e === 'left' ? 'right' : 'left');
    // The bottom lead is drawn as its mirror image (a lead leaving the other way), then mirrored back.
    const junctionA = (u: number) => (((g.a - u) % g.perim) + g.perim) % g.perim;
    const b0 = leadOut(s, g, s.top, endTop, 0, 0, NAME.top), a0 = leadOut(s, g, s.bottom, flip(endBottom), 0, 0, NAME.bottom);
    const uA = junctionA(a0.u);
    let base = (((b0.u - uA) % g.perim) + g.perim) % g.perim;
    if (base < 1e-6) base = g.perim; // both leads at the same spot: at least one whole turn between them
    const travel = base + n * g.perim;
    if (travel <= 0) return null;
    const zEnd = g.rise * travel;
    const target = (l: LeadSpec, top: boolean) => {
      if (!l.connector || l.style === 'none') return top ? zEnd : 0;
      const flushTop = zEnd + s.wireD / 2 - l.connector.height / 2, flushBottom = -s.wireD / 2 + l.connector.height / 2;
      return top || l.style === 'inside' ? flushTop : flushBottom;
    };
    const lenB = leadOut(s, g, s.top, endTop, zEnd, target(s.top, true) - zEnd, NAME.top);
    const lenA = leadOut(s, g, s.bottom, flip(endBottom), 0, target(s.bottom, false), NAME.bottom);
    return { g, n, lenA, lenB, uA, travel, zEnd, total: lenA.length + lenB.length + g.stretch * travel };
  };

  /** What stops the inside leads and their connectors from fitting in the hollow. */
  const problems = (bt: Built): string[] => {
    const probs: string[] = [], half = bt.g.lc / 2;
    for (const [which, lead] of [['top', bt.lenB], ['bottom', bt.lenA]] as const) {
      const l = s[which];
      if (l.style !== 'inside') continue;
      const tip = lead.pts.length ? lead.pts[lead.pts.length - 1] : null;
      if (!tip) continue;
      const reach = Math.abs(tip[0]) - (half - s.wireD - s.gap);
      // It heads from one short end toward the other, so only running past the far end matters.
      const far = tip[0] * lead.dir[0] > 0;
      if (far && reach > 1e-9) probs.push(`the ${NAME[which]} lead reaches ${reach.toFixed(1)} mm too far toward the far end of the coil`);
      if (l.connector) {
        const end = tip[0] + lead.dir[0] * l.connector.length, over = Math.abs(end) - (half - s.wireD / 2 - CLEARANCE);
        if (end * lead.dir[0] > 0 && over > 1e-9) probs.push(`the ${NAME[which]} connector would run ${over.toFixed(1)} mm into the far end of the coil`);
      }
    }
    return probs;
  };

  const lMin = 2 * s.cornerR + s.wireD + 1e-6;
  const feasible: Built[] = [], rejected: { bt: Built; probs: string[] }[] = [];
  let firstError: CableError | null = null;
  const ends = (l: LeadSpec): ('left' | 'right')[] => (l.end === 'auto' ? ['left', 'right'] : [l.end]);
  for (const eT of ends(s.top)) for (const eB of ends(s.bottom)) {
    const at = (L: number, n: number) => build(L, n, eT, eB);
    let b0: Built | null;
    try { b0 = at(s.outerL, 0); } catch (e) { if (e instanceof CableError) { firstError ??= e; continue; } throw e; }
    if (!b0) continue;
    // Most whole turns that still fit in the cable at the asked-for coil length.
    let nFloor = -1;
    while (true) {
      const t = at(s.outerL, nFloor + 1);
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
          while ((at(hi, n)?.total ?? Infinity) < s.totalLen) { hi += 10; if (hi > s.outerL + 1000) return null; }
        } else {
          lo = lMin; hi = s.outerL;
          if ((at(lo, n)?.total ?? Infinity) > s.totalLen) return null;
        }
        for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi); if ((at(mid, n)?.total ?? Infinity) < s.totalLen) lo = mid; else hi = mid; }
        return at(hi, n);
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
  if (!feasible.length) {
    if (rejected.length) throw new CableError(`No coil fits these settings: ${rejected.reduce((m, x) => (off(x.bt) < off(m.bt) ? x : m)).probs.join('; ')}. Shorten that lead, use a shorter connector, or make the coil longer.`);
    throw firstError ?? new CableError('No coil fits these settings; the cable may be too short for the two leads.');
  }
  // Closest to the asked-for coil length first; one where the cable would cross itself is passed over.
  feasible.sort((x, y) => off(x) - off(y));
  let crossing: CableError | null = null;
  for (const bt of feasible) {
    try { return finish(s, bt); } catch (e) { if (e instanceof CableError) { crossing ??= e; continue; } throw e; }
  }
  throw crossing!;
}

/** The centreline and ends for one worked-out coil; throws if the cable would run into itself. */
function finish(s: CableSpec, bt: Built): SolvedCable {
  const { g } = bt;

  // ---- centreline: bottom lead (free end first), the coil, top lead ----
  const pts: P3[] = [];
  for (let i = bt.lenA.pts.length - 1; i >= 0; i--) { const p = bt.lenA.pts[i]; pts.push([-p[0], p[1], p[2]]); }
  {
    const step = 2, us: number[] = [0], marks = breaks(g);
    const first = Math.floor(bt.uA / g.perim) - 1;
    for (let lap = first; lap * g.perim < bt.uA + bt.travel; lap++)
      for (let m = 0; m < marks.length; m++) {
        const from = lap * g.perim + marks[m], to = lap * g.perim + (m + 1 < marks.length ? marks[m + 1] : g.perim), len = to - from;
        if (len <= 1e-9) continue;
        const k = Math.max(1, Math.ceil(len / step));
        for (let i = 0; i < k; i++) { const v = from + (len * i) / k - bt.uA; if (v > 0.25 * step && v < bt.travel - 0.25 * step) us.push(v); }
      }
    us.push(bt.travel);
    for (const v of us) { const [x, y] = g.xy(bt.uA + v); pts.push([x, y, g.rise * v]); }
  }
  pts.push(...bt.lenB.pts);
  const sy = s.mirror ? -1 : 1;
  const path: P3[] = [];
  for (const p0 of pts) {
    const p: P3 = [p0[0], sy * p0[1], p0[2]];
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
          if (d2 < need) throw new CableError(`The cable would run into itself (${Math.sqrt(d2).toFixed(1)} mm between centres, needs ${s.wireD.toFixed(1)}). Move one of the leads to the other end, shorten it, or use a wider coil.`);
        }
    }
  }

  return {
    path,
    ends: {
      bottom: { at: path[0], dir: [-bt.lenA.dir[0], sy * bt.lenA.dir[1], 0] },
      top: { at: path[path.length - 1], dir: [bt.lenB.dir[0], sy * bt.lenB.dir[1], 0] },
    },
    turns: bt.travel / g.perim,
    footprint: { length: g.outerL, width: s.outerW, height: bt.zEnd + s.wireD },
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
