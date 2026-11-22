/**
 * Projects are saved in the browser's IndexedDB on this device only (nothing
 * is uploaded). One record per project name.
 */
import type { SavedPart } from './worker/protocol';

export interface Project {
  name: string;
  savedAt: string;
  /** Case/tray settings as shown on the Trays tab (mm). */
  settings: Record<string, unknown>;
  parts: SavedPart[];
}

const DB = 'pelican-cutouts', STORE = 'projects';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  } finally {
    db.close();
  }
}

export const saveProject = (p: Project) => run('readwrite', (s) => s.put(p));
export const loadProject = (name: string) => run<Project | undefined>('readonly', (s) => s.get(name));
export const deleteProject = (name: string) => run('readwrite', (s) => s.delete(name));
export async function listProjects(): Promise<{ name: string; savedAt: string; parts: number }[]> {
  const all = await run<Project[]>('readonly', (s) => s.getAll());
  return all.map((p) => ({ name: p.name, savedAt: p.savedAt, parts: p.parts.length })).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// ---------- cloud copy (the owner's Cloudflare account, behind the same login) ----------

/** Pack a project into one binary blob: a JSON header, then every part's mesh. */
export function encodeProject(p: Project): ArrayBuffer {
  let offset = 0;
  const header = {
    format: 1, name: p.name, savedAt: p.savedAt, settings: p.settings,
    parts: p.parts.map((part) => {
      const entry = { ...part, positions: undefined, offset, floats: part.positions.length };
      offset += part.positions.byteLength;
      return entry;
    }),
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((8 + head.length) % 4)) % 4; // keep the float data 4-byte aligned
  const out = new Uint8Array(8 + head.length + pad + offset);
  out.set(new TextEncoder().encode('PCP1'), 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  let at = 8 + head.length + pad;
  for (const part of p.parts) {
    out.set(new Uint8Array(part.positions.buffer, part.positions.byteOffset, part.positions.byteLength), at);
    at += part.positions.byteLength;
  }
  return out.buffer;
}

export function decodeProject(buf: ArrayBuffer): Project {
  const bytes = new Uint8Array(buf);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'PCP1') throw new Error('Not a saved project');
  const headLen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen)));
  const base = 8 + headLen + ((4 - ((8 + headLen) % 4)) % 4);
  return {
    name: header.name, savedAt: header.savedAt, settings: header.settings,
    parts: header.parts.map((e: SavedPart & { offset: number; floats: number }) => {
      const { offset, floats, ...rest } = e;
      return { ...rest, positions: new Float32Array(buf.slice(base + offset, base + offset + floats * 4)) };
    }),
  };
}

/** Cloud names allow letters, digits, spaces and _.()+,- only. */
export const cloudName = (name: string) => name.replace(/[^\w .()+,\-]/g, '_').trim().slice(0, 60) || 'project';

export interface CloudProject { name: string; savedAt?: string; parts?: number; size?: number }

export async function cloudList(): Promise<CloudProject[] | null> {
  try {
    const res = await fetch('/api/projects', { headers: { accept: 'application/json' } });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

/** Upload a project. Returns false when offline, signed out, or too large (25 MB). */
export async function cloudSave(p: Project): Promise<boolean> {
  try {
    const body = encodeProject(p);
    if (body.byteLength > 25 * 1024 * 1024) return false;
    const res = await fetch(`/api/projects/${encodeURIComponent(cloudName(p.name))}`, {
      method: 'PUT', body,
      headers: { 'content-type': 'application/octet-stream', 'X-Project-Saved-At': p.savedAt, 'X-Project-Parts': String(p.parts.length) },
    });
    return res.ok;
  } catch { return false; }
}

export async function cloudLoad(name: string): Promise<Project | null> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(cloudName(name))}`);
    if (!res.ok) return null;
    return decodeProject(await res.arrayBuffer());
  } catch { return null; }
}

export async function cloudDelete(name: string): Promise<void> {
  try { await fetch(`/api/projects/${encodeURIComponent(cloudName(name))}`, { method: 'DELETE' }); } catch { /* offline */ }
}
