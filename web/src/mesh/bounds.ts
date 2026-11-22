import type { Bounds, TriMesh } from './types';

export function meshBounds(m: TriMesh): Bounds {
  const p = m.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function size(b: Bounds): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/**
 * STL has no units. If the largest dimension is under 10 "units" the file was
 * very likely exported in inches (a 10 mm part is rare; a 10 in part common).
 */
export function looksLikeInches(b: Bounds): boolean {
  const s = size(b);
  const longest = Math.max(...s);
  return longest > 0 && longest < 10;
}

/** Translate so the part sits on z=0 centred on the XY origin. */
export function centerOnBed(m: TriMesh): TriMesh {
  const b = meshBounds(m);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, z0 = b.min[2];
  const p = new Float32Array(m.positions);
  for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; p[i + 2] -= z0; }
  return { name: m.name, positions: p };
}

export function scaleMesh(m: TriMesh, s: number): TriMesh {
  const p = new Float32Array(m.positions);
  for (let i = 0; i < p.length; i++) p[i] *= s;
  return { name: m.name, positions: p };
}

export const LARGE_MESH_TRIANGLES = 500_000;
export const MAX_MESH_TRIANGLES = 3_000_000;
