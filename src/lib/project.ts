import type { PartInput, Project, Settings } from '../types';
import { DEFAULT_SETTINGS, emptyProject } from '../defaults';
import { download } from './export/threemf';

const AUTOSAVE_KEY = 'pelican-tray-generator/autosave/v1';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Accept anything shaped roughly like a project and fill in the gaps. */
export function coerceProject(raw: unknown): Project {
  const base = emptyProject();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  const rs = (o.settings ?? {}) as Record<string, unknown>;
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const dv = DEFAULT_SETTINGS[k];
    settings[k] = (typeof dv === 'boolean'
      ? typeof rs[k] === 'boolean' ? rs[k] : dv
      : num(rs[k], dv as number)) as never;
  }
  const parts: PartInput[] = Array.isArray(o.parts)
    ? (o.parts as Record<string, unknown>[]).flatMap((p, i) => {
        const poly = p.poly;
        if (!Array.isArray(poly) || poly.length === 0) return [];
        return [{
          id: typeof p.id === 'string' ? p.id : `part-${i}`,
          name: typeof p.name === 'string' ? p.name : `Part ${i + 1}`,
          poly: poly as PartInput['poly'],
          keepHoles: p.keepHoles === true,
          depth: num(p.depth, 20),
          qty: Math.max(1, Math.round(num(p.qty, 1))),
          groupId: typeof p.groupId === 'string' ? p.groupId : null,
          sourceFile: typeof p.sourceFile === 'string' ? p.sourceFile : '',
          notes: Array.isArray(p.notes) ? (p.notes as string[]) : [],
          // Older project files predate unit tracking; their outlines are
          // already in mm, so a scale of 1 reproduces them exactly.
          sourceUnitMm: num(p.sourceUnitMm, 1),
          unitOverrideMm: typeof p.unitOverrideMm === 'number' && p.unitOverrideMm > 0
            ? p.unitOverrideMm : null,
          unitsAmbiguous: p.unitsAmbiguous === true,
        }];
      })
    : [];
  const groups = Array.isArray(o.groups)
    ? (o.groups as Record<string, unknown>[]).flatMap((g, i) =>
        typeof g.id === 'string' ? [{ id: g.id, name: typeof g.name === 'string' ? g.name : `Group ${i + 1}` }] : [])
    : [];
  return {
    formatVersion: 1,
    name: typeof o.name === 'string' ? o.name : base.name,
    settings,
    parts,
    groups,
  };
}

export function saveProjectFile(p: Project) {
  const safe = (p.name || 'project').replace(/[^\w.-]+/g, '_');
  download(JSON.stringify(p, null, 2), `${safe}.traygen.json`, 'application/json');
}

export async function loadProjectFile(file: File): Promise<Project> {
  return coerceProject(JSON.parse(await file.text()));
}

/**
 * Best-effort autosave. Browser storage is not available in every context, so
 * every access is guarded and failure is silent - the JSON file is the
 * authoritative way to keep a project.
 */
export function autosave(p: Project) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(p));
  } catch {
    /* private mode, blocked storage, or quota - the file export still works */
  }
}

export function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? coerceProject(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch { /* ignore */ }
}
