import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import type { Silhouette } from './analyze';
import { buildCavity, type PocketOptions, DEFAULT_POCKET } from './pocket';
import { pack, type PackItem } from './pack';
import { anneal } from './anneal';
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
  edge: number; // minimum tray material between any cut (pocket or finger hole) and the tray edge
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
  /** Effort of the whole-layout search: moves per round, and rounds. */
  searchIterations?: number;
  searchRounds?: number;
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

/** Finger holes of neighbouring parts closer than this (edge to edge, mm) are joined into one slot. */
const FINGER_MERGE_GAP = 2;
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
 * 1. The deepest part, lying as low as it can, sets the pocket depth D. Parts
 *    whose pose is not locked may take any 90° orientation needing no more.
 * 2. A quick side-by-side packing. If everything fits one tray, done.
 * 3. Otherwise a whole-layout search (see anneal.ts) looks for a one-tray
 *    layout, choosing every part's pose, angle, position and — when stacking
 *    is on — whether it is sunk beneath others, all within D.
 * 4. If there is still no one-tray layout and the depth is not fixed, the
 *    depth is stepped up through the next deeper orientations (to the case
 *    height if given, otherwise at most half as deep again).
 * 5. Failing that, the side-by-side packing over several trays is used.
 */
export function buildTrays(k: ManifoldToplevel, parts: TrayPart[], o: TrayOptions, onProgress?: (fraction: number, label: string) => void): TrayResult {
  const first = buildOnce(k, parts, o, null, onProgress);
  if (first.trayDepths.length <= 1 || o.depth !== null) return cutPlan(k, o, first, onProgress);

  // More than one tray at the depth the deepest part needs. Step the depth up
  // through the next deeper orientations of any part — to the case height if
  // one is given, otherwise at most half as deep again — and keep the first
  // (shallowest) depth that needs the fewest trays.
  const cap = o.maxDepth !== null ? o.maxDepth - o.floor : first.depth * 1.5;
  const steps: number[] = [];
  for (const d of first.deeper) if (d <= cap + 1e-9 && (!steps.length || d - steps[steps.length - 1] > 1)) steps.push(d);
  const tries = steps.slice(0, 3);
  if (o.maxDepth !== null && (!tries.length || cap - tries[tries.length - 1] > 1)) tries.push(cap);
  let best = first;
  for (const d of tries) {
    onProgress?.(0.05, 'Trying a slightly deeper tray');
    const next = buildOnce(k, parts, o, d, onProgress);
    if (next.trayDepths.length < best.trayDepths.length) best = next;
    if (best.trayDepths.length === 1) break;
  }
  return cutPlan(k, o, best, onProgress);
}

/** One pocket to cut: a part in a pose, turned and positioned, possibly sunk below the surface. */
interface Entry { tray: number; part: TrayPart; pose: TrayPose; angle: number; tx: number; ty: number; offset: number; level: number; stackSize: number; under: number[] }
/** A finished arrangement, before any geometry is cut. */
interface Plan { entries: Entry[]; trayDepths: number[]; stacks: number; depth: number; deeper: number[]; inset: number }

/** Decide poses, positions and stacking for one maximum pocket depth (see buildTrays). */
function buildOnce(k: ManifoldToplevel, parts: TrayPart[], o: TrayOptions, depthCap: number | null, onProgress?: (fraction: number, label: string) => void): Plan {
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
    /** The pocket opening: the part of the footprint that needs a wall around it. */
    const openingOf = (pose: TrayPose): CS => keep(keep(k.CrossSection.ofPolygons(pose.silhouette, 'Positive')).offset(o.pocket.clearance, 'Round', 2, 16));
    const grown = (shape: CS) => keep(keep(shape.offset(o.wall / 2 + RASTER_SLACK + POLYGON_SLACK, 'Round', 2, 12)).simplify(0.1)).toPolygons() as Pt[][];

    // Footprints already carry half a wall, so the usable region is the tray
    // shrunk by (edge − wall/2) on every side.
    const inset = Math.max(0, o.edge - o.wall / 2 - RASTER_SLACK);
    const region = { width: o.length - 2 * inset, height: o.width - 2 * inset };
    // Finger holes are not grown, so they keep the whole edge margin themselves:
    // no cut may come closer than `edge` to the outside of the tray.
    const softMargin = Math.ceil(o.edge - inset - 1e-9);
    const packWith = (items: PackItem[], quick: boolean) =>
      pack(items, { ...region, attempts: quick ? 16 : o.packAttempts ?? 96, timeBudgetMs: quick ? 400 : o.packTimeMs ?? 2500, trayOverhead: o.floor, angleStep: o.packAngleStep, fixedDepth: o.depth !== null, softMargin });

    // ---- 1. Allowed poses and the depth the deepest part sets ----
    onProgress?.(0.03, 'Measuring parts');
    const limit = Math.min(o.depth ?? Infinity, o.maxDepth ?? Infinity);
    interface Choice { pose: TrayPose; depth: number; footprint: Pt[][]; soft: Pt[][] | undefined }
    interface Unit { id: number; choices: Choice[]; part: TrayPart; depth: number }
    const tooDeep: string[] = [], tooBig: string[] = [];
    const units: Unit[] = [];
    for (const part of parts) {
      const within = part.poses.filter((pose) => neededDepth(part, pose) <= limit - o.floor + 1e-9);
      if (!within.length) { tooDeep.push(part.name); continue; }
      const choices = within
        .map((pose) => { const holes = scoops(part, pose); return { pose, depth: neededDepth(part, pose), footprint: grown(openingOf(pose)), soft: holes ? (holes.toPolygons() as Pt[][]) : undefined }; })
        // ...that can go in an empty tray at all, at some angle.
        .filter((c) => !packWith([{ id: 0, options: [{ key: 0, depth: c.depth, footprint: c.footprint, soft: c.soft }] }], true).unplaced.length)
        .sort((a, b) => a.depth - b.depth);
      if (!choices.length) { tooBig.push(part.name); continue; }
      units.push({ id: part.partId, choices, part, depth: choices[0].depth });
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
    const options = (u: Unit) => u.choices.map((c) => ({ key: c.pose.poseIndex, depth: c.depth, footprint: c.footprint, soft: c.soft }));

    // ---- 2. Side by side, quickly ----
    onProgress?.(0.1, 'Arranging parts');
    const packed = packWith(units.map((u) => ({ id: u.id, options: options(u) })), false);
    if (packed.unplaced.length) {
      const names = packed.unplaced.map((id) => parts.find((p) => p.partId === id)?.name ?? '?');
      throw new TrayError(`Too big for a ${o.length.toFixed(1)} × ${o.width.toFixed(1)} mm tray in any allowed pose: ${names.join(', ')}.`);
    }
    const unitOf = (id: number) => units.find((u) => u.id === id)!;
    const choiceOf = (id: number, key: number) => unitOf(id).choices.find((c) => c.pose.poseIndex === key)!;
    let entries: Entry[] = packed.placements.map((pl) => ({
      tray: pl.tray, part: unitOf(pl.id).part, pose: choiceOf(pl.id, pl.key).pose, angle: pl.angle, tx: pl.tx, ty: pl.ty, offset: 0, level: 0, stackSize: 1, under: [],
    }));
    let trayDepths = packed.trays.map((t) => t.depth);
    let stacks = 0;

    // ---- 3. If that needs more than one tray: search whole layouts ----
    // Pose, angle, position and level (on the surface, or sunk under others) of
    // every part are searched together for a layout that fits one tray.
    if (packed.trays.length > 1) {
      onProgress?.(0.12, o.stacking ? 'Searching for a one-tray layout (stacking allowed)' : 'Searching for a one-tray layout');
      const start = new Map(packed.placements.filter((p) => p.tray === 0).map((p) => [p.id, p]));
      const found = anneal(
        units.map((u) => {
          const p = start.get(u.id);
          return { id: u.id, stackable: u.part.stackable !== false, options: options(u), start: p && { key: p.key, angle: p.angle, tx: p.tx, ty: p.ty } };
        }),
        { ...region, softMargin, maxDepth: D, allowSink: o.stacking, angleStep: o.packAngleStep, iterations: o.searchIterations, rounds: o.searchRounds },
      );
      if (found) {
        const above = new Set(found.flatMap((f) => f.under));
        entries = found.map((f) => ({
          tray: 0, part: unitOf(f.id).part, pose: choiceOf(f.id, f.key).pose, angle: f.angle, tx: f.tx, ty: f.ty,
          offset: f.offset, level: f.under.length ? 1 : 0, stackSize: f.under.length || above.has(f.id) ? 2 : 1, under: f.under,
        }));
        trayDepths = [Math.max(...found.map((f) => f.offset + f.depth))];
        stacks = found.filter((f) => f.under.length).length;
      }
    }

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
    const r = Math.max(0, Math.min(o.cornerRadius, o.length / 2 - 1, o.width / 2 - 1));
    const core = keep(k.CrossSection.square([o.length - 2 * r, o.width - 2 * r], true));
    const outline = r > 0 ? keep(core.offset(r, 'Round', 2, 32)) : core;
    const trays: Tray[] = [];
    let done = 0;
    for (let t = 0; t < plan.trayDepths.length; t++) {
      const depth = o.depth ?? plan.trayDepths[t] + o.floor;
      const placements: Placement[] = [];
      const cuts: Manifold[] = [];
      const holes: { x: number; y: number; d: number }[] = [];
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
        const x = e.tx - o.length / 2 + inset, y = e.ty - o.width / 2 + inset;
        cuts.push(keep(keep(piece.rotate([0, 0, e.angle])).translate(x, y, depth)));
        // Finger holes run from the tray surface to this pocket's floor (plus any
        // extra). They are collected for the whole tray so that holes which meet
        // can be cut as one slot.
        const rad = (e.angle * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        for (const side of sides) {
          const [fx, fy] = fingerCentre(pose.silhouette, o.pocket.clearance, side);
          holes.push({ x: x + fx * cos - fy * sin, y: y + fx * sin + fy * cos, d: e.offset + c.depth + extra });
        }
        placements.push({
          partId: part.partId, poseIndex: pose.poseIndex, fingers: sides, angle: e.angle, x, y, z: depth - e.offset - c.top,
          pocketDepth: c.depth, formFit: c.formFit, level: e.level, stackSize: e.stackSize, under: e.under,
        });
      }
      // Finger holes that overlap or nearly touch become one rounded slot spanning
      // the parts they serve (the convex hull of the individual holes).
      const group = holes.map((_, i) => i);
      const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
      for (let i = 0; i < holes.length; i++)
        for (let j = i + 1; j < holes.length; j++)
          if (Math.hypot(holes[i].x - holes[j].x, holes[i].y - holes[j].y) <= 2 * fingerR + FINGER_MERGE_GAP) group[find(i)] = find(j);
      const clusters = new Map<number, typeof holes>();
      holes.forEach((h, i) => { const g = find(i); clusters.set(g, [...(clusters.get(g) ?? []), h]); });
      for (const cluster of clusters.values()) {
        const pieces = cluster.map((h) => (o.fingerSwept
          ? keep(keep(keep(k.Manifold.sphere(1, 28)).scale([fingerR, fingerR, h.d])).translate(h.x, h.y, depth)) // bowl: full depth at the centre, curving up to the surface
          : keep(keep(keep(k.CrossSection.circle(fingerR, 32)).extrude(h.d + 1)).translate(h.x, h.y, depth - h.d))));
        cuts.push(pieces.length === 1 ? pieces[0] : keep(k.Manifold.hull(pieces)));
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
