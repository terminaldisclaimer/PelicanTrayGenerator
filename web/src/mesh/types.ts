/** A triangle soup in millimetres: 9 floats per triangle (3 vertices × xyz). */
export interface TriMesh {
  name: string;
  positions: Float32Array;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function triangleCount(m: TriMesh): number {
  return m.positions.length / 9;
}
