import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import type { Silhouette } from './analyze';
import { buildCavity, type PocketOptions, DEFAULT_POCKET } from './pocket';

/** Bambu Lab H3C build plate (mm). */
export const BED = { x: 330, y: 320 };

export interface TrayOptions {
  length: number; // X, mm (already reduced by any case clearance)
  width: number; // Y, mm
  /** Total tray depth; null = deepest pocket + floor. */
  depth: number | null;
  floor: number; // minimum material under the deepest pocket
  wall: number; // minimum between pockets
  edge: number; // minimum between a pocket and the tray edge
  cornerRadius: number;
  pocket: PocketOptions;
}

export const DEFAULT_TRAY: TrayOptions = {
  length: 300, width: 200, depth: null, floor: 2, wall: 3, edge: 4, cornerRadius: 4, pocket: DEFAULT_POCKET,
};

export interface TrayPart { partId: number; name: string; mesh: TriMesh; silhouette: Silhouette; height: number }
export interface Placement { partId: number; x: number; y: number; z: number; pocketDepth: number; formFit: boolean }
export interface TrayResult { mesh: TriMesh; depth: number; placements: Placement[]; volume: number }

/** User-facing problem with the request (shown as a message, not a crash). */
export class TrayError extends Error {}

function bounds(loops: Silhouette) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops) for (const [x, y] of loop) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Simple row ("shelf") layout by bounding box — a placeholder until the real
 * packer arrives. Returns the pocket-opening centre offset for each item, in
 * tray coordinates (origin at the tray centre).
 */
export function shelfLayout(items: { w: number; h: number }[], o: Pick<TrayOptions, 'length' | 'width' | 'wall' | 'edge'>): { x: number; y: number }[] | null {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => b.h - a.h || b.w - a.w);
  const out: { x: number; y: number }[] = new Array(items.length);
  const innerW = o.length - 2 * o.edge, innerH = o.width - 2 * o.edge;
  let x = 0, y = 0, rowH = 0;
  for (const it of order) {
    if (it.w > innerW + 1e-9 || it.h > innerH + 1e-9) return null;
    if (x > 0 && x + it.w > innerW + 1e-9) { x = 0; y += rowH + o.wall; rowH = 0; }
    if (y + it.h > innerH + 1e-9) return null;
    out[it.i] = { x: -innerW / 2 + x + it.w / 2, y: innerH / 2 - y - it.h / 2 };
    x += it.w + o.wall;
    rowH = Math.max(rowH, it.h);
  }
  return out;
}

function toTriMesh(m: Manifold, name: string): TriMesh {
  const mesh = m.getMesh();
  const v = mesh.vertProperties, t = mesh.triVerts, np = mesh.numProp;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = v[t[i] * np + c];
  return { name, positions: out };
}

/** Build one tray: rounded block with a pocket for every part. Sits on z=0, centred on XY. */
export function buildTray(k: ManifoldToplevel, parts: TrayPart[], o: TrayOptions, onProgress?: (fraction: number, label: string) => void): TrayResult {
  if (!parts.length) throw new TrayError('Add at least one part first.');
  const fitsBed = (o.length <= BED.x && o.width <= BED.y) || (o.length <= BED.y && o.width <= BED.x);
  if (!fitsBed) throw new TrayError(`A ${o.length} × ${o.width} mm tray does not fit the ${BED.x} × ${BED.y} mm print bed.`);
  if (o.length < 20 || o.width < 20) throw new TrayError('Tray is too small.');

  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  try {
    const cavities = parts.map((p, i) => {
      onProgress?.(0.05 + (0.7 * i) / parts.length, `Cutting pocket: ${p.name}`);
      const c = buildCavity(k, p.mesh, p.silhouette, p.height, o.pocket);
      keep(c.solid);
      return c;
    });
    const boxes = cavities.map((c) => bounds(c.opening));
    const spots = shelfLayout(boxes, o);
    if (!spots) throw new TrayError(`These parts do not fit in one ${o.length} × ${o.width} mm tray. Remove a part or enlarge the tray (multiple trays arrive in a later version).`);

    const deepest = Math.max(...cavities.map((c) => c.depth));
    const needed = deepest + o.floor;
    const depth = o.depth ?? needed;
    if (depth < needed - 1e-9)
      throw new TrayError(`Tray depth ${depth.toFixed(1)} mm is too shallow: the deepest pocket needs ${needed.toFixed(1)} mm including the floor.`);

    onProgress?.(0.8, 'Building tray');
    const r = Math.min(o.cornerRadius, o.length / 2 - 1, o.width / 2 - 1);
    const core = keep(k.CrossSection.square([o.length - 2 * r, o.width - 2 * r], true));
    const outline = r > 0 ? keep(core.offset(r, 'Round', 2, 32)) : core;
    const block = keep(outline.extrude(depth));

    const placements: Placement[] = [];
    const cuts = cavities.map((c, i) => {
      const b = boxes[i];
      // Shift so the opening's bounding box centre lands on its spot, and the
      // cavity top (z = c.top in part coordinates) meets the tray surface.
      const x = spots[i].x - (b.minX + b.maxX) / 2, y = spots[i].y - (b.minY + b.maxY) / 2, z = depth - c.top;
      placements.push({ partId: parts[i].partId, x, y, z, pocketDepth: c.depth, formFit: c.formFit });
      return keep(c.solid.translate(x, y, z));
    });
    const allCuts = cuts.length === 1 ? cuts[0] : keep(k.Manifold.union(cuts));
    const tray = keep(block.subtract(allCuts));
    if (tray.isEmpty()) throw new Error('Tray geometry came out empty');
    onProgress?.(0.95, 'Finishing');
    return { mesh: toTriMesh(tray, 'tray'), depth, placements, volume: tray.volume() };
  } finally {
    for (const t of trash) t.delete();
  }
}
