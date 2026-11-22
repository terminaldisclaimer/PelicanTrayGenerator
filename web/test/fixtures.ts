import { zipSync, strToU8 } from 'fflate';
import type { TriMesh } from '../src/mesh/types';

/** Axis-aligned box [0,sx]×[0,sy]×[0,sz] as 12 outward-facing triangles. */
export function boxMesh(sx: number, sy: number, sz: number, name = 'box'): TriMesh {
  const v = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ];
  const f = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return { name, positions: new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i]))) };
}

export function asciiSTL(m: TriMesh): string {
  const p = m.positions;
  let s = `solid ${m.name}\n`;
  for (let i = 0; i < p.length; i += 9) {
    s += ' facet normal 0 0 0\n  outer loop\n';
    for (let k = 0; k < 9; k += 3) s += `   vertex ${p[i + k]} ${p[i + k + 1]} ${p[i + k + 2]}\n`;
    s += '  endloop\n endfacet\n';
  }
  return s + `endsolid ${m.name}\n`;
}

/** Minimal 3MF with one box object; optional unit and build transform. */
export function box3MF(opts: { unit?: string; transform?: string; component?: boolean } = {}): ArrayBuffer {
  const verts = [[0,0,0],[10,0,0],[10,20,0],[0,20,0],[0,0,5],[10,0,5],[10,20,5],[0,20,5]];
  const tris = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const mesh = `<mesh><vertices>${verts.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>` +
    `<triangles>${tris.map(([a,b,c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
  const objects = opts.component
    ? `<object id="1" type="model">${mesh}</object><object id="2" name="assembly" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></components></object>`
    : `<object id="1" name="widget" type="model">${mesh}</object>`;
  const item = `<item objectid="${opts.component ? 2 : 1}"${opts.transform ? ` transform="${opts.transform}"` : ''}/>`;
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="${opts.unit ?? 'millimeter'}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${item}</build></model>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const zip = zipSync({ '_rels/.rels': strToU8(rels), '3D/3dmodel.model': strToU8(model), '[Content_Types].xml': strToU8('<Types/>') });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}
