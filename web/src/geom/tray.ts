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
  length: 300, width: 200, depth: null, floor: 2, wall: 3, edge: 4, cornerRadius: 4,
  fingerDiameter: 20, fingerDepthFraction: 0.6, pocket: DEFAULT_POCKET,
};

/** One way a part may lie in the tray. */
export interface TrayPose { poseIndex: number; mesh: TriMesh; silhouette: Silhouette; height: number }
export interface TrayPart {
  partId: number;
  name: string;
  /** Allowed poses, preferred first. One entry = pose is fixed. */
  poses: TrayPose[];
  finger: boolean;
}
export interface Placement {
  partId: number;
  poseIndex: number;
  /** The posed part is rotated by `angle` degrees about Z, then moved to (x, y, z). */
  angle: number; x: number; y: number; z: number;
  pocketDepth: number;
  formFit: boolean;
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
 * Where the finger scoop goes: on the pocket edge at the middle of the long
 * side (poses are aligned long-side-along-X, so that is straight "up" in Y
 * from the centre of the outline).
 */
export function fingerCentre(silhouette: Silhouette, clearance: number): Pt {
  let minX = Infinity, maxX = -Infinity;
  for (const l of silhouette) for (const [x] of l) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const cx = (minX + maxX) / 2;
  let top = -Infinity;
  for (const l of silhouette)
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      if ((a[0] <= cx && b[0] >= cx) || (b[0] <= cx && a[0] >= cx)) {
        const y = a[0] === b[0] ? Math.max(a[1], b[1]) : a[1] + ((cx - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
        if (y > top) top = y;
      }
    }
  return [cx, top + clearance];
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
    const scoop = (pose: TrayPose) => {
      const [fx, fy] = fingerCentre(pose.silhouette, o.pocket.clearance);
      return keep(keep(k.CrossSection.circle(fingerR, 32)).translate(fx, fy));
    };

    // 1. Footprint of every allowed pose: pocket opening (+ finger scoop), grown by half a wall.
    onProgress?.(0.03, 'Measuring parts');
    const maxPocket = o.depth === null ? Infinity : o.depth - o.floor;
    const tooDeep: string[] = [];
    const items: PackItem[] = [];
    for (const part of parts) {
      const options = part.poses.filter((pose) => pocketDepth(pose) <= maxPocket + 1e-9).map((pose) => {
        let shape = keep(keep(k.CrossSection.ofPolygons(pose.silhouette, 'Positive')).offset(o.pocket.clearance, 'Round', 2, 16));
        if (part.finger) shape = keep(shape.add(scoop(pose)));
        const grown = keep(keep(shape.offset(o.wall / 2 + RASTER_SLACK + POLYGON_SLACK, 'Round', 2, 12)).simplify(0.1));
        return { key: pose.poseIndex, depth: pocketDepth(pose), footprint: grown.toPolygons() as Pt[][] };
      });
      if (!options.length) tooDeep.push(part.name);
      else items.push({ id: part.partId, options });
    }
    if (tooDeep.length)
      throw new TrayError(`Tray depth ${o.depth!.toFixed(1)} mm is too shallow for: ${tooDeep.join(', ')}. Increase the depth or leave it empty for automatic.`);

    // 2. Pack. Footprints already carry half a wall, so the usable region is the
    //    tray shrunk by (edge − wall/2) on every side.
    onProgress?.(0.1, 'Arranging parts');
    const inset = Math.max(0, o.edge - o.wall / 2 - RASTER_SLACK);
    const packed = pack(items, { width: o.length - 2 * inset, height: o.width - 2 * inset, attempts: o.packAttempts ?? 24, timeBudgetMs: o.packTimeMs ?? 2500 });
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
        if (part.finger) {
          const fingerDepth = Math.min(c.depth, Math.max(o.fingerDepthFraction * c.depth, 0));
          const cyl = keep(keep(scoop(pose).extrude(fingerDepth + 1)).translate(0, 0, c.top - fingerDepth));
          solid = keep(solid.add(cyl));
        }
        const x = pl.tx - o.length / 2 + inset, y = pl.ty - o.width / 2 + inset, z = depth - c.top;
        cuts.push(keep(keep(solid.rotate([0, 0, pl.angle])).translate(x, y, z)));
        placements.push({ partId: part.partId, poseIndex: pose.poseIndex, angle: pl.angle, x, y, z, pocketDepth: c.depth, formFit: c.formFit });
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
