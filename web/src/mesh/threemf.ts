import { unzipSync, strFromU8 } from 'fflate';
import type { TriMesh } from './types';

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
};

interface ObjDef { verts: Float32Array; tris: Uint32Array; comps: { id: string; path?: string; m: number[] }[]; name?: string }

/**
 * Parse a 3MF package into one TriMesh per build item (transforms applied,
 * converted to mm). Supports components and the Production extension's
 * external object files (used by Bambu Studio / Fusion exports).
 * Uses a regex scanner instead of DOMParser so it also runs in Web Workers.
 */
export function parse3MF(buf: ArrayBuffer, fallbackName = 'part'): TriMesh[] {
  const files = unzipSync(new Uint8Array(buf));
  const rootPath = findRootModel(files);
  const models = new Map<string, Map<string, ObjDef>>();
  const units = new Map<string, number>();
  const load = (path: string) => {
    if (models.has(path)) return models.get(path)!;
    const key = path.replace(/^\//, '');
    const data = files[key];
    if (!data) throw new Error(`3MF missing part ${path}`);
    const xml = strFromU8(data);
    const unitM = /<model[^>]*\sunit="([a-z]+)"/i.exec(xml);
    units.set(path, UNIT_TO_MM[unitM?.[1] ?? 'millimeter'] ?? 1);
    const objs = parseObjects(xml);
    models.set(path, objs);
    return objs;
  };
  const root = load(rootPath);
  const rootXml = strFromU8(files[rootPath.replace(/^\//, '')]);
  const scale = units.get(rootPath)!;

  const out: TriMesh[] = [];
  const buildRe = /<item\b([^>]*?)\/?>/g;
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(rootXml)?.[1] ?? '';
  let m: RegExpExecArray | null;
  while ((m = buildRe.exec(build))) {
    const id = attr(m[1], 'objectid');
    if (!id) continue;
    const mat = parseTransform(attr(m[1], 'transform'));
    const acc: number[] = [];
    emit(rootPath, id, mat, acc, 0);
    if (acc.length) {
      const pos = new Float32Array(acc);
      for (let i = 0; i < pos.length; i++) pos[i] *= scale;
      const name = root.get(id)?.name || `${fallbackName}${out.length ? '-' + (out.length + 1) : ''}`;
      out.push({ name, positions: pos });
    }
  }
  if (!out.length) throw new Error('3MF contains no printable objects');
  return out;

  function emit(path: string, id: string, mat: number[], acc: number[], depth: number) {
    if (depth > 16) throw new Error('3MF component nesting too deep');
    const obj = load(path).get(id);
    if (!obj) throw new Error(`3MF references missing object ${id}`);
    const { verts, tris } = obj;
    for (let t = 0; t < tris.length; t++) {
      const v = tris[t] * 3;
      const x = verts[v], y = verts[v + 1], z = verts[v + 2];
      acc.push(
        mat[0] * x + mat[3] * y + mat[6] * z + mat[9],
        mat[1] * x + mat[4] * y + mat[7] * z + mat[10],
        mat[2] * x + mat[5] * y + mat[8] * z + mat[11],
      );
    }
    for (const c of obj.comps) emit(c.path ?? path, c.id, mul(mat, c.m), acc, depth + 1);
  }
}

function findRootModel(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels'];
  if (rels) {
    const m = /Target="([^"]+\.model)"/i.exec(strFromU8(rels));
    if (m) return m[1].startsWith('/') ? m[1] : '/' + m[1];
  }
  const any = Object.keys(files).find((f) => f.toLowerCase().endsWith('.model'));
  if (!any) throw new Error('Not a 3MF file (no .model part)');
  return '/' + any;
}

function attr(s: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)(?:[\\w]+:)?${name}="([^"]*)"`).exec(s);
  return m?.[1];
}

function parseObjects(xml: string): Map<string, ObjDef> {
  const map = new Map<string, ObjDef>();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(xml))) {
    const id = attr(m[1], 'id')!;
    const body = m[2];
    const v: number[] = [];
    const t: number[] = [];
    const vr = /<vertex\b([^>]*)\/>/g;
    let a: RegExpExecArray | null;
    while ((a = vr.exec(body))) v.push(+attr(a[1], 'x')!, +attr(a[1], 'y')!, +attr(a[1], 'z')!);
    const tr = /<triangle\b([^>]*)\/>/g;
    while ((a = tr.exec(body))) t.push(+attr(a[1], 'v1')!, +attr(a[1], 'v2')!, +attr(a[1], 'v3')!);
    const comps: ObjDef['comps'] = [];
    const cr = /<component\b([^>]*)\/>/g;
    while ((a = cr.exec(body))) {
      comps.push({ id: attr(a[1], 'objectid')!, path: attr(a[1], 'path'), m: parseTransform(attr(a[1], 'transform')) });
    }
    map.set(id, { verts: new Float32Array(v), tris: new Uint32Array(t), comps, name: attr(m[1], 'name') });
  }
  return map;
}

/** 3MF transforms are 12 numbers: column-major 3×3 followed by translation. */
function parseTransform(s?: string): number[] {
  if (!s) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 12 ? n : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}

/** Compose parent ∘ child (apply child first). */
function mul(p: number[], c: number[]): number[] {
  const r = new Array(12).fill(0);
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 3; row++)
      r[col * 3 + row] = p[row] * c[col * 3] + p[3 + row] * c[col * 3 + 1] + p[6 + row] * c[col * 3 + 2];
  for (let row = 0; row < 3; row++)
    r[9 + row] = p[row] * c[9] + p[3 + row] * c[10] + p[6 + row] * c[11] + p[9 + row];
  return r;
}
