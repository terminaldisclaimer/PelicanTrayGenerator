import { zipSync, strToU8 } from 'fflate';
import type { TriMesh } from '../cad/manifold';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

export interface NamedMesh {
  mesh: TriMesh;
  name: string;
}

function meshXml(mesh: TriMesh): string {
  const v: string[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    v.push(`<vertex x="${round(p[i])}" y="${round(p[i + 1])}" z="${round(p[i + 2])}"/>`);
  }
  const t: string[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    t.push(`<triangle v1="${mesh.indices[i]}" v2="${mesh.indices[i + 1]}" v3="${mesh.indices[i + 2]}"/>`);
  }
  return `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`;
}

function modelXml(items: NamedMesh[], title: string): string {
  const objects = items
    .map((it, i) => `<object id="${i + 1}" type="model" name="${escapeXml(it.name)}">${meshXml(it.mesh)}</object>`)
    .join('');
  const build = items.map((_, i) => `<item objectid="${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">Pelican Tray Generator</metadata>
  <metadata name="Title">${escapeXml(title)}</metadata>
  <resources>${objects}</resources>
  <build>${build}</build>
</model>`;
}

const round = (n: number) => Number(n.toFixed(4));

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/**
 * A minimal but conformant 3MF package, in millimetres. Unlike STL, 3MF keeps
 * the objects separate and named, which is what makes it the right container
 * for a set of liners that print as one job.
 */
export function meshesTo3mf(items: NamedMesh[], title: string): Uint8Array {
  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(modelXml(items, title)),
    },
    { level: 6 },
  );
}

export function meshTo3mf(mesh: TriMesh, name: string): Uint8Array {
  return meshesTo3mf([{ mesh, name }], name);
}

export function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}

export function download(data: Uint8Array | string, filename: string, mime: string) {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
