export type Vec3 = [number, number, number];
/** Row-major 3×3 rotation matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** Rotation that takes unit vector `n` to −Z (i.e. lays that face on the bed). */
export function rotationToDown(n: Vec3): Mat3 {
  const z: Vec3 = [-n[0], -n[1], -n[2]];
  const helper: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = norm(cross(helper, z));
  const y = cross(z, x);
  return [...x, ...y, ...z] as Mat3;
}

export function rotZ(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
export const ROT_X90: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
export const ROT_Y90: Mat3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
export const ROT_Z90: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
export const FLIP: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
