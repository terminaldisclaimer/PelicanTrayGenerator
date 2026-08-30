import type { TriMesh } from '../cad/manifold';

/**
 * Binary STL, millimetres. The 80-byte header carries the settings that
 * generated the mesh, so a stray file on disk stays diagnosable: read the
 * first 80 bytes and the clearance, wall and liner numbers are right there.
 */
export function meshToStl(mesh: TriMesh, stamp = ''): Uint8Array {
  const triCount = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const header = `PelicanTray mm ${stamp}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, triCount, true);

  const p = mesh.positions;
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3] * 3;
    const b = mesh.indices[t * 3 + 1] * 3;
    const c = mesh.indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    view.setFloat32(o + 12, p[a], true); view.setFloat32(o + 16, p[a + 1], true); view.setFloat32(o + 20, p[a + 2], true);
    view.setFloat32(o + 24, p[b], true); view.setFloat32(o + 28, p[b + 1], true); view.setFloat32(o + 32, p[b + 2], true);
    view.setFloat32(o + 36, p[c], true); view.setFloat32(o + 40, p[c + 1], true); view.setFloat32(o + 44, p[c + 2], true);
    view.setUint16(o + 48, 0, true);
    o += 50;
  }
  return bytes;
}
