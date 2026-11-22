import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import type { Silhouette } from './analyze';
import { buildCavity, type PocketOptions, DEFAULT_POCKET } from './pocket';
import { pack, sink, type PackItem } from './pack';
import type { Pt } from './hull2d';

/** Bambu Lab H3C build plate (mm). */
export const BED = { x: 330, y: 320 };

export interface TrayOptions {
  length: number; // X, mm (already reduced by any gap to the case wall)
  width: number; // Y, mm
  /** Total tray depth; null = deepest pocket + floor (per tray). */
  depth: number | null;
  /** Deepest a tray may be (e.g. the case's inside height); null = no limit. */
  maxDepth: number | null;
  floor: number; // minimum material under the deepest pocket
  wall: number; // minimum between pockets
  edge: number; // minimum between a pocket and the tray edge
  cornerRadius: number;
  /** Finger cutout: a round hole on the pocket edge, as deep as the pocket. */
  fingerDiameter: number;
  /** Extra depth below the pocket floor (mm), to get a fingertip under the part. */
  fingerExtraDepth: number;
  /** Swept: a smooth bowl that curves up to the surface, instead of a straight-sided hole. */
  fingerSwept: boolean;
  pocket: PocketOptions;
  /** Stack shallow parts on top of each other when everything will not fit in one tray. */
  stacking: boolean;
  /** Packing effort (orderings tried) and time limit. */
  packAttempts?: number;
  /** Step for spinning parts about Z when packing (degrees; default 15). */
  packAngleStep?: number;
  packTimeMs?: number;
}

export const DEFAULT_TRAY: TrayOptions = {
  length: 300, width: 200, depth: null, maxDepth: null, floor: 2, wall: 3, edge: 4, cornerRadius: 4,
  fingerDiameter: 20, fingerExtraDepth: 0, fingerSwept: true, stacking: true, pocket: DEFAULT_POCKET,
};

/** One way a part may lie in the tray. */
export interface TrayPose { poseIndex: number; mesh: TriMesh; silhouette: Silhouette; height: number }
/**
 * Drop poses that would pack identically. Two poses are the same only if they
 * have the same height and the same outline; a mirror-image outline is kept,
 * because a mirrored part nests differently against its neighbours.
 */
export function distinctPoses<T extends TrayPose>(poses: T[]): T[] {
  const signature = (p: T) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, a = 0, cx = 0, cy = 0;
    for (const loop of p.silhouette)
      for (let i = 0; i < loop.length; i++) {
        const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
        if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
        if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
        const w = x1 * y2 - x2 * y1;
        a += w; cx += (x1 + x2) * w; cy += (y1 + y2) * w;
      }
    cx = cx / (3 * a) - (minX + maxX) / 2; cy = cy / (3 * a) - (minY + maxY) / 2; // centroid relative to the box centre
    // Turning the part half a turn on the tray flips both offsets, so compare
    // their sizes and whether they have the same sign (which a mirror image flips).
    const hand = Math.abs(cx) > 0.3 && Math.abs(cy) > 0.3 ? Math.sign(cx * cy) : 0;
    return [p.height, maxX - minX, maxY - minY, Math.sqrt(Math.abs(a / 2)), Math.abs(cx), Math.abs(cy)].map((v) => Math.round(v * 2)).join(',') + ',' + hand;
  };
  const seen = new Set<string>();
  return poses.filter((p) => { const k = signature(p); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Side of the pocket (as the posed part is drawn: long side along X) a finger cutout sits on. */
export type Side = 'top' | 'bottom' | 'left' | 'right';
export const SIDES: Side[] = ['top', 'bottom', 'left', 'right'];

export interface TrayPart {
  partId: number;
  name: string;
  /** Allowed poses, preferred first. One entry = pose is fixed. */
  poses: TrayPose[];
  /** Finger cutouts: explicit sides, or 'auto' to decide per pose. */
  fingers: Side[] | 'auto';
  /** False = never put this part in a stack. Default true. */
  stackable?: boolean;
}

/**
 * Default finger cutouts for a pose. Thin parts (under 10 mm) get one hole —
 * a fingertip at the edge levers them out. Anything taller gets a pair on
 * opposite long sides so it can be pinched and lifted straight up.
 */
export function autoFingers(height: number): Side[] {
  return height < 10 ? ['top'] : ['top', 'bottom'];
}

export interface Placement {
  partId: number;
  poseIndex: number;
  /** The posed part is rotated by `angle` degrees about Z, then moved to (x, y, z). */
  angle: number; x: number; y: number; z: number;
  pocketDepth: number;
  formFit: boolean;
  fingers: Side[];
  /** Position in a stack: 0 = top (or not stacked); 1 = directly under the top part, … */
  level: number;
  /** Number of parts in this part's stack (1 = not stacked). */
  stackSize: number;
  /** Parts that lie (partly) on top of this one; empty when nothing is above it. */
  under: number[];
}
export interface Tray { mesh: TriMesh; depth: number; placements: Placement[]; volume: number }
export interface TrayResult { trays: Tray[]; /** Number of stacks that were formed. */ stacks: number }

/** User-facing problem with the request (shown as a message, not a crash). */
export class TrayError extends Error {}

const RASTER_SLACK = 0.75; // mm; covers the 1 mm packing grid
const POLYGON_SLACK = 0.2; // mm; rounded offsets are polygons slightly inside the true curve

function toTriMesh(m: Manifold, name: string): TriMesh {
  const mesh = m.getMesh();
  const v = mesh.vertProperties, t = mesh.triVerts, np = mesh.numProp;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = v[t[i] * np + c];
  return { name, positions: out };
}

/**
 * Centre of the finger scoop on one side of the pocket: where the line through
 * the middle of the outline meets the pocket edge on that side.
 */
export function fingerCentre(silhouette: Silhouette, clearance: number, side: Side = 'top'): Pt {
  const horizontal = side === 'left' || side === 'right'; // scan along X at mid-height
  const u = horizontal ? 1 : 0, v = horizontal ? 0 : 1; // u: fixed coordinate, v: searched coordinate
  let lo = Infinity, hi = -Infinity;
  for (const l of silhouette) for (const p of l) { if (p[u] < lo) lo = p[u]; if (p[u] > hi) hi = p[u]; }
  const mid = (lo + hi) / 2;
  const far = side === 'top' || side === 'right';
  let best = far ? -Infinity : Infinity;
  for (const l of silhouette)
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      if ((a[u] <= mid && b[u] >= mid) || (b[u] <= mid && a[u] >= mid)) {
        const w = a[u] === b[u] ? (far ? Math.max(a[v], b[v]) : Math.min(a[v], b[v])) : a[v] + ((mid - a[u]) / (b[u] - a[u])) * (b[v] - a[v]);
        best = far ? Math.max(best, w) : Math.min(best, w);
      }
    }
  const edge = best + (far ? clearance : -clearance);
  return horizontal ? [edge, mid] : [mid, edge];
}

/**
 * Build trays.
 *
 * 1. The deepest part sets the pocket depth D of the tray (each part in the
 *    lowest pose that fits the tray at all). Parts whose pose is not locked
 *    may be turned into any of their 90° orientations that need no more
 *    than D.
 * 2. Pack everything side by side. If it fits in one tray, done.
 * 3. Otherwise stack, always within D. First try tucking the parts that did
 *    not fit partly or wholly under the ones that did (each goes just below
 *    the floors of the pockets above it). Then search over which parts go
 *    underneath. If that fails, stack whole parts on
 *    top of each other, one pair at a time, best space saving first, stopping
 *    as soon as everything fits in one tray.
 * 4. If it still does not fit, fix each of the biggest parts in each of its
 *    poses in turn and lay everything out again.
 * 5. If it still does not fit, try again a little deeper, so parts (including
 *    the deepest) can use their next orientations: up to the case height if
 *    given, otherwise at most half as deep again. Failing that, the parts
 *    overflow into more trays.
 */
export function buildTrays(k: ManifoldToplevel, parts: TrayPart[], o: TrayOptions, onProgress?: (fraction: number, label: string) => void): TrayResult {
  const first = buildOnce(k, parts, o, null, onProgress);
  if (first.trayDepths.length <= 1) return cutPlan(k, o, first, onProgress);
  let best = first;
  const better = (p: Plan) => p.trayDepths.length < best.trayDepths.length;

  // More than one tray. The layout above let every unlocked part take whichever
  // pose looked best step by step, which can miss a fit that depends on one
  // big part lying a particular way. So do what a person would: take the
  // biggest parts in turn, fix each in every one of its poses, and lay
  // everything out again (stacking included). Stop at the first single tray.
  const cap = o.depth !== null ? o.depth - o.floor : o.maxDepth !== null ? o.maxDepth - o.floor : first.depth * 1.5;
  const area = (p: TrayPart) => { let a = 0; for (const l of p.poses[0].silhouette) for (let i = 0; i < l.length; i++) { const [x1, y1] = l[i], [x2, y2] = l[(i + 1) % l.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); };
  const pocket = (pose: TrayPose) => pose.height + o.pocket.floorClearance + o.pocket.topMargin;
  const big = parts.filter((p) => p.poses.length > 1).sort((p, q) => area(q) - area(p)).slice(0, 2);
  // Shallowest pose first (so the tray stays as thin as it can), then the narrowest footprint.
  const narrow = (pose: TrayPose) => { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const l of pose.silhouette) for (const [x, y] of l) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return Math.round(Math.min(maxX - minX, maxY - minY)); };
  const deadline = Date.now() + 15000; // keep the extra searching bounded on slow devices
  let tries = 0;
  search: for (const part of big)
    for (const pose of [...part.poses].sort((p, q) => Math.round(p.height) - Math.round(q.height) || narrow(p) - narrow(q))) {
      if (pocket(pose) > cap + 1e-9 || tries >= 8 || Date.now() > deadline) continue;
      tries++;
      onProgress?.(0.05, `Trying ${part.name} another way up`);
      const fixed = parts.map((p) => (p === part ? { ...p, poses: [pose] } : p));
      // If this pose is deeper than the depth so far, it sets the depth for this try.
      const depth = o.depth !== null ? null : Math.max(first.depth, pocket(pose) + (part.fingers === 'auto' || part.fingers.length ? Math.max(0, o.fingerExtraDepth) : 0));
      let next: Plan;
      try { next = buildOnce(k, fixed, o, depth, onProgress, false, true); } catch (e) { if (e instanceof TrayError) continue; throw e; }
      if (better(next)) best = next;
      if (best.trayDepths.length === 1) break search;
    }
  if (best.trayDepths.length <= 1 || o.depth !== null) return cutPlan(k, o, best, onProgress);

  // Still more than one tray: step the depth up through the next deeper
  // orientations of any part — up to the case height if one is given,
  // otherwise at most half as deep again.
  const steps: number[] = [];
  for (const d of first.deeper) if (d <= cap + 1e-9 && (!steps.length || d - steps[steps.length - 1] > 1)) steps.push(d);
  const tries2: [number, boolean][] = steps.slice(0, 3).map((d) => [d, true]);
  if (o.maxDepth !== null && (!tries2.length || cap - tries2[tries2.length - 1][0] > 1)) tries2.push([cap, false]);
  for (const [d, force] of tries2) {
    if (Date.now() > deadline) break;
    const next = buildOnce(k, parts, o, d, onProgress, force, true);
    if (better(next)) best = next;
    if (best.trayDepths.length === 1) break;
  }
  return cutPlan(k, o, best, onProgress);
}

/** One pocket to cut: a part in a pose, turned and positioned, possibly sunk below the surface. */
interface Entry { tray: number; part: TrayPart; pose: TrayPose; angle: number; tx: number; ty: number; offset: number; level: number; stackSize: number; under: number[] }
/** A finished arrangement, before any geometry is cut. */
interface Plan { entries: Entry[]; trayDepths: number[]; stacks: number; depth: number; deeper: number[]; inset: number }

/** Decide poses, positions and stacking for one maximum pocket depth (see buildTrays). */
function buildOnce(k: ManifoldToplevel, parts: TrayPart[], o: TrayOptions, depthCap: number | null, onProgress?: (fraction: number, label: string) => void, forceStep = false, brisk = false): Plan {
  if (!parts.length) throw new TrayError('Add at least one part first.');
  const fitsBed = (o.length <= BED.x && o.width <= BED.y) || (o.length <= BED.y && o.width <= BED.x);
  if (!fitsBed) throw new TrayError(`A ${o.length.toFixed(1)} × ${o.width.toFixed(1)} mm tray does not fit the ${BED.x} × ${BED.y} mm print bed.`);
  if (o.length < 20 || o.width < 20) throw new TrayError('Tray is too small.');

  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  type CS = ReturnType<typeof k.CrossSection.circle>;
  try {
    const sidesFor = (part: TrayPart, pose: TrayPose) => (part.fingers === 'auto' ? autoFingers(pose.height) : part.fingers);
    const pocketDepth = (pose: TrayPose) => pose.height + o.pocket.floorClearance + o.pocket.topMargin;
    const extra = Math.max(0, o.fingerExtraDepth);
    /** Depth a part needs below the tray surface: its pocket, or its finger holes if they go deeper. */
    const neededDepth = (part: TrayPart, pose: TrayPose) => pocketDepth(pose) + (sidesFor(part, pose).length ? extra : 0);
    const fingerR = o.fingerDiameter / 2;
    const scoops = (part: TrayPart, pose: TrayPose): CS | null => {
      let all: CS | null = null;
      for (const side of sidesFor(part, pose)) {
        const [fx, fy] = fingerCentre(pose.silhouette, o.pocket.clearance, side);
        const c = keep(keep(k.CrossSection.circle(fingerR, 32)).translate(fx, fy));
        all = all ? keep(all.add(c)) : c;
      }
      return all;
    };
    /** Pocket opening plus finger holes: everything the part takes from the tray surface. */
    const shapeOf = (part: TrayPart, pose: TrayPose): CS => {
      const open = keep(keep(k.CrossSection.ofPolygons(pose.silhouette, 'Positive')).offset(o.pocket.clearance, 'Round', 2, 16));
      const holes = scoops(part, pose);
      return holes ? keep(open.add(holes)) : open;
    };
    const grown = (shape: CS) => keep(keep(shape.offset(o.wall / 2 + RASTER_SLACK + POLYGON_SLACK, 'Round', 2, 12)).simplify(0.1)).toPolygons() as Pt[][];

    // Footprints already carry half a wall, so the usable region is the tray
    // shrunk by (edge − wall/2) on every side.
    const inset = Math.max(0, o.edge - o.wall / 2 - RASTER_SLACK);
    const region = { width: o.length - 2 * inset, height: o.width - 2 * inset };
    const packWith = (items: PackItem[], quick: boolean) =>
      pack(items, { ...region, attempts: quick ? 16 : brisk ? 40 : o.packAttempts ?? 96, timeBudgetMs: quick ? 400 : brisk ? 900 : o.packTimeMs ?? 2500, trayOverhead: o.floor, angleStep: o.packAngleStep, fixedDepth: o.depth !== null });

    // ---- 1. Allowed poses and the depth the deepest part sets ----
    onProgress?.(0.03, 'Measuring parts');
    const limit = Math.min(o.depth ?? Infinity, o.maxDepth ?? Infinity);
    interface Choice { pose: TrayPose; depth: number; shape: CS; footprint: Pt[][]; area: number }
    interface Layer { part: TrayPart; choice: Choice; rot: number }
    interface Unit { id: number; choices: Choice[]; part: TrayPart | null; stack: Layer[] | null; footprint: Pt[][] | null; depth: number; shape: CS }
    const tooDeep: string[] = [], tooBig: string[] = [];
    const units: Unit[] = [];
    for (const part of parts) {
      const within = part.poses.filter((pose) => neededDepth(part, pose) <= limit - o.floor + 1e-9);
      if (!within.length) { tooDeep.push(part.name); continue; }
      const choices = within
        .map((pose) => { const shape = shapeOf(part, pose); return { pose, depth: neededDepth(part, pose), shape, footprint: grown(shape), area: shape.area() }; })
        // ...that can go in an empty tray at all, at some angle.
        .filter((c) => !packWith([{ id: 0, options: [{ key: 0, depth: c.depth, footprint: c.footprint }] }], true).unplaced.length)
        .sort((a, b) => a.depth - b.depth);
      if (!choices.length) { tooBig.push(part.name); continue; }
      units.push({ id: part.partId, choices, part, stack: null, footprint: null, depth: choices[0].depth, shape: choices[0].shape });
    }
    if (tooDeep.length)
      throw new TrayError(`${limit.toFixed(1)} mm is too shallow for: ${tooDeep.join(', ')}. Increase the tray depth or case height, or leave them empty.`);
    if (tooBig.length)
      throw new TrayError(`Too big for a ${o.length.toFixed(1)} × ${o.width.toFixed(1)} mm tray in any allowed pose: ${tooBig.join(', ')}.`);
    // The deepest part (lying as low as it can) sets the depth; nothing may go deeper.
    const D = depthCap ?? (o.depth !== null ? o.depth - o.floor : Math.max(...units.map((u) => u.depth)));
    // Depths that other orientations would need, for the caller to try if this does not fit.
    const deeper = [...new Set(units.flatMap((u) => u.choices.map((c) => c.depth)).filter((d) => d > D + 1e-9))].sort((x, y) => x - y);
    for (const u of units) u.choices = u.choices.filter((c) => c.depth <= D + 1e-9);
    // When trying a deeper step, the orientation that needs exactly this depth is
    // the reason for the step, so commit the part to it. (The packer on its own
    // tends to keep the lower orientation and miss the fit.)
    if (forceStep)
      for (const u of units) {
        const exact = u.choices.filter((c) => Math.abs(c.depth - D) < 1);
        if (exact.length && exact.length < u.choices.length) { u.choices = exact; u.depth = exact[0].depth; u.shape = exact[0].shape; }
      }

    const items = (): PackItem[] => units.map((u) => ({
      id: u.id,
      options: u.stack ? [{ key: 0, depth: u.depth, footprint: u.footprint! }] : u.choices.map((c) => ({ key: c.pose.poseIndex, depth: c.depth, footprint: c.footprint })),
    }));

    // ---- 2. Side by side ----
    onProgress?.(0.1, 'Arranging parts');
    let packed = packWith(items(), false);

    // ---- 3. Stack until it fits ----
    const layersOf = (u: Unit): Layer[] => u.stack ?? [{ part: u.part!, choice: u.choices[0], rot: 0 }];
    const entriesOf = (result: typeof packed): Entry[] => {
      const out: Entry[] = [];
      for (const pl of result.placements) {
        const unit = units.find((u) => u.id === pl.id)!;
        const layers: Layer[] = unit.stack ?? [{ part: unit.part!, choice: unit.choices.find((c) => c.pose.poseIndex === pl.key)!, rot: 0 }];
        let offset = 0;
        layers.forEach((l, level) => {
          out.push({ tray: pl.tray, part: l.part, pose: l.choice.pose, angle: pl.angle + l.rot, tx: pl.tx, ty: pl.ty, offset, level, stackSize: layers.length, under: layers.slice(0, level).map((x) => x.part.partId) });
          offset += pocketDepth(l.choice.pose);
        });
      }
      return out;
    };
    let trayDepths = packed.trays.map((t) => t.depth);
    let entries: Entry[] | null = null;
    let stacks = 0;

    if (o.stacking && packed.trays.length > 1) {
      onProgress?.(0.12, 'Stacking parts to fit');
      const unitOf = (id: number) => units.find((u) => u.id === id)!;
      /** Given a one-tray layout of surface parts, tuck the `lower` parts beneath/between them. */
      const sinkInto = (surface: typeof packed, lower: Unit[]): boolean => {
        const sunk = sink(
          surface.placements.map((p) => {
            const u = unitOf(p.id), c = u.choices.find((x) => x.pose.poseIndex === p.key)!;
            return { id: p.id, depth: c.depth, footprint: c.footprint, angle: p.angle, tx: p.tx, ty: p.ty, noCover: u.part!.stackable === false };
          }),
          lower.map((u) => ({ id: u.id, depth: u.choices[0].depth, footprint: u.choices[0].footprint })),
          { ...region, maxDepth: D },
        );
        if (!sunk) return false;
        const list = entriesOf(surface);
        for (const sp of sunk) {
          const u = unitOf(sp.id);
          list.push({ tray: 0, part: u.part!, pose: u.choices[0].pose, angle: sp.angle, tx: sp.tx, ty: sp.ty, offset: sp.offset, level: sp.under.length ? 1 : 0, stackSize: sp.under.length ? 2 : 1, under: sp.under });
        }
        for (const e of list) if (list.some((x) => x.under.includes(e.part.partId))) e.stackSize = 2;
        entries = list;
        trayDepths = [Math.max(surface.trays[0].depth, ...sunk.map((sp) => sp.offset + unitOf(sp.id).choices[0].depth))];
        stacks = sunk.filter((sp) => sp.under.length).length;
        return true;
      };

      // 3a. Keep the first tray as laid out and tuck every part that did not fit.
      const first = packed.placements.filter((p) => p.tray === 0), rest = packed.placements.filter((p) => p.tray > 0);
      let found = rest.every((p) => unitOf(p.id).part!.stackable !== false)
        && sinkInto({ ...packed, placements: first, trays: [packed.trays[0]] }, rest.map((p) => unitOf(p.id)));

      // 3b. Otherwise search over *which* parts go underneath: move parts off
      //     the surface (largest first) until the rest fit one tray, then try
      //     to tuck the moved ones under them. Backtracks within a time budget.
      if (!found) {
        const regionArea = region.width * region.height;
        // A part is worth putting underneath only if the parts shallow enough to sit
        // over it could actually hide most of it (each may give up half its floor).
        const cover = (l: Unit, over: Unit[]) => {
          const a = l.shape.area();
          let hidden = 0;
          for (const v of over) if (v !== l && v.depth + l.depth <= D + 1e-9) hidden += v.shape.area() >= a ? a : 0.5 * v.shape.area();
          return Math.min(1, hidden / a);
        };
        const sinkable = units
          .filter((u) => u.part!.stackable !== false && cover(u, units) >= 0.6)
          .sort((p, q) => q.shape.area() - p.shape.area());
        const deadline = Date.now() + (brisk ? 800 : 1500);
        const tried = new Set<string>();
        const search = (lower: Unit[], from: number): boolean => {
          for (let i = from; i < sinkable.length; i++) {
            if (Date.now() > deadline) return false;
            const next = [...lower, sinkable[i]];
            const surfaceUnits = units.filter((u) => !next.includes(u));
            // The remaining lower parts need shallow enough cover among what stays on the surface.
            if (!next.every((l) => cover(l, surfaceUnits) >= 0.4)) continue;
            const key = next.map((u) => u.id).sort((x, y) => x - y).join(',');
            if (tried.has(key)) continue;
            tried.add(key);
            if (surfaceUnits.reduce((sum, u) => sum + u.shape.area(), 0) <= regionArea) {
              const surface = packWith(surfaceUnits.map((u) => ({ id: u.id, options: u.choices.map((c) => ({ key: c.pose.poseIndex, depth: c.depth, footprint: c.footprint })) })), true);
              if (!surface.unplaced.length && surface.trays.length === 1) {
                if (sinkInto(surface, next)) return true;
                continue; // the surface fits; taking more off it will not help these go under
              }
            }
            if (next.length < 5 && search(next, i + 1)) return true;
          }
          return false;
        };
        // No point searching if even the parts that can never go underneath overflow one tray.
        const mustStay = units.filter((u) => !sinkable.includes(u));
        const possible = sinkable.length > 0
          && packWith(mustStay.map((u) => ({ id: u.id, options: u.choices.map((c) => ({ key: c.pose.poseIndex, depth: c.depth, footprint: c.footprint })) })), true).trays.length <= 1;
        found = possible && search([], 0);
      }
    }

    if (!entries && o.stacking && packed.trays.length > 1) {
      // 3c. Whole stacks: merge pairs of parts into one footprint.
      const flat = { packed, units: units.map((u) => ({ ...u })) };
      const regionArea = region.width * region.height;
      const canStack = (u: Unit) => layersOf(u).every((l) => l.part.stackable !== false);
      const turned = (l: Layer, rot: number) => (rot ? keep(l.choice.shape.rotate(rot)) : l.choice.shape);
      /** Stack two units: biggest footprint on top; each layer squared up to hide under it as well as it can. */
      const merge = (a: Unit, b: Unit) => {
        const layers = [...layersOf(a), ...layersOf(b)].map((l) => ({ ...l })).sort((p, q) => q.choice.area - p.choice.area);
        let shape = turned(layers[0], 0);
        layers[0].rot = 0;
        for (const l of layers.slice(1)) {
          const s0 = keep(shape.add(turned(l, 0))), s90 = keep(shape.add(turned(l, 90)));
          l.rot = s90.area() < s0.area() - 1e-6 ? 90 : 0;
          shape = l.rot ? s90 : s0;
        }
        const pockets = layers.reduce((sum, l) => sum + pocketDepth(l.choice.pose), 0);
        const depth = pockets + (layers.some((l) => sidesFor(l.part, l.choice.pose).length) ? extra : 0);
        return { layers, shape, depth, saving: a.shape.area() + b.shape.area() - shape.area() };
      };
      for (let round = 0; round < parts.length && packed.trays.length > 1; round++) {
        onProgress?.(0.12 + 0.03 * Math.min(1, round / 4), 'Stacking parts to fit');
        let best: { i: number; j: number; m: ReturnType<typeof merge> } | null = null;
        for (let i = 0; i < units.length; i++)
          for (let j = i + 1; j < units.length; j++) {
            if (!canStack(units[i]) || !canStack(units[j])) continue;
            if (units[i].depth + units[j].depth > D + extra + 1e-9) continue;
            const m = merge(units[i], units[j]);
            if (m.depth <= D + 1e-9 && m.saving > 1 && (!best || m.saving > best.m.saving)) best = { i, j, m };
          }
        if (!best) break;
        const merged: Unit = { id: units[best.i].id, choices: [], part: null, stack: best.m.layers, footprint: grown(best.m.shape), depth: best.m.depth, shape: best.m.shape };
        units.splice(best.j, 1);
        units[best.i] = merged;
        stacks = units.filter((u) => u.stack).length;
        // Only worth packing once the footprints could plausibly fit one tray.
        if (units.reduce((a, u) => a + u.shape.area(), 0) > regionArea) continue;
        packed = packWith(items(), true);
      }
      packed = packWith(items(), false);
      // If stacking did not reduce the number of trays, keep the simpler unstacked layout.
      if (packed.unplaced.length || packed.trays.length >= flat.packed.trays.length) {
        units.splice(0, units.length, ...flat.units);
        packed = flat.packed;
        stacks = 0;
      }
      trayDepths = packed.trays.map((t) => t.depth);
    }
    if (packed.unplaced.length) {
      const names = packed.unplaced.map((id) => parts.find((p) => p.partId === id)?.name ?? '?');
      throw new TrayError(`Too big for a ${o.length.toFixed(1)} × ${o.width.toFixed(1)} mm tray in any allowed pose: ${names.join(', ')}.`);
    }
    entries ??= entriesOf(packed);

    return { entries, trayDepths, stacks, depth: D, deeper, inset };
  } finally {
    for (const t of trash) t.delete();
  }
}

/** Cut the pockets of a finished plan into tray solids. */
function cutPlan(k: ManifoldToplevel, o: TrayOptions, plan: Plan, onProgress?: (fraction: number, label: string) => void): TrayResult {
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  try {
    const sidesFor = (part: TrayPart, pose: TrayPose) => (part.fingers === 'auto' ? autoFingers(pose.height) : part.fingers);
    const extra = Math.max(0, o.fingerExtraDepth);
    const fingerR = o.fingerDiameter / 2;
    const { inset } = plan;
    const scoops = (part: TrayPart, pose: TrayPose) => {
      let all: ReturnType<typeof k.CrossSection.circle> | null = null;
      for (const side of sidesFor(part, pose)) {
        const [fx, fy] = fingerCentre(pose.silhouette, o.pocket.clearance, side);
        const c = keep(keep(k.CrossSection.circle(fingerR, 32)).translate(fx, fy));
        all = all ? keep(all.add(c)) : c;
      }
      return all;
    };
    // ---- 4. Cut each tray ----
    const r = Math.max(0, Math.min(o.cornerRadius, o.length / 2 - 1, o.width / 2 - 1));
    const core = keep(k.CrossSection.square([o.length - 2 * r, o.width - 2 * r], true));
    const outline = r > 0 ? keep(core.offset(r, 'Round', 2, 32)) : core;
    const trays: Tray[] = [];
    let done = 0;
    for (let t = 0; t < plan.trayDepths.length; t++) {
      const depth = o.depth ?? plan.trayDepths[t] + o.floor;
      const placements: Placement[] = [];
      const cuts: Manifold[] = [];
      for (const e of plan.entries.filter((x) => x.tray === t)) {
        const { part, pose } = e;
        onProgress?.(0.15 + (0.75 * done++) / plan.entries.length, `Cutting pocket: ${part.name}`);
        const c = buildCavity(k, pose.mesh, pose.silhouette, pose.height, o.pocket);
        // Part coordinates -> the tray surface at z = 0, pocket top `offset` below it.
        let piece = keep(keep(c.solid).translate(0, 0, -e.offset - c.top));
        if (e.offset > 0) {
          // Open shaft above a sunk pocket so its part can be lifted out.
          piece = keep(piece.add(keep(keep(keep(k.CrossSection.ofPolygons(c.opening, 'Positive')).extrude(e.offset + 1)).translate(0, 0, -e.offset))));
        }
        const sides = sidesFor(part, pose);
        if (sides.length) {
          // Finger holes run from the tray surface to this pocket's floor (plus any extra).
          const d = e.offset + c.depth + extra;
          if (o.fingerSwept) {
            for (const side of sides) {
              const [fx, fy] = fingerCentre(pose.silhouette, o.pocket.clearance, side);
              piece = keep(piece.add(keep(keep(keep(k.Manifold.sphere(1, 28)).scale([fingerR, fingerR, d])).translate(fx, fy, 0))));
            }
          } else {
            piece = keep(piece.add(keep(keep(scoops(part, pose)!.extrude(d + 1)).translate(0, 0, -d))));
          }
        }
        const x = e.tx - o.length / 2 + inset, y = e.ty - o.width / 2 + inset;
        cuts.push(keep(keep(piece.rotate([0, 0, e.angle])).translate(x, y, depth)));
        placements.push({
          partId: part.partId, poseIndex: pose.poseIndex, fingers: sides, angle: e.angle, x, y, z: depth - e.offset - c.top,
          pocketDepth: c.depth, formFit: c.formFit, level: e.level, stackSize: e.stackSize, under: e.under,
        });
      }
      onProgress?.(0.92, `Building tray ${t + 1}`);
      const block = keep(outline.extrude(depth));
      const allCuts = cuts.length === 1 ? cuts[0] : keep(k.Manifold.union(cuts));
      const tray = keep(block.subtract(allCuts));
      if (tray.isEmpty()) throw new Error('Tray geometry came out empty');
      trays.push({ mesh: toTriMesh(tray, `tray-${t + 1}`), depth, placements, volume: tray.volume() });
    }
    return { trays, stacks: plan.stacks };
  } finally {
    for (const t of trash) t.delete();
  }
}
