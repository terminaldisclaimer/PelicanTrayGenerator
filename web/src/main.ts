import './style.css';
import { Viewer } from './viewer';
import { initSheet } from './ui/sheet';
import { GeometryClient } from './worker/client';
import type { ParsedPart, FileKind, PoseAction } from './worker/protocol';
import { LARGE_MESH_TRIANGLES } from './mesh/bounds';
import { fmtDims, MM_PER_IN, type Units } from './units';

type PartState = ParsedPart;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const viewer = new Viewer($('#view'));
const sheet = initSheet($('#sheet'), $('#sheet-handle'), (px) => viewer.setBottomInset(px));
const geo = new GeometryClient();

let parts: PartState[] = [];
let units: Units = (localStorage.getItem('units') as Units) || 'mm';

// ---------- tabs ----------
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll<HTMLElement>('.panel').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    if (sheet.snap === 'peek') sheet.open('half');
  }),
);

// ---------- units ----------
const unitButtons = document.querySelectorAll<HTMLButtonElement>('[data-units]');
const setUnits = (u: Units) => {
  units = u;
  try { localStorage.setItem('units', u); } catch { /* private mode */ }
  unitButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.units === u)));
  renderList();
};
unitButtons.forEach((b) => b.addEventListener('click', () => setUnits(b.dataset.units as Units)));

// ---------- progress / toast ----------
const progressEl = $('#progress');
const showProgress = (fraction: number, label: string) => {
  progressEl.hidden = false;
  progressEl.querySelector<HTMLElement>('.progress-label')!.textContent = label;
  progressEl.querySelector<HTMLElement>('.progress-bar')!.style.width = `${Math.round(fraction * 100)}%`;
};
const hideProgress = () => (progressEl.hidden = true);
let toastTimer = 0;
const toast = (msg: string) => {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 6000);
};

// ---------- file intake ----------
function kindOf(name: string): FileKind | null {
  const n = name.toLowerCase();
  return n.endsWith('.stl') ? 'stl' : n.endsWith('.3mf') ? '3mf' : null;
}

async function addFiles(files: Iterable<File>) {
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const kind = kindOf(f.name);
    if (!kind) { toast(`${f.name}: only .stl and .3mf files are supported`); continue; }
    const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    try {
      showProgress(0.02, `${prefix}Loading ${f.name}`);
      const buf = await f.arrayBuffer();
      const result = await geo.parse(f.name, kind, buf, (fr, label) => showProgress(fr, prefix + label));
      parts.push(...result);
      if (result.some((p) => p.large))
        toast(`Large mesh (> ${LARGE_MESH_TRIANGLES.toLocaleString()} triangles): processing may be slow on phones.`);
    } catch (e) {
      toast(`${f.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  hideProgress();
  refresh();
}

const input = $<HTMLInputElement>('#file-input');
input.addEventListener('change', () => {
  if (input.files?.length) addFiles(input.files);
  input.value = '';
});

// Desktop drag-and-drop
const drop = $('#drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; drop.hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; drop.hidden = true;
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

// ---------- list ----------
function refresh(reframe = true) {
  viewer.setParts(parts, reframe);
  renderList();
}

/** Replace one part with the worker's updated version (after a pose/scale change). */
async function update(p: PartState, job: Promise<ParsedPart>, reframe = false) {
  try {
    const next = await job;
    parts = parts.map((q) => (q.partId === p.partId ? next : q));
    refresh(reframe);
  } catch (e) {
    toast(`${p.mesh.name}: ${e instanceof Error ? e.message : e}`);
  }
}

const POSE_BUTTONS: [PoseAction, string, string][] = [
  ['next', 'Next pose', 'Try the next automatic resting pose'],
  ['flip', 'Flip', 'Turn upside down'],
  ['x90', 'Tip ↕', 'Tip 90° forwards'],
  ['y90', 'Tip ↔', 'Tip 90° sideways'],
  ['z90', 'Spin', 'Spin 90° on the bed'],
];

function renderList() {
  const ul = $('#parts');
  $('#empty').hidden = parts.length > 0;
  ul.replaceChildren(
    ...parts.map((p) => {
      const li = document.createElement('li');
      li.className = 'part';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.mesh.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const pose = p.poseIndex >= 0 ? `pose ${p.poseIndex + 1}/${p.poseCount}` : 'manual pose';
      meta.textContent = `${fmtDims(p.size, units)} · ${pose}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.setAttribute('aria-label', `Remove ${p.mesh.name}`);
      del.textContent = '✕';
      del.onclick = () => {
        geo.remove(p.partId);
        parts = parts.filter((q) => q.partId !== p.partId);
        refresh();
      };
      actions.append(del);
      li.append(name, actions, meta);

      const poseRow = document.createElement('div');
      poseRow.className = 'pose-row';
      for (const [action, label, title] of POSE_BUTTONS) {
        if (action === 'next' && p.poseCount < 2) continue;
        const b = document.createElement('button');
        b.className = 'btn small-btn';
        b.textContent = label;
        b.setAttribute('aria-label', `${title}: ${p.mesh.name}`);
        b.onclick = () => update(p, geo.pose(p.partId, action));
        poseRow.append(b);
      }
      li.append(poseRow);

      if (!p.solid) {
        const warn = document.createElement('div');
        warn.className = 'warn';
        warn.textContent = 'Mesh is not watertight: only a straight-walled pocket will be possible.';
        li.append(warn);
      }
      if (p.suggestInches) {
        const warn = document.createElement('div');
        warn.className = 'warn';
        warn.append('Very small — exported in inches?');
        const fix = document.createElement('button');
        fix.className = 'btn';
        fix.textContent = 'Scale ×25.4';
        fix.onclick = () => update(p, geo.scale(p.partId, MM_PER_IN), true);
        const keep = document.createElement('button');
        keep.className = 'btn';
        keep.textContent = 'Keep mm';
        keep.onclick = () => update(p, geo.scale(p.partId, 1));
        warn.append(fix, keep);
        li.append(warn);
      }
      return li;
    }),
  );
}

// ---------- library (parts uploaded to this site, e.g. by the Fusion script) ----------
interface LibraryItem { name: string; size?: number; uploaded?: string; version?: string }

async function loadLibrary() {
  let items: LibraryItem[];
  try {
    const res = await fetch('/api/parts', { headers: { accept: 'application/json' } });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return; // no API (dev) or signed out
    items = await res.json();
  } catch { return; } // offline
  $('#library').hidden = false;
  $('#library-empty').hidden = items.length > 0;
  items.sort((a, b) => a.name.localeCompare(b.name));
  $('#library-list').replaceChildren(
    ...items.map((it) => {
      const li = document.createElement('li');
      li.className = 'part';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const mb = it.size ? `${(it.size / 1048576).toFixed(it.size < 1048576 ? 2 : 1)} MB` : '';
      meta.textContent = [mb, it.version && `v${it.version}`, it.uploaded?.slice(0, 10)].filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'actions';
      const add = document.createElement('button');
      add.className = 'btn';
      add.textContent = 'Add';
      add.onclick = async () => {
        try {
          showProgress(0.02, `Downloading ${it.name}`);
          const res = await fetch(`/api/parts/${encodeURIComponent(it.name)}`);
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          await addFiles([new File([await res.blob()], it.name)]);
        } catch (e) {
          hideProgress();
          toast(`${it.name}: ${e instanceof Error ? e.message : e}`);
        }
      };
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.setAttribute('aria-label', `Delete ${it.name} from library`);
      del.textContent = '🗑';
      del.onclick = async () => {
        if (!confirm(`Delete ${it.name} from the library?`)) return;
        await fetch(`/api/parts/${encodeURIComponent(it.name)}`, { method: 'DELETE' });
        loadLibrary();
      };
      actions.append(add, del);
      li.append(name, actions, meta);
      return li;
    }),
  );
}
$('#library-refresh').addEventListener('click', loadLibrary);
loadLibrary();

$('#version').textContent = `Version ${__APP_VERSION__}`;
setUnits(units);
viewer.setParts([]);
