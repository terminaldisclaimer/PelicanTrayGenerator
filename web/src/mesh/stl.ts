import type { TriMesh } from './types';

/**
 * Parse a binary or ASCII STL. Normals in the file are ignored (recomputed when
 * rendering). Binary detection uses the size check (84 + 50·n bytes), which is
 * more reliable than looking for "solid" since many binary exporters start
 * their header with that word.
 */
export function parseSTL(buf: ArrayBuffer, name = 'part'): TriMesh {
  if (buf.byteLength >= 84) {
    const n = new DataView(buf).getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) return parseBinary(buf, n, name);
  }
  const text = new TextDecoder().decode(buf);
  if (/^\s*solid/i.test(text) && /facet/i.test(text)) return parseAscii(text, name);
  if (buf.byteLength >= 84) {
    // Truncated or padded binary: read as many whole triangles as exist.
    const n = Math.floor((buf.byteLength - 84) / 50);
    if (n > 0) return parseBinary(buf, n, name);
  }
  throw new Error('Not a valid STL file');
}

function parseBinary(buf: ArrayBuffer, n: number, name: string): TriMesh {
  const dv = new DataView(buf);
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12; // skip normal
    for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(base + k * 4, true);
  }
  return { name, positions: out };
}

function parseAscii(text: string, name: string): TriMesh {
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const vals: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  const usable = vals.length - (vals.length % 9);
  if (usable === 0) throw new Error('ASCII STL contains no triangles');
  return { name, positions: new Float32Array(vals.slice(0, usable)) };
}

/** Write a binary STL. */
export function writeSTL(m: TriMesh): ArrayBuffer {
  const n = m.positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = new TextEncoder().encode(`binary STL ${m.name}`.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(header);
  dv.setUint32(80, n, true);
  const p = m.positions;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const j = i * 9;
    const ux = p[j + 3] - p[j], uy = p[j + 4] - p[j + 1], uz = p[j + 5] - p[j + 2];
    const vx = p[j + 6] - p[j], vy = p[j + 7] - p[j + 1], vz = p[j + 8] - p[j + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, p[j + k], true);
  }
  return buf;
}
