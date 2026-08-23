import type { Layer, PartInput, PlacedPart, Poly, Settings, SolveResult, Tray, TrayNotch } from '../../types';
import { MaxRects } from './maxrects';
import { offsetPoly } from '../cad/manifold';
import { partPoly } from '../part';
import { LIP_BASE, REG, stackPitch, trayFootprint, trayHeight } from '../cad/profile';
import {
  bboxH, bboxW, minAreaRotation, polyArea, polyBBox, rotatePoly, translatePoly,
} from '../geom2d';

const NOTCH_RADIUS = 9;
const NOTCH_KEEPOUT = 0.5;
/** A tray padded more than this beyond its own parts wastes noticeable filament. */
const PADDING_WARN = 15;

interface Item {
  key: string;
  partId: string;
  name: string;
  instance: number;
  /** Pocket outline: silhouette offset by the global clearance, normalised. */
  poly: Poly;
  /** The part's own outline, kept concentric with `poly` through every move. */
  raw: Poly;
  w: number;
  h: number;
  depth: number;
  rotationDeg: number;
}

interface Cluster {
  id: string;
  label: string;
  items: Item[];
  /** Item positions within the cluster's own bounding rectangle. */
  layout: { item: Item; x: number; y: number; rotated: boolean }[];
  w: number;
  h: number;
  depth: number;
  area: number;
}

/**
 * Rotate a pocket outline and its part outline together by whole quarter
 * turns, then place the pair so the pocket's lower-left corner lands on
 * (x, y). Both receive the identical rigid motion, which is what keeps the
 * liner concentric with the pocket it has to sit inside.
 */
function placePair(poly: Poly, raw: Poly, quarters: number, x: number, y: number): { poly: Poly; raw: Poly } {
  let p = poly;
  let r = raw;
  for (let q = 0; q < quarters % 4; q++) {
    p = rotatePoly(p, Math.PI / 2);
    r = rotatePoly(r, Math.PI / 2);
  }
  const bb = polyBBox(p);
  return {
    poly: translatePoly(p, x - bb.minX, y - bb.minY),
    raw: translatePoly(r, x - bb.minX, y - bb.minY),
  };
}

function buildItems(parts: PartInput[], s: Settings): { items: Item[]; problems: SolveResult['unplaced'] } {
  const items: Item[] = [];
  const problems: SolveResult['unplaced'] = [];
  for (const p of parts) {
    const scaled = partPoly(p);
    const source: Poly = p.keepHoles ? scaled : [scaled[0]];
    let offset: Poly;
    try {
      offset = offsetPoly(source, s.clearance);
    } catch {
      problems.push({ partId: p.id, name: p.name, reason: 'Could not offset this outline.' });
      continue;
    }
    if (offset.length === 0) {
      problems.push({ partId: p.id, name: p.name, reason: 'Outline collapsed when offset.' });
      continue;
    }
    // Largest ring is the pocket boundary; anything inside it is an island.
    offset.sort((a, b) => Math.abs(polyArea([b])) - Math.abs(polyArea([a])));

    let oriented = offset;
    let rawOriented = source;
    let rotationDeg = 0;
    if (s.allowRotation) {
      const { rad } = minAreaRotation(offset[0]);
      oriented = rotatePoly(offset, rad);
      rawOriented = rotatePoly(source, rad);
      rotationDeg = (rad * 180) / Math.PI;
    }
    // Normalise against the pocket outline and shift the part outline by the
    // same delta, so the two stay concentric.
    const pre = polyBBox(oriented);
    oriented = translatePoly(oriented, -pre.minX, -pre.minY);
    rawOriented = translatePoly(rawOriented, -pre.minX, -pre.minY);
    const bb = polyBBox(oriented);
    const w = bboxW(bb);
    const h = bboxH(bb);
    if (!(w > 0 && h > 0)) {
      problems.push({ partId: p.id, name: p.name, reason: 'Outline has no area.' });
      continue;
    }
    for (let i = 0; i < Math.max(1, p.qty); i++) {
      items.push({
        key: `${p.id}#${i}`,
        partId: p.id,
        name: p.name,
        instance: i,
        poly: oriented,
        raw: rawOriented,
        w,
        h,
        depth: p.depth,
        rotationDeg,
      });
    }
  }
  return { items, problems };
}

function buildClusters(items: Item[], parts: PartInput[], maxInner: { w: number; h: number }, gap: number): {
  clusters: Cluster[];
  problems: SolveResult['unplaced'];
} {
  const groupOf = new Map(parts.map((p) => [p.id, p.groupId]));
  const byGroup = new Map<string, Item[]>();
  const clusters: Cluster[] = [];
  const problems: SolveResult['unplaced'] = [];

  for (const it of items) {
    const g = groupOf.get(it.partId) ?? null;
    const key = g ?? `solo:${it.key}`;
    const list = byGroup.get(key);
    if (list) list.push(it);
    else byGroup.set(key, [it]);
  }

  for (const [key, list] of byGroup) {
    if (list.length === 1) {
      const it = list[0];
      clusters.push({
        id: key,
        label: it.name,
        items: list,
        layout: [{ item: it, x: 0, y: 0, rotated: false }],
        w: it.w,
        h: it.h,
        depth: it.depth,
        area: it.w * it.h,
      });
      continue;
    }
    // Grouped parts must share a tray: lay them out once, then treat the
    // whole group as a single rigid rectangle for the rest of the solve.
    const pack = new MaxRects(maxInner.w, maxInner.h);
    const layout: Cluster['layout'] = [];
    let failed = false;
    for (const it of [...list].sort((a, b) => b.w * b.h - a.w * a.h)) {
      const p = pack.insert(it.w + gap, it.h + gap, true);
      if (!p) {
        failed = true;
        problems.push({ partId: it.partId, name: it.name, reason: 'Its group does not fit on one tray.' });
        continue;
      }
      layout.push({ item: it, x: p.x, y: p.y, rotated: p.rotated });
    }
    if (layout.length === 0) continue;
    const ext = pack.extent();
    clusters.push({
      id: key,
      label: failed ? `${list[0].name} (+group)` : `${list[0].name} +${layout.length - 1}`,
      items: layout.map((l) => l.item),
      layout,
      w: ext.w - gap,
      h: ext.h - gap,
      depth: Math.max(...layout.map((l) => l.item.depth)),
      area: layout.reduce((a, l) => a + l.item.w * l.item.h, 0),
    });
  }
  return { clusters, problems };
}

/** Depth buckets keep parts of similar height together so dead material stays low. */
function bucketise(clusters: Cluster[], tolerance: number): Cluster[][] {
  const sorted = [...clusters].sort((a, b) => a.depth - b.depth);
  const buckets: Cluster[][] = [];
  let cur: Cluster[] = [];
  let base = -Infinity;
  for (const c of sorted) {
    if (cur.length === 0 || c.depth - base <= tolerance) {
      if (cur.length === 0) base = c.depth;
      cur.push(c);
    } else {
      buckets.push(cur);
      cur = [c];
      base = c.depth;
    }
  }
  if (cur.length) buckets.push(cur);
  return buckets;
}

interface TrayDraft {
  cellsX: number;
  cellsY: number;
  placements: { cluster: Cluster; x: number; y: number; rotated: boolean }[];
  density: number;
}

function tryTray(clusters: Cluster[], cx: number, cy: number, s: Settings, margin: number): TrayDraft | null {
  const gap = s.wall;
  const aw = trayFootprint(cx, s.gridPitch) - 2 * margin + gap;
  const ah = trayFootprint(cy, s.gridPitch) - 2 * margin + gap;
  if (aw <= 0 || ah <= 0) return null;

  const pack = new MaxRects(aw, ah);
  const placements: TrayDraft['placements'] = [];
  let partArea = 0;
  for (const c of clusters) {
    const p = pack.insert(c.w + gap, c.h + gap, true);
    if (!p) continue;
    placements.push({ cluster: c, x: p.x, y: p.y, rotated: p.rotated });
    partArea += c.area;
  }
  if (placements.length === 0) return null;

  // Shrink to the smallest grid multiple that still contains everything.
  const ext = pack.extent();
  const cells = (extent: number) =>
    Math.max(1, Math.ceil((extent + 2 * margin - gap + REG.cellGap) / s.gridPitch - 1e-9));
  const sx = Math.min(cx, cells(ext.w));
  const sy = Math.min(cy, cells(ext.h));
  const density = partArea / (sx * s.gridPitch * sy * s.gridPitch);
  return { cellsX: sx, cellsY: sy, placements, density };
}

/** Why the biggest possible tray is the size it is. */
export interface TrayLimit {
  maxCX: number;
  maxCY: number;
  boundByBed: boolean;
}

function makeTrays(
  bucket: Cluster[],
  s: Settings,
  limit: TrayLimit,
  margin: number,
  problems: SolveResult['unplaced'],
): TrayDraft[] {
  const { maxCX, maxCY } = limit;
  let remaining = [...bucket].sort((a, b) => b.area - a.area);
  const out: TrayDraft[] = [];

  while (remaining.length) {
    let candidates: TrayDraft[] = [];
    for (let cy = 1; cy <= maxCY; cy++) {
      for (let cx = 1; cx <= maxCX; cx++) {
        const d = tryTray(remaining, cx, cy, s, margin);
        if (d) candidates.push(d);
      }
    }
    if (candidates.length === 0) {
      const c = remaining[0];
      // Say which limit was actually hit and by how much: "too big" on its own
      // leaves the user with nothing to act on.
      const needW = c.w + 2 * margin;
      const needH = c.h + 2 * margin;
      const haveW = trayFootprint(maxCX, s.gridPitch);
      const haveH = trayFootprint(maxCY, s.gridPitch);
      const short = Math.max(
        Math.min(needW, needH) - Math.min(haveW, haveH),
        Math.max(needW, needH) - Math.max(haveW, haveH),
      );
      const cause = limit.boundByBed
        ? `the ${s.maxBed} mm printer bed`
        : 'the case cutout';
      for (const it of c.items) {
        problems.push({
          partId: it.partId,
          name: it.name,
          reason:
            `Needs a ${needW.toFixed(0)} x ${needH.toFixed(0)} mm tray, but the largest that fits is ` +
            `${haveW.toFixed(0)} x ${haveH.toFixed(0)} mm - ${short.toFixed(0)} mm short, limited by ${cause}. ` +
            `This part cannot be held by a single printed tray.`,
        });
      }
      remaining = remaining.slice(1);
      continue;
    }
    const best = candidates.reduce((a, b) => (b.density > a.density ? b : a));
    // Among near-equally dense options prefer the one that clears more work.
    const chosen = candidates
      .filter((c) => c.density >= best.density * 0.92)
      .reduce((a, b) => (b.placements.length > a.placements.length ? b : a));
    out.push(chosen);
    const taken = new Set(chosen.placements.map((p) => p.cluster.id));
    remaining = remaining.filter((c) => !taken.has(c.id));
  }
  return out;
}

function notchesFor(tray: Tray, s: Settings): { notches: TrayNotch[]; warning?: string } {
  if (!s.thumbNotches) return { notches: [] };
  const boxes = tray.parts.map((p) => p.bbox);
  const clearOf = (cx: number, cy: number) =>
    boxes.every((b) => {
      const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w));
      const dy = Math.max(b.y - cy, 0, cy - (b.y + b.h));
      return Math.hypot(dx, dy) >= NOTCH_RADIUS + NOTCH_KEEPOUT;
    });

  const short = tray.sizeX <= tray.sizeY;
  const ends: [number, number][] = short
    ? [[tray.sizeX / 2, 0], [tray.sizeX / 2, tray.sizeY]]
    : [[0, tray.sizeY / 2], [tray.sizeX, tray.sizeY / 2]];
  const sides: [number, number][] = short
    ? [[0, tray.sizeY / 2], [tray.sizeX, tray.sizeY / 2]]
    : [[tray.sizeX / 2, 0], [tray.sizeX / 2, tray.sizeY]];

  const notches: TrayNotch[] = [];
  for (const [cx, cy] of [...ends, ...sides]) {
    if (notches.length >= 2) break;
    if (clearOf(cx, cy)) notches.push({ cx, cy, radius: NOTCH_RADIUS });
  }
  return notches.length
    ? { notches }
    : { notches, warning: 'No room for a thumb notch; lift this tray by its edges.' };
}

/**
 * A tray only has to reach its layer's full height where a tray in the layer
 * above actually rests on it. Everything else keeps the depth its own parts
 * need, which avoids printing tens of millimetres of solid filler under a
 * shallow pocket just because it shares a layer with a deep part.
 */
function padLoadedTrays(layers: Layer[], s: Settings) {
  for (let i = 0; i < layers.length; i++) {
    const above = layers[i + 1];
    if (!above) continue;
    for (const t of layers[i].trays) {
      const loaded = above.trays.some(
        (u) =>
          t.cellX < u.cellX + u.cellsX && u.cellX < t.cellX + t.cellsX &&
          t.cellY < u.cellY + u.cellsY && u.cellY < t.cellY + t.cellsY,
      );
      if (!loaded) continue;
      t.pocketZone = layers[i].pocketZone;
      t.padding = t.pocketZone - t.requiredDepth;
      t.height = trayHeight(s.floor, t.pocketZone);
      if (t.padding > PADDING_WARN) {
        t.warnings.push(
          `Padded ${t.padding.toFixed(1)} mm so the tray above seats flat. ` +
          `A tighter depth bucket tolerance would keep these parts apart.`,
        );
      }
    }
  }
}

export function solve(parts: PartInput[], s: Settings): SolveResult {
  const warnings: string[] = [];
  const unplaced: SolveResult['unplaced'] = [];
  const P = s.gridPitch;
  const margin = Math.max(s.wall, LIP_BASE);

  const gridCellsX = Math.floor((s.cutoutLength - 2 * s.caseFit + REG.cellGap) / P);
  const gridCellsY = Math.floor((s.cutoutWidth - 2 * s.caseFit + REG.cellGap) / P);
  const bedCells = Math.floor((s.maxBed + REG.cellGap) / P);
  const maxCX = Math.max(0, Math.min(gridCellsX, bedCells));
  const maxCY = Math.max(0, Math.min(gridCellsY, bedCells));

  const empty: SolveResult = {
    layers: [], trays: [], unplaced, warnings,
    stats: {
      partCount: 0, trayCount: 0, layerCount: 0, stackHeight: 0,
      cutoutDepth: s.cutoutDepth, footprintFill: 0, volumeFill: 0,
      gridCellsX, gridCellsY,
    },
  };
  if (maxCX < 1 || maxCY < 1) {
    warnings.push(`The cutout is smaller than one ${P} mm grid cell in at least one direction.`);
    return empty;
  }
  if (parts.length === 0) return empty;

  const { items, problems: itemProblems } = buildItems(parts, s);
  unplaced.push(...itemProblems);
  if (items.length === 0) return { ...empty, stats: { ...empty.stats, partCount: 0 } };

  const maxInner = {
    w: trayFootprint(maxCX, P) - 2 * margin + s.wall,
    h: trayFootprint(maxCY, P) - 2 * margin + s.wall,
  };
  const { clusters, problems: clusterProblems } = buildClusters(items, parts, maxInner, s.wall);
  unplaced.push(...clusterProblems);

  const limit: TrayLimit = { maxCX, maxCY, boundByBed: bedCells < gridCellsX || bedCells < gridCellsY };
  const drafts: TrayDraft[] = [];
  for (const bucket of bucketise(clusters, s.depthBucketTolerance)) {
    drafts.push(...makeTrays(bucket, s, limit, margin, unplaced));
  }

  // Materialise trays in their own local frame.
  const trays: Tray[] = drafts.map((d, i) => {
    const placed: PlacedPart[] = [];
    for (const pl of d.placements) {
      const c = pl.cluster;
      for (const l of c.layout) {
        // Size of this item inside the cluster's own frame.
        const liw = l.rotated ? l.item.h : l.item.w;
        const lih = l.rotated ? l.item.w : l.item.h;
        let lx = l.x, ly = l.y, iw = liw, ih = lih;
        let quarters = l.rotated ? 1 : 0;
        if (pl.rotated) {
          // Rotate the whole cluster a quarter turn CCW inside the tray.
          lx = c.h - (l.y + lih);
          ly = l.x;
          iw = lih;
          ih = liw;
          quarters += 1;
        }
        const x = margin + pl.x + lx;
        const y = margin + pl.y + ly;
        const moved = placePair(l.item.poly, l.item.raw, quarters, x, y);
        placed.push({
          partId: l.item.partId,
          name: l.item.name,
          instance: l.item.instance,
          poly: moved.poly,
          rawPoly: moved.raw,
          depth: l.item.depth,
          rotationDeg: l.item.rotationDeg + quarters * 90,
          bbox: { x, y, w: iw, h: ih },
        });
      }
    }
    const required = Math.max(...placed.map((p) => p.depth));
    const sizeX = trayFootprint(d.cellsX, P);
    const sizeY = trayFootprint(d.cellsY, P);
    return {
      id: `tray-${i + 1}`,
      name: `Tray ${i + 1}`,
      cellsX: d.cellsX,
      cellsY: d.cellsY,
      sizeX,
      sizeY,
      pocketZone: required,
      requiredDepth: required,
      padding: 0,
      height: trayHeight(s.floor, required),
      parts: placed,
      notches: [],
      layer: 0,
      cellX: 0,
      cellY: 0,
      z: 0,
      oversize: sizeX > s.maxBed || sizeY > s.maxBed,
      warnings: [],
    };
  });

  // Assemble trays into layers of the cutout footprint.
  let remaining = [...trays].sort(
    (a, b) => b.requiredDepth - a.requiredDepth || b.cellsX * b.cellsY - a.cellsX * a.cellsY,
  );
  const layers: Layer[] = [];
  let z = 0;

  while (remaining.length) {
    const anchor = remaining[0];
    const pack = new MaxRects(gridCellsX, gridCellsY);
    const ordered = [...remaining].sort(
      (a, b) => b.requiredDepth - a.requiredDepth || b.cellsX * b.cellsY - a.cellsX * a.cellsY,
    );
    const chosen: Tray[] = [];
    for (const t of ordered) {
      const p = pack.insert(t.cellsX, t.cellsY, true);
      if (!p) continue;
      if (p.rotated) {
        // Re-pack this tray's contents rotated so its printed frame matches.
        const swapX = t.cellsX;
        t.cellsX = t.cellsY;
        t.cellsY = swapX;
        const oldSizeY = t.sizeY;
        t.sizeY = t.sizeX;
        t.sizeX = oldSizeY;
        for (const part of t.parts) {
          const nx = oldSizeY - (part.bbox.y + part.bbox.h);
          const ny = part.bbox.x;
          const moved = placePair(part.poly, part.rawPoly, 1, nx, ny);
          part.poly = moved.poly;
          part.rawPoly = moved.raw;
          part.bbox = { x: nx, y: ny, w: part.bbox.h, h: part.bbox.w };
          part.rotationDeg += 90;
        }
      }
      t.cellX = p.x;
      t.cellY = p.y;
      chosen.push(t);
    }
    if (chosen.length === 0) {
      for (const p of anchor.parts) {
        unplaced.push({ partId: p.partId, name: p.name, reason: 'Its tray is larger than the case cutout footprint.' });
      }
      remaining = remaining.slice(1);
      continue;
    }
    const pocketZone = Math.max(...chosen.map((t) => t.requiredDepth));
    const pitch = stackPitch(s.floor, pocketZone);
    const index = layers.length;
    for (const t of chosen) {
      t.layer = index;
      t.z = z;
      // Padding is decided once every layer is known - see padLoadedTrays().
      t.pocketZone = t.requiredDepth;
      t.padding = 0;
      t.height = trayHeight(s.floor, t.requiredDepth);
      if (t.oversize) {
        t.warnings.push(`${t.sizeX.toFixed(1)} x ${t.sizeY.toFixed(1)} mm exceeds the ${s.maxBed} mm bed. Split its group into smaller ones.`);
      }
    }
    const used = chosen.reduce((a, t) => a + t.cellsX * t.cellsY, 0);
    layers.push({
      index,
      z,
      pitch,
      pocketZone,
      trays: chosen,
      fill: used / (gridCellsX * gridCellsY),
    });
    z += pitch;
    const done = new Set(chosen.map((t) => t.id));
    remaining = remaining.filter((t) => !done.has(t.id));
  }

  padLoadedTrays(layers, s);
  for (const t of trays) {
    const n = notchesFor(t, s);
    t.notches = n.notches;
    if (n.warning) t.warnings.push(n.warning);
  }

  const stackHeight = layers.length ? z + REG.height : 0;
  if (stackHeight > s.cutoutDepth + 1e-6) {
    warnings.push(
      `The stack is ${stackHeight.toFixed(1)} mm tall but the cutout is only ${s.cutoutDepth} mm deep. ` +
      `Remove parts, or split them across two cases.`,
    );
  }
  for (const t of trays) if (t.oversize) warnings.push(`${t.name} is larger than the printer bed.`);
  if (layers.length === 0 && unplaced.length > 0) {
    warnings.push(
      `No trays were generated: ${unplaced.length === 1 ? 'the part' : `all ${unplaced.length} parts`} ` +
      `could not be placed. See the reasons below.`,
    );
  }

  const placedTrays = layers.flatMap((l) => l.trays);
  const cellArea = gridCellsX * gridCellsY;
  const footprintFill = layers.length
    ? placedTrays.reduce((a, t) => a + t.cellsX * t.cellsY, 0) / (cellArea * layers.length)
    : 0;
  const usableVolume = s.cutoutLength * s.cutoutWidth * s.cutoutDepth;
  const trayVolume = placedTrays.reduce((a, t) => a + t.sizeX * t.sizeY * (t.height - REG.height), 0);

  return {
    layers,
    trays: placedTrays,
    unplaced,
    warnings,
    stats: {
      partCount: items.length,
      trayCount: placedTrays.length,
      layerCount: layers.length,
      stackHeight,
      cutoutDepth: s.cutoutDepth,
      footprintFill,
      volumeFill: usableVolume > 0 ? trayVolume / usableVolume : 0,
      gridCellsX,
      gridCellsY,
    },
  };
}
