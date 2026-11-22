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
