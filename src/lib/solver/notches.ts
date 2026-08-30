import type {
  PartInput, PlacedPart, ResolvedNotch, Ring, Settings, Tray, Vec2,
} from '../../types';
import { pointInRing } from '../geom2d';
import { updateTrayBlocked } from './placement';

/**
 * Finger notches: scallops cut outward from a pocket wall so a part can be
 * pinched out. A notch is stored as a normalized arc-length position along
 * the pocket outline rather than as a point, because the solver moves and
 * rotates outlines rigidly - an arc position survives all of that unchanged.
 *
 * Arc positions are measured from a canonical start vertex chosen by a
 * rotation-invariant rule (farthest from the ring's centroid), so the same
 * stored number lands on the same physical spot however the copy was placed.
 */

export function ringCentroid(ring: Ring): Vec2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

/** Rotation/translation-invariant starting vertex for arc measurement. */
export function canonicalStart(ring: Ring): number {
  const c = ringCentroid(ring);
  let best = 0;
  let bestD = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i][0] - c[0]) ** 2 + (ring[i][1] - c[1]) ** 2;
    if (d > bestD + 1e-9) { bestD = d; best = i; }
  }
  return best;
}

export function ringPerimeter(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

const wrap01 = (t: number) => ((t % 1) + 1) % 1;

/** Point at normalized arc position t, measured from the canonical start. */
export function pointAtT(ring: Ring, t: number): Vec2 {
  const start = canonicalStart(ring);
  const total = ringPerimeter(ring);
  let remaining = wrap01(t) * total;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[(start + k) % ring.length];
    const b = ring[(start + k + 1) % ring.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= seg || k === ring.length - 1) {
      const u = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    remaining -= seg;
  }
  return ring[start];
}

/** Arc position of the outline point nearest to p. */
export function nearestT(ring: Ring, p: Vec2): number {
  const start = canonicalStart(ring);
  const total = ringPerimeter(ring);
  let bestT = 0;
  let bestD = Infinity;
  let walked = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[(start + k) % ring.length];
    const b = ring[(start + k + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const qx = a[0] + dx * u, qy = a[1] + dy * u;
    const d = (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
    const seg = Math.sqrt(len2);
    if (d < bestD) {
      bestD = d;
      bestT = (walked + seg * u) / total;
    }
    walked += seg;
  }
  return wrap01(bestT);
}

/** Does a circle touch a silhouette (any ring edge within reach, or centre inside)? */
function circleTouchesPoly(centre: Vec2, r: number, poly: PlacedPart['poly']): boolean {
  for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((centre[0] - a[0]) * dx + (centre[1] - a[1]) * dy) / len2));
      const qx = a[0] + dx * u, qy = a[1] + dy * u;
      if (Math.hypot(centre[0] - qx, centre[1] - qy) < r) return true;
    }
  }
  return pointInRing(centre, poly[0]);
}

export interface NotchContext {
  tray: Tray;
  part: PlacedPart;
  settings: Settings;
}

/**
 * The ring a finger notch lives on: the tool outline itself, not the pocket.
 * A notch exists to pinch the tool out, so its scallop must straddle the
 * tool's edge - on a rectangular pocket the pocket ring can be far from the
 * tool, which would put the notch uselessly out in the TPU block.
 */
export function notchRing(part: PlacedPart): Ring {
  return (part.rawPoly?.[0]?.length ?? 0) >= 3 ? part.rawPoly[0] : part.poly[0];
}

/**
 * Why a notch cannot sit at this point, or null when it can.
 *
 * There is deliberately no tray-edge rule: trays are sized snugly, so pocket
 * walls usually sit 2.95 mm from an edge and an edge rule would outlaw half
 * of every outline. A notch near the edge simply opens through the side wall,
 * exactly as the thumb notches already do.
 */
export function notchProblemAt(ctx: NotchContext, centre: Vec2): string | null {
  const { tray, part, settings: s } = ctx;
  const r = s.fingerNotchRadius;

  for (const other of tray.parts) {
    if (other === part) continue;
    if (circleTouchesPoly(centre, r + s.wall, other.poly)) {
      return `overlaps the ${other.name} pocket`;
    }
  }
  for (const n of tray.notches) {
    if (Math.hypot(centre[0] - n.cx, centre[1] - n.cy) < r + n.radius + 1) {
      return 'overlaps a thumb notch';
    }
  }
  return null;
}

const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
};

interface Sample { t: number; p: Vec2; ang: number }

function sampleValid(ctx: NotchContext): Sample[] {
  const ring = notchRing(ctx.part);
  const per = ringPerimeter(ring);
  const count = Math.max(48, Math.min(360, Math.round(per / 2)));
  const c = ringCentroid(ring);
  const out: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const p = pointAtT(ring, t);
    if (notchProblemAt(ctx, p) === null) {
      out.push({ t, p, ang: Math.atan2(p[1] - c[1], p[0] - c[0]) });
    }
  }
  return out;
}

/**
 * Best opposite pair for this pocket: positions facing each other across the
 * centroid, preferring the closer-together axis (pinching across a part's
 * width, not its length). Angle and distance trade off in one score - a
 * strict opposite-angle-first ranking is unstable, because whether an exactly
 * opposite sample pair exists depends on the sampling parity, not the shape.
 * Null when no valid pair exists.
 */
export function autoPlacePair(ctx: NotchContext): { a: number; b: number } | null {
  const valid = sampleValid(ctx);
  if (valid.length < 2) return null;
  const r = ctx.settings.fingerNotchRadius;
  let best: { a: Sample; b: Sample; score: number } | null = null;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const va = valid[i], vb = valid[j];
      const dist = Math.hypot(va.p[0] - vb.p[0], va.p[1] - vb.p[1]);
      if (dist < 2 * r + 2) continue;
      const err = angDiff(va.ang, vb.ang + Math.PI);
      if (err > Math.PI / 2) continue;
      const score = dist * (1 + err);
      if (!best || score < best.score) best = { a: va, b: vb, score };
    }
  }
  if (!best) return null;
  // 'a' is the left-hand notch so the pair reads left/right in the editor.
  const [first, second] = best.a.p[0] <= best.b.p[0] ? [best.a, best.b] : [best.b, best.a];
  return { a: first.t, b: second.t };
}

/**
 * Arc position diametrically across the shape from t, restricted to valid
 * spots. Null when nowhere across the shape is valid.
 */
export function alignOppositeT(ctx: NotchContext, t: number): number | null {
  const ring = notchRing(ctx.part);
  const c = ringCentroid(ring);
  const p = pointAtT(ring, t);
  const target = Math.atan2(p[1] - c[1], p[0] - c[0]) + Math.PI;
  const r = ctx.settings.fingerNotchRadius;
  const valid = sampleValid(ctx);
  let best: { t: number; err: number } | null = null;
  for (const v of valid) {
    if (Math.hypot(v.p[0] - p[0], v.p[1] - p[1]) < 2 * r + 2) continue;
    const err = angDiff(v.ang, target);
    if (!best || err < best.err) best = { t: v.t, err };
  }
  return best && best.err <= Math.PI / 2 ? best.t : null;
}

/**
 * Resolve every stored pair on a tray to coordinates plus validity. Mutates
 * the placed parts and the tray's blocked flag; returns the problems found.
 * Hand-placed positions are never moved - an invalid notch blocks the tray's
 * geometry until the user fixes it in the 2D editor.
 */
export function resolveTrayNotches(tray: Tray, parts: PartInput[], s: Settings): string[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const problems: string[] = [];
  for (const placed of tray.parts) {
    const input = byId.get(placed.partId);
    const pair = input?.fingerNotches?.find((n) => n.instance === placed.instance);
    if (!pair) {
      placed.fingerNotches = undefined;
      continue;
    }
    const ctx: NotchContext = { tray, part: placed, settings: s };
    const ring = notchRing(placed);
    const resolved: ResolvedNotch[] = (['a', 'b'] as const).map((key) => {
      const t = wrap01(pair[key]);
      const [x, y] = pointAtT(ring, t);
      const reason = notchProblemAt(ctx, [x, y]) ?? undefined;
      return { key, t, x, y, valid: !reason, reason };
    });
    const [na, nb] = resolved;
    if (na.valid && nb.valid && Math.hypot(na.x - nb.x, na.y - nb.y) < 2 * s.fingerNotchRadius + 2) {
      nb.valid = false;
      nb.reason = 'overlaps its partner notch';
    }
    placed.fingerNotches = resolved;
    for (const n of resolved) {
      if (!n.valid) {
        problems.push(
          `${placed.name}${placed.instance ? ` #${placed.instance + 1}` : ''}: finger notch ${n.reason}. ` +
          `Fix it in the 2D view - geometry for this tray is withheld until then.`,
        );
      }
    }
  }
  updateTrayBlocked(tray);
  return problems;
}
