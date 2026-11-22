import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import type { Silhouette } from './analyze';
import { buildCavity, type PocketOptions, DEFAULT_POCKET } from './pocket';
import { pack, type PackItem } from './pack';
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
  /** Finger cutout: a round scoop on the pocket edge. */
  fingerDiameter: number;
  fingerDepthFraction: number; // of the pocket depth
  pocket: PocketOptions;
  /** Packing effort (orderings tried) and time limit. */
  packAttempts?: number;
  packTimeMs?: number;
}

export const DEFAULT_TRAY: TrayOptions = {
  length: 300, width: 200, depth: null, maxDepth: null, floor: 2, wall: 3, edge: 4, cornerRadius: 4,
  fingerDiameter: 20, fingerDepthFraction: 0.6, pocket: DEFAULT_POCKET,
};

/** One way a part may lie in the tray. */
export interface TrayPose { poseIndex: number; mesh: TriMesh; silhouette: Silhouette; height: number }
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
}

/**
 * Default finger cutouts for a pose. Thin parts (under 10 mm) get one scoop —
 * a fingertip under the edge levers them out. Anything taller gets a pair on
 * opposite long sides so it can be pinched and lifted straight up.
 */
export function autoFingers(height: number): Side[] {
  return height < 10 ? ['top'] : ['top', 'bottom'];
}

/** How deep a scoop goes: 60 % of the pocket, but all the way down for shallow pockets. */
export function fingerDepth(pocketDepth: number, fraction: number): number {
  return pocketDepth <= 15 ? pocketDepth : Math.max(fraction * pocketDepth, 15);
}
export interface Placement {
  partId: number;
  poseIndex: number;
  /** The posed part is rotated by `angle` degrees about Z, then moved to (x, y, z). */
  angle: number; x: number; y: number; z: number;
  pocketDepth: number;
  formFit: boolean;
  fingers: Side[];
}
export interface Tray { mesh: TriMesh; depth: number; placements: Placement[]; volume: number }
export interface TrayResult { trays: Tray[] }

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

/** Build trays: choose poses and positions with the packer, then cut every pocket. */
export function buildTrays(k: ManifoldToplevel, parts: TrayPart[], o: TrayOptions, onProgress?: (fraction: number, label: string) => void): TrayResult {
  if (!parts.length) throw new TrayError('Add at least one part first.');
  const fitsBed = (o.length <= BED.x && o.width <= BED.y) || (o.length <= BED.y && o.width <= BED.x);
  if (!fitsBed) throw new TrayError(`A ${o.length.toFixed(1)} × ${o.width.toFixed(1)} mm tray does not fit the ${BED.x} × ${BED.y} mm print bed.`);
  if (o.length < 20 || o.width < 20) throw new TrayError('Tray is too small.');

  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  try {
    const pocketDepth = (pose: TrayPose) => pose.height + o.pocket.floorClearance + o.pocket.topMargin;
    const fingerR = o.fingerDiameter / 2;
    const sidesFor = (part: TrayPart, pose: TrayPose) => (part.fingers === 'auto' ? autoFingers(pose.height) : part.fingers);
    /** All finger scoops of a pose as one 2D shape, or null if it has none. */
    const scoops = (part: TrayPart, pose: TrayPose) => {
      let all: ReturnType<typeof k.CrossSection.circle> | null = null;
      for (const side of sidesFor(part, pose)) {
        const [fx, fy] = fingerCentre(pose.silhouette, o.pocket.clearance, side);
        const c = keep(keep(k.CrossSection.circle(fingerR, 32)).translate(fx, fy));
        all = all ? keep(all.add(c)) : c;
      }
      return all;
    };

    // 1. Footprint of every allowed pose: pocket opening (+ finger scoop), grown by half a wall.
    onProgress?.(0.03, 'Measuring parts');
    const limit = Math.min(o.depth ?? Infinity, o.maxDepth ?? Infinity);
    const maxPocket = limit - o.floor;
    const tooDeep: string[] = [];
    const items: PackItem[] = [];
    for (const part of parts) {
      const options = part.poses.filter((pose) => pocketDepth(pose) <= maxPocket + 1e-9).map((pose) => {
        let shape = keep(keep(k.CrossSection.ofPolygons(pose.silhouette, 'Positive')).offset(o.pocket.clearance, 'Round', 2, 16));
        const holes = scoops(part, pose);
        if (holes) shape = keep(shape.add(holes));
        const grown = keep(keep(shape.offset(o.wall / 2 + RASTER_SLACK + POLYGON_SLACK, 'Round', 2, 12)).simplify(0.1));
        return { key: pose.poseIndex, depth: pocketDepth(pose), footprint: grown.toPolygons() as Pt[][] };
      });
      if (!options.length) tooDeep.push(part.name);
      else items.push({ id: part.partId, options });
    }
    if (tooDeep.length)
      throw new TrayError(`${limit.toFixed(1)} mm is too shallow for: ${tooDeep.join(', ')}. Increase the tray depth or case height, or leave them empty.`);

    // 2. Pack. Footprints already carry half a wall, so the usable region is the
    //    tray shrunk by (edge − wall/2) on every side.
    onProgress?.(0.1, 'Arranging parts');
    const inset = Math.max(0, o.edge - o.wall / 2 - RASTER_SLACK);
    const packed = pack(items, { width: o.length - 2 * inset, height: o.width - 2 * inset, attempts: o.packAttempts ?? 30, timeBudgetMs: o.packTimeMs ?? 2500, trayOverhead: o.floor });
    if (packed.unplaced.length) {
      const names = packed.unplaced.map((id) => parts.find((p) => p.partId === id)!.name);
      throw new TrayError(`Too big for a ${o.length.toFixed(1)} × ${o.width.toFixed(1)} mm tray in any allowed pose: ${names.join(', ')}.`);
    }

    // 3. Cut each tray.
    const r = Math.max(0, Math.min(o.cornerRadius, o.length / 2 - 1, o.width / 2 - 1));
    const core = keep(k.CrossSection.square([o.length - 2 * r, o.width - 2 * r], true));
    const outline = r > 0 ? keep(core.offset(r, 'Round', 2, 32)) : core;
    const trays: Tray[] = [];
    let done = 0;
    for (let t = 0; t < packed.trays.length; t++) {
      const here = packed.placements.filter((p) => p.tray === t);
      const depth = o.depth ?? packed.trays[t].depth + o.floor;
      const placements: Placement[] = [];
      const cuts: Manifold[] = [];
      for (const pl of here) {
        const part = parts.find((p) => p.partId === pl.id)!;
        const pose = part.poses.find((p) => p.poseIndex === pl.key)!;
        onProgress?.(0.15 + (0.75 * done++) / packed.placements.length, `Cutting pocket: ${part.name}`);
        const c = buildCavity(k, pose.mesh, pose.silhouette, pose.height, o.pocket);
        let solid = keep(c.solid);
        const holes = scoops(part, pose);
        if (holes) {
          const d = fingerDepth(c.depth, o.fingerDepthFraction);
          solid = keep(solid.add(keep(keep(holes.extrude(d + 1)).translate(0, 0, c.top - d))));
        }
        const x = pl.tx - o.length / 2 + inset, y = pl.ty - o.width / 2 + inset, z = depth - c.top;
        cuts.push(keep(keep(solid.rotate([0, 0, pl.angle])).translate(x, y, z)));
        placements.push({ partId: part.partId, poseIndex: pose.poseIndex, fingers: sidesFor(part, pose), angle: pl.angle, x, y, z, pocketDepth: c.depth, formFit: c.formFit });
      }
      onProgress?.(0.92, `Building tray ${t + 1}`);
      const block = keep(outline.extrude(depth));
      const allCuts = cuts.length === 1 ? cuts[0] : keep(k.Manifold.union(cuts));
      const tray = keep(block.subtract(allCuts));
      if (tray.isEmpty()) throw new Error('Tray geometry came out empty');
      trays.push({ mesh: toTriMesh(tray, `tray-${t + 1}`), depth, placements, volume: tray.volume() });
    }
    return { trays };
  } finally {
    for (const t of trash) t.delete();
  }
}
