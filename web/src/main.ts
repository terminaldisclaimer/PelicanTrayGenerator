import './style.css';
import { Viewer, renderThumbnail } from './viewer';
import { initSheet } from './ui/sheet';
import { GeometryClient } from './worker/client';
import type { Change, ParsedPart, FileKind, ShellRequest, Suggestion, TrayInfo } from './worker/protocol';
import { DEFAULT_LIFT, DEFAULT_TRAY, fingerCentre, SIDES, type LayoutData, type Side, type TrayOptions } from './geom/tray';
import { DEFAULT_SHELL, shellExtraHeight, shellPitch, shellProblem, trayInsideShell, type Footprint, type ShellOptions } from './geom/shell';
import { parseSTL, writeSTL } from './mesh/stl';
import { parse3MF, write3MF } from './mesh/threemf';
import { CableError, CONNECTOR_ROLLS, CONNECTOR_TURNS, DEFAULT_CABLE, defaultConnectorAxis, orientConnector, placeConnector, leadTip, nearestAt, presetLead, solveCable, tubeMesh, type CableSpec, type LeadPreset, type LeadSpec, type OrientedConnector, type SolvedCable } from './geom/cable';
import type { TriMesh } from './mesh/types';
import { cloudDelete, cloudDeleteVersion, cloudList, cloudLoad, cloudLoadVersion, cloudName, cloudRename, cloudSave, cloudUser, cloudVersions, deleteProject, listProjects, loadProject, newProjectId, saveProject, type Project } from './storage';
import { LARGE_MESH_TRIANGLES } from './mesh/bounds';
import { fmtDims, fmtLen, MM_PER_IN, type Units } from './units';

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
  fillTrayInputs();
  fillCable();
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

/** Parts uploaded moments ago, shown until the server's listing catches up. */
const justUploaded = new Map<string, { name: string; size: number; uploaded: string; until: number; folder?: string }>();

/** The library's parts as last fetched. */
let libraryItems: LibraryItem[] | null = null;

/** Library names allow letters, digits, spaces and _.()+,- only. */
function libraryName(fileName: string): string {
  const m = /^(.*)\.(stl|3mf)$/i.exec(fileName);
  const base = (m ? m[1] : fileName).replace(/[^\w .()+,\-]/g, '_').trim().slice(0, 110) || 'part';
  return `${base}.${(m ? m[2] : 'stl').toLowerCase()}`;
}

/** True when a part of the open project came from this library file. */
function inProject(item: string): boolean {
  const stem = item.replace(/\.(stl|3mf)$/i, '');
  return parts.some((p) => {
    // Parts are named after their file, plus " · body" when the file holds several.
    const key = libraryName(`${p.mesh.name}.stl`).slice(0, -4);
    return key === stem || key.startsWith(`${stem} _ `);
  });
}

/** Keep a copy of a part added from this device in the library (best effort). */
async function uploadToLibrary(file: File, buf: ArrayBuffer) {
  if (buf.byteLength > 25 * 1024 * 1024) { toast(`${file.name} is over 25 MB, so it was not added to the library.`); return; }
  try {
    // A new part goes into the folder that is open; one already in the library stays in its own folder.
    const name = libraryName(file.name), known = libraryItems?.find((x) => x.name === name);
    const folder = known ? known.folder : libraryFolder || undefined;
    const res = await fetch(`/api/parts/${encodeURIComponent(name)}`, { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream', ...(!known && folder ? { 'X-Part-Folder': encodeURIComponent(folder) } : {}) } });
    if (res.ok) {
      // The library's listing can lag a minute behind an upload, so show the new part straight away.
      justUploaded.set(name, { name, size: buf.byteLength, uploaded: new Date().toISOString(), until: Date.now() + 120_000, folder });
      loadLibrary();
    }
    else if (res.headers.get('content-type')?.includes('json')) toast(`${file.name} was not added to the library: ${(await res.json()).error ?? res.status}`);
  } catch { /* offline or no library: the part still works locally */ }
}

async function addFiles(files: Iterable<File>, fromLibrary = false) {
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const kind = kindOf(f.name);
    if (!kind) { toast(`${f.name}: only .stl and .3mf files are supported`); continue; }
    const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    try {
      showProgress(0.02, `${prefix}Loading ${f.name}`);
      const buf = await f.arrayBuffer();
      const copy = fromLibrary ? null : buf.slice(0); // the worker takes ownership of `buf`
      const result = await geo.parse(f.name, kind, buf, (fr, label) => showProgress(fr, prefix + label));
      if (copy) uploadToLibrary(f, copy);
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

// "Add parts" offers the two ways to add something: upload files, or make a coiled cable.
const addMenu = $('#add-menu'), addOpen = $('#add-open');
const showAddMenu = (on: boolean) => {
  addMenu.hidden = !on;
  addOpen.setAttribute('aria-expanded', String(on));
  if (on && sheet.snap === 'peek') sheet.open('half'); // room for the menu on a phone
};
addOpen.addEventListener('click', (e) => { e.stopPropagation(); showAddMenu(addMenu.hidden !== false); });
document.addEventListener('click', (e) => { if (!addMenu.hidden && !addMenu.contains(e.target as Node)) showAddMenu(false); });
addMenu.querySelector('label')!.addEventListener('click', () => setTimeout(() => showAddMenu(false), 0));
$('#add-cable').addEventListener('click', () => {
  showAddMenu(false);
  document.querySelector<HTMLButtonElement>('.tab[data-tab="parts"]')?.click();
  const form = $('#cable') as HTMLDetailsElement;
  form.open = true;
  sheet.open('full'); // the form is long: give it the whole sheet
  setTimeout(() => form.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
});
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
  scheduleSave();
  clearTray(); // any change to the parts makes the generated tray stale
  viewer.setParts(parts, reframe);
  renderList();
}

/** Replace one part with the worker's updated version (after a pose/scale change). */
async function update(p: PartState, job: Promise<ParsedPart>, reframe = false) {
  try {
    const hadTray = !!tray;
    const next = await job;
    parts = parts.map((q) => (q.partId === p.partId ? next : q));
    refresh(reframe);
    if (hadTray) generateTray(); // keep the tray on screen in step with the change
  } catch (e) {
    toast(`${p.mesh.name}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Part whose pose picker is open, and its rendered options. */
let picker: { partId: number; options: { index: number; url: string; size: [number, number, number] }[] } | null = null;

async function togglePicker(p: PartState) {
  if (picker?.partId === p.partId) { picker = null; renderList(); return; }
  try {
    const poses = await geo.poses(p.partId);
    picker = { partId: p.partId, options: poses.map((q) => ({ index: q.poseIndex, url: renderThumbnail(q.mesh), size: q.size })) };
    if (sheet.snap === 'peek') sheet.open('half');
    renderList();
  } catch (e) {
    toast(`${p.mesh.name}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Part whose finger-cutout picker is open. */
let fingerOpen: number | null = null;
const SIDE_NAME: Record<Side, string> = { top: 'far long side', bottom: 'near long side', left: 'left end', right: 'right end' };
const SVG = 'http://www.w3.org/2000/svg';

/**
 * Top-down drawing of the part with a tappable circle on each side of the
 * pocket. Filled circles are finger cutouts; tap to add or remove one.
 */
function fingerPicker(p: PartState): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'finger-picker';
  const clearance = traySettings.clearance, r = traySettings.fingerDia / 2;
  const centres = SIDES.map((side) => ({ side, c: fingerCentre(p.silhouette, clearance, side) }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { c } of centres) { minX = Math.min(minX, c[0] - r); maxX = Math.max(maxX, c[0] + r); minY = Math.min(minY, c[1] - r); maxY = Math.max(maxY, c[1] + r); }
  const pad = 4, w = maxX - minX + 2 * pad, h = maxY - minY + 2 * pad;
  const svg = document.createElementNS(SVG, 'svg');
  // Flip Y so the drawing matches the top-down view (Y up).
  svg.setAttribute('viewBox', `${minX - pad} ${-(maxY + pad)} ${w} ${h}`);
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', `Finger cutouts for ${p.mesh.name}`);
  svg.style.aspectRatio = `${w} / ${h}`;
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', p.silhouette.map((loop) => 'M' + loop.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join('L') + 'Z').join(''));
  path.setAttribute('class', 'fp-part');
  svg.append(path);
  // Draw the chosen cutouts first (full size), then a small "+"/"−" handle on every side.
  for (const { side, c } of centres) {
    if (!p.fingers.includes(side)) continue;
    const hole = document.createElementNS(SVG, 'circle');
    hole.setAttribute('cx', String(c[0])); hole.setAttribute('cy', String(-c[1])); hole.setAttribute('r', String(r));
    hole.setAttribute('class', 'fp-hole');
    svg.append(hole);
  }
  const mark = Math.max(2.2, w * 0.04); // handle size in drawing units
  for (const { side, c } of centres) {
    const on = p.fingers.includes(side);
    // Tap target: as large as possible without overlapping a neighbour's.
    let nearest = Infinity;
    for (const o of centres) if (o.side !== side) nearest = Math.min(nearest, Math.hypot(o.c[0] - c[0], o.c[1] - c[1]));
    const hit = Math.max(mark, Math.min((22 * w) / 300, nearest / 2));
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('class', 'fp-spot');
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-pressed', String(on));
    g.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} finger cutout on the ${SIDE_NAME[side]}`);
    const target = document.createElementNS(SVG, 'circle');
    target.setAttribute('cx', String(c[0])); target.setAttribute('cy', String(-c[1])); target.setAttribute('r', String(hit));
    target.setAttribute('class', 'fp-hit');
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', String(c[0])); dot.setAttribute('cy', String(-c[1])); dot.setAttribute('r', String(mark));
    dot.setAttribute('class', 'fp-dot');
    const sign = document.createElementNS(SVG, 'path');
    const k2 = mark * 0.5;
    sign.setAttribute('d', `M${c[0] - k2} ${-c[1]}H${c[0] + k2}` + (on ? '' : `M${c[0]} ${-c[1] - k2}V${-c[1] + k2}`));
    sign.setAttribute('class', 'fp-sign');
    sign.setAttribute('stroke-width', String(mark * 0.22));
    g.append(target, dot, sign);
    const toggle = () => update(p, geo.finger(p.partId, SIDES.filter((s) => (s === side ? !on : p.fingers.includes(s)))));
    g.addEventListener('click', toggle);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    svg.append(g);
  }
  const row = document.createElement('div');
  row.className = 'pose-row';
  const preset = (label: string, value: Side[] | 'auto', active: boolean) => {
    const b = document.createElement('button');
    b.className = 'btn small-btn';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(active));
    b.onclick = () => update(p, geo.finger(p.partId, value));
    row.append(b);
  };
  preset('Auto', 'auto', p.fingerAuto);
  preset('None', [], !p.fingerAuto && p.fingers.length === 0);
  const done = document.createElement('button');
  done.className = 'btn small-btn done-btn';
  done.textContent = 'Done';
  done.onclick = () => { fingerOpen = null; renderList(); };
  preset('Pinch pair', ['top', 'bottom'], !p.fingerAuto && p.fingers.length === 2 && p.fingers.includes('top') && p.fingers.includes('bottom'));
  row.append(done);
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent =
    (p.fingers.length ? `${p.fingers.length} finger cutout${p.fingers.length === 1 ? '' : 's'}${p.fingerAuto ? ' (chosen automatically)' : ''}.` : 'No finger cutouts on this part.') +
    ' Top-down view: tap + to add a cutout on that side, − to remove it. Size, depth and the swept shape are set on the Trays tab.';
  wrap.append(svg, row, hint);
  return wrap;
}

function renderList() {
  renderLibrary();
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
      const pose = p.poseLocked ? 'pose locked' : 'pose may be turned to fit';
      const placed = tray?.trays.flatMap((t) => t.placements).find((q) => q.partId === p.partId);
      const above = tray?.trays.flatMap((t) => t.placements).some((q) => q.under.includes(p.partId));
      const where = placed?.under.length ? ' · tucked under another part' : above ? ' · has a part beneath it' : '';
      meta.textContent = `${fmtDims(p.size, units)} · ${pose}${where}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.setAttribute('aria-label', `Remove ${p.mesh.name}`);
      del.textContent = '🗑';
      del.title = 'Remove this part';
      del.onclick = () => {
        if (!confirm(`Remove "${p.mesh.name}" from the parts list?`)) return;
        if (picker?.partId === p.partId) picker = null;
        if (fingerOpen === p.partId) fingerOpen = null;
        geo.remove(p.partId);
        parts = parts.filter((q) => q.partId !== p.partId);
        refresh();
      };
      actions.append(del);
      li.append(name, actions, meta);

      const choose = document.createElement('button');
      choose.className = 'btn small-btn';
      choose.textContent = picker?.partId === p.partId ? 'Close poses' : 'Choose pose';
      choose.setAttribute('aria-expanded', String(picker?.partId === p.partId));
      choose.onclick = () => togglePicker(p);
      const finger = document.createElement('button');
      finger.className = 'btn small-btn';
      finger.textContent = fingerOpen === p.partId ? 'Close cutouts' : `Finger cutouts: ${p.fingers.length}${p.fingerAuto ? ' (auto)' : ''}`;
      finger.setAttribute('aria-expanded', String(fingerOpen === p.partId));
      finger.onclick = () => { fingerOpen = fingerOpen === p.partId ? null : p.partId; picker = null; if (sheet.snap === 'peek') sheet.open('half'); renderList(); };
      const mainRow = document.createElement('div');
      mainRow.className = 'pose-row main-row';
      mainRow.append(choose, finger);
      li.append(mainRow);
      const stack = document.createElement('button');
      stack.className = 'btn small-btn';
      stack.textContent = p.stackable ? 'Stacking: allowed' : 'Stacking: never';
      stack.setAttribute('aria-pressed', String(!p.stackable));
      stack.setAttribute('aria-label', `${p.mesh.name}: ${p.stackable ? 'may be stacked with other parts; tap to forbid' : 'never stacked; tap to allow'}`);
      stack.onclick = () => update(p, geo.stackable(p.partId, !p.stackable));
      const lock = document.createElement('label');
      lock.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = p.poseLocked;
      box.setAttribute('aria-label', `Lock the pose of ${p.mesh.name}`);
      box.onchange = () => update(p, geo.lock(p.partId, box.checked));
      lock.append(box, 'Lock pose');
      const stackRow = document.createElement('div');
      stackRow.className = 'pose-row main-row';
      stackRow.append(lock, stack);
      // This part's own gap when stacked; empty = the Trays-tab setting.
      const gapRow = document.createElement('label');
      gapRow.className = 'row gap-row';
      const gapText = document.createElement('span');
      gapText.textContent = `Gap when stacked (${units})`;
      const gapInput = document.createElement('input');
      gapInput.className = 'num';
      gapInput.inputMode = 'decimal';
      gapInput.autocomplete = 'off';
      gapInput.placeholder = fromMM(traySettings.stackGap);
      gapInput.value = p.stackGap === null ? '' : fromMM(p.stackGap);
      gapInput.setAttribute('aria-label', `Gap when stacked for ${p.mesh.name}, in ${units}; empty uses the tray setting`);
      gapInput.onchange = () => {
        const text = gapInput.value.trim().replace(',', '.');
        const v = text === '' ? null : toMM(parseFloat(text));
        if (v !== null && !(v >= 0 && v <= 30)) { toast('Gap when stacked must be between 0 and 30 mm, or empty to use the tray setting.'); gapInput.value = p.stackGap === null ? '' : fromMM(p.stackGap); return; }
        update(p, geo.stackGap(p.partId, v));
      };
      gapRow.append(gapText, gapInput);

      li.append(stackRow);
      if (p.stackable) li.append(gapRow);
      if (fingerOpen === p.partId) li.append(fingerPicker(p));

      if (picker?.partId === p.partId) {
        const grid = document.createElement('div');
        grid.className = 'pose-grid';
        const pick = (index: number) => { picker = null; update(p, geo.select(p.partId, index)); };
        for (const o of picker.options) {
          const b = document.createElement('button');
          b.className = 'pose-option';
          b.setAttribute('aria-pressed', String(p.poseIndex === o.index));
          b.setAttribute('aria-label', `Pose ${o.index + 1}: ${fmtDims(o.size, units)}`);
          const img = document.createElement('img');
          img.src = o.url; img.alt = ''; img.width = 96; img.height = 96;
          const foot = document.createElement('span');
          foot.textContent = `${fmtLen(o.size[0], units, 0)} × ${fmtLen(o.size[1], units, 0)}`;
          const tall = document.createElement('span');
          tall.className = 'muted';
          tall.textContent = `${fmtLen(o.size[2], units, units === 'mm' ? 0 : 1)} ${units} deep`;
          b.append(img, foot, tall);
          b.onclick = () => pick(o.index);
          grid.append(b);
        }
        li.append(grid);
      }

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

// ---------- tray ----------
const num = (id: string) => $<HTMLInputElement>(id);
const toMM = (v: number) => (units === 'mm' ? v : v * MM_PER_IN);
const fromMM = (v: number, digits = units === 'mm' ? 2 : 3) => String(+(units === 'mm' ? v : v / MM_PER_IN).toFixed(digits));

/** Case inside size and fit settings (mm). The tray is the case size minus the gap on every side. */
interface TraySettings { length: number; width: number; height: number | null; gap: number; depth: number | null; edge: number; floor: number; wall: number; clearance: number; minFeature: number; split: number; fingerDia: number; fingerExtra: number; fingerSwept: boolean; stacking: boolean; stackGap: number; lift: boolean; liftDia: number; liftSides: 'long' | 'short'; shell: boolean; shellWall: number; shellRim: number; shellPlug: number; shellGap: number; liner: boolean; linerThick: number }
let traySettings: TraySettings = { length: 300, width: 200, height: null, gap: 1, depth: null, edge: 2, floor: 4, wall: DEFAULT_TRAY.wall, clearance: DEFAULT_TRAY.pocket.clearance, minFeature: 0, split: DEFAULT_TRAY.pocket.split, fingerDia: DEFAULT_TRAY.fingerDiameter, fingerExtra: 0, fingerSwept: true, stacking: true, stackGap: 0, lift: true, liftDia: DEFAULT_LIFT.diameter, liftSides: 'long', shell: true, shellWall: DEFAULT_SHELL.wall, shellRim: DEFAULT_SHELL.rim, shellPlug: DEFAULT_SHELL.plug, shellGap: DEFAULT_SHELL.gap, liner: false, linerThick: 6 };
try { traySettings = { ...traySettings, ...JSON.parse(localStorage.getItem('tray') || '{}') }; } catch { /* ignore */ }
let tray: TrayInfo | null = null;
/** Shell settings and outside footprint (tray + shell) used for the tray on screen; null = no shell. */
let trayShell: ShellRequest | null = null;
let showPartsInTray = true;

function fillTrayInputs() {
  num('#tray-length').value = fromMM(traySettings.length);
  num('#tray-width').value = fromMM(traySettings.width);
  num('#tray-height').value = traySettings.height == null ? '' : fromMM(traySettings.height);
  num('#tray-gap').value = fromMM(traySettings.gap);
  num('#tray-depth').value = traySettings.depth == null ? '' : fromMM(traySettings.depth);
  num('#tray-clearance').value = fromMM(traySettings.clearance);
  num('#tray-edge').value = fromMM(traySettings.edge);
  num('#tray-floor').value = fromMM(traySettings.floor);
  num('#tray-wall').value = fromMM(traySettings.wall);
  num('#tray-min-feature').value = fromMM(traySettings.minFeature);
  num('#tray-stack-gap').value = fromMM(traySettings.stackGap);
  num('#tray-lift-dia').value = fromMM(traySettings.liftDia);
  document.querySelectorAll<HTMLButtonElement>('[data-lift]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lift === (traySettings.lift ? traySettings.liftSides : 'off'))));
  $('#lift-rows').hidden = !traySettings.lift;
  num('#tray-split').value = String(Math.round(traySettings.split * 100));
  num('#tray-finger-dia').value = fromMM(traySettings.fingerDia);
  num('#tray-finger-extra').value = fromMM(traySettings.fingerExtra);
  document.querySelectorAll<HTMLButtonElement>('[data-swept]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.swept === '1') === traySettings.fingerSwept)));
  document.querySelectorAll<HTMLButtonElement>('[data-lift]').forEach((b) =>
  b.addEventListener('click', () => {
    traySettings.lift = b.dataset.lift !== 'off';
    if (traySettings.lift) traySettings.liftSides = b.dataset.lift as 'long' | 'short';
    document.querySelectorAll<HTMLButtonElement>('[data-lift]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('#lift-rows').hidden = !traySettings.lift;
    if (tray) generateTray();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.stack === '1') === traySettings.stacking)));
  num('#shell-wall').value = fromMM(traySettings.shellWall);
  num('#shell-rim').value = fromMM(traySettings.shellRim);
  num('#shell-plug').value = fromMM(traySettings.shellPlug);
  num('#shell-gap').value = fromMM(traySettings.shellGap);
  num('#liner-thick').value = fromMM(traySettings.linerThick);
  document.querySelectorAll<HTMLButtonElement>('[data-liner]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.liner === '1') === traySettings.liner)));
  $('#liner-row').hidden = !traySettings.liner;
  document.querySelectorAll<HTMLButtonElement>('[data-shell]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.shell === '1') === traySettings.shell)));
  $('#shell-rows').hidden = !traySettings.shell;
  document.querySelectorAll('.u').forEach((e) => (e.textContent = units));
}

function readTrayInputs(): TraySettings | string {
  const val = (id: string) => parseFloat(num(id).value.replace(',', '.'));
  const length = toMM(val('#tray-length')), width = toMM(val('#tray-width')), gap = toMM(val('#tray-gap')), clearance = toMM(val('#tray-clearance'));
  const depthText = num('#tray-depth').value.trim();
  const depth = depthText === '' ? null : toMM(val('#tray-depth'));
  const split = val('#tray-split') / 100;
  const height = num('#tray-height').value.trim() === '' ? null : toMM(val('#tray-height'));
  if (height !== null && !(height > 0)) return 'Case height must be a number, or leave it empty for no limit.';
  if (!(length > 0) || !(width > 0)) return 'Enter the case inside length and width.';
  if (!(gap >= 0 && gap <= 10)) return 'Gap to the case wall must be between 0 and 10 mm.';
  if (!(clearance >= 0 && clearance <= 5)) return 'Clearance must be between 0 and 5 mm.';
  if (depth !== null && !(depth > 0)) return 'Depth must be a number, or leave it empty for automatic.';
  if (!(split >= 0 && split <= 1)) return 'Form-fit must be between 0 and 100 %.';
  const edge = toMM(val('#tray-edge'));
  if (!(edge >= 0.8 && edge <= 20)) return 'Minimum tray thickness at the edge must be between 0.8 and 20 mm.';
  const floor = toMM(val('#tray-floor'));
  if (!(floor >= 0.8 && floor <= 30)) return 'Floor under the deepest pocket must be between 0.8 and 30 mm.';
  if (depth !== null && floor >= depth) return 'The floor is as thick as the whole tray. Lower it or raise the tray depth.';
  const wall = toMM(val('#tray-wall'));
  if (!(wall >= 0.8 && wall <= 20)) return 'Wall between pockets must be between 0.8 and 20 mm.';
  const minFeature = toMM(val('#tray-min-feature') || 0);
  if (!(minFeature >= 0 && minFeature <= 20)) return 'Ignore part details smaller than: enter 0 to 20 mm (0 follows every detail).';
  const liftDia = toMM(val('#tray-lift-dia') || DEFAULT_LIFT.diameter);
  if (traySettings.lift && !(liftDia >= 12 && liftDia <= 40)) return 'Lift-out hole diameter must be between 12 and 40 mm.';
  const stackGap = toMM(val('#tray-stack-gap') || 0);
  if (!(stackGap >= 0 && stackGap <= 30)) return 'Gap between stacked parts must be between 0 and 30 mm.';
  const fingerDia = toMM(val('#tray-finger-dia'));
  if (!(fingerDia >= 8 && fingerDia <= 40)) return 'Finger hole diameter must be between 8 and 40 mm.';
  const fingerExtra = toMM(val('#tray-finger-extra') || 0);
  if (!(fingerExtra >= 0 && fingerExtra <= 30)) return 'Finger hole extra depth must be between 0 and 30 mm.';
  const shell = traySettings.shell;
  // With the shell off its boxes are hidden, so keep whatever was set before.
  const sv = (id: string, old: number) => (shell ? toMM(val(id)) : old);
  const shellWall = sv('#shell-wall', traySettings.shellWall), shellRim = sv('#shell-rim', traySettings.shellRim), shellPlug = sv('#shell-plug', traySettings.shellPlug), shellGap = sv('#shell-gap', traySettings.shellGap);
  const linerThick = shell && traySettings.liner ? toMM(val('#liner-thick')) : traySettings.linerThick;
  if (shell) {
    const o = shellOptions({ shellWall, shellRim, shellPlug, shellGap });
    if (![shellWall, shellRim, shellPlug, shellGap].every(Number.isFinite)) return 'Enter the shell wall, rim, bottom step and gap, or switch the shell off.';
    const problem = shellProblem({ length: length - 2 * gap, width: width - 2 * gap, cornerRadius: DEFAULT_TRAY.cornerRadius }, o);
    if (problem) return problem;
    if (traySettings.liner && !(linerThick >= 1 && linerThick <= 20)) return 'TPU liner thickness must be between 1 and 20 mm.';
    if (traySettings.liner && shellGap > 0) return 'The TPU liner is printed onto the shell, so set the gap between tray and shell to 0 (or switch the liner off).';
    if (height !== null && height - shellExtraHeight(o) <= floor) return `The case height leaves no room for a tray inside the shell (the shell alone takes ${fmtLen(shellExtraHeight(o), units)} ${units}).`;
  }
  return { length, width, height, gap, depth, edge, floor, wall, clearance, minFeature, split, fingerDia, fingerExtra, fingerSwept: traySettings.fingerSwept, stacking: traySettings.stacking, stackGap, lift: traySettings.lift, liftDia, liftSides: traySettings.liftSides, shell, shellWall, shellRim, shellPlug, shellGap, liner: traySettings.liner, linerThick };
}

const shellOptions = (s: Pick<TraySettings, 'shellWall' | 'shellRim' | 'shellPlug' | 'shellGap'>): ShellOptions => ({ ...DEFAULT_SHELL, wall: s.shellWall, rim: s.shellRim, plug: s.shellPlug, gap: s.shellGap });

function renderExport() {
  const list = $('#export-list');
  if (!tray) {
    list.replaceChildren();
    $('#export-status').textContent = 'Generate a tray first (Trays tab).';
    return;
  }
  const info = tray, outer = trayShell?.outer;
  const one = info.trays.length === 1;
  const save = (label: string, file: string, type: string, data: () => BlobPart, primary = true) => {
    const b = document.createElement('button');
    b.className = primary ? 'btn primary wide' : 'btn wide';
    b.textContent = label;
    b.onclick = () => {
      const url = URL.createObjectURL(new Blob([data()], { type }));
      const a = document.createElement('a');
      a.href = url; a.download = file;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    return b;
  };
  const button = (label: string, file: string, positions: () => Float32Array) =>
    save(label, `${file}.stl`, 'model/stl', () => writeSTL({ name: file.split('-')[0], positions: positions() }), false);
  /** Moved up so the lowest point of the set stands on the bed. */
  const raised = (p: Float32Array, dz: number) => { if (!dz) return p; const q = p.slice(); for (let j = 2; j < q.length; j += 3) q[j] += dz; return q; };
  const size = (l: number, w: number, h: number) => `${Math.round(l)}x${Math.round(w)}x${Math.round(h)}`;
  list.replaceChildren(
    ...info.trays.flatMap((t, i) => {
      const n = one ? '' : `-${i + 1}`;
      const shell3 = info.shells?.[i];
      // One 3MF with the tray and its shell as separate bodies of one object, assembled as they go together.
      const out: HTMLButtonElement[] = [save(
        `Download ${one ? '' : `tray ${i + 1} `}3MF${shell3 ? ' (tray + shell, separate bodies)' : ''}`,
        `tray${n}-${size(outer?.length ?? info.length, outer?.width ?? info.width, shell3?.height ?? t.depth)}.3mf`, 'model/3mf',
        () => write3MF([
          { name: 'tray', positions: raised(t.mesh.positions, shell3?.below ?? 0) },
          ...(shell3 ? [{ name: 'shell', positions: raised(shell3.mesh.positions, shell3.below) }] : []),
        ], `tray${n}`) as Uint8Array<ArrayBuffer>,
      )];
      out.push(button(one ? (info.shells ? 'Download tray STL' : 'Download STL') : `Download tray ${i + 1} STL`, `tray${n}-${size(info.length, info.width, t.depth)}`, () => t.mesh.positions));
      const shell = info.shells?.[i];
      if (shell && outer)
        out.push(button(one ? 'Download shell STL' : `Download shell ${i + 1} STL`, `shell${n}-${size(outer.length, outer.width, shell.height)}`, () => {
          // The shell is held in the tray's coordinates (its floor and step are below zero); stand it on the bed.
          const p = shell.mesh.positions.slice();
          for (let j = 2; j < p.length; j += 3) p[j] += shell.below;
          return p;
        }));
      return out;
    }),
  );
  $('#export-status').textContent = info.trays
    .map((t, i) => {
      const shell = info.shells?.[i];
      return `Tray ${i + 1}: ${fmtDims([info.length, info.width, t.depth], units)}, ${(t.mesh.positions.length / 9).toLocaleString()} triangles.` +
        (shell && outer ? ` Shell ${i + 1}: ${fmtDims([outer.length, outer.width, shell.height], units)}.` : '');
    })
    .join(' ');
}

function clearTray() {
  if (!restoring) savedLayout = null; // the arrangement no longer matches the parts
  if (!tray) return;
  tray = null;
  viewer.setTrays(null);
  $('#tray-view-row').hidden = true;
  $('#tray-harder').hidden = true;
  $('#tray-suggest').hidden = true;
  $('#tray-status').textContent = 'Parts changed — generate the tray again.';
  renderExport();
}

function showTray() {
  const info = tray;
  if (info) viewer.setTrays(info.trays.map((t, i) => ({ ...t, shell: info.shells?.[i].mesh })), trayShell?.outer.width ?? info.width, parts, showPartsInTray);
}

/** Plain-words summary of which parts ended up stacked. */
function stackNote(result: TrayInfo): string {
  if (!result.stacks) return '';
  const name = (id: number) => parts.find((p) => p.partId === id)?.mesh.name ?? 'part';
  const lines: string[] = [];
  for (const t of result.trays)
    for (const pl of t.placements)
      if (pl.under.length) lines.push(`${name(pl.partId)} under ${pl.under.map(name).join(' and ')}`);
  return ` Stacked to fit: ${lines.join('; ')}.`;
}

type Effort = 'normal' | 'thorough' | 'hard';
/** The arrangement on screen in a saveable form: parts are referred to by their position in the parts list. */
interface SavedLayout { options: TrayOptions; shell: ReturnType<typeof shellRequestOf>; outer: Footprint; height: number | null; layout: LayoutData }
const shellRequestOf = (s: TraySettings, outer: Footprint): ShellRequest | null => (s.shell ? { outer, options: shellOptions(s), ...(s.liner ? { liner: s.linerThick } : {}) } : null);
let savedLayout: SavedLayout | null = null;
/** Search effort of the last layout, reused when a part edit regenerates it. */
let lastEffort: Effort = 'normal';

/** Read the Trays tab into a layout request, or return a message saying what is wrong. */
function trayRequest(effort: Effort) {
  const s = readTrayInputs();
  if (typeof s === 'string') return s;
  traySettings = s;
  try { localStorage.setItem('tray', JSON.stringify(s)); } catch { /* private mode */ }
  scheduleSave();
  // The case sets the outside size. With a shell, the tray is what is left inside it.
  const outer: Footprint = { length: s.length - 2 * s.gap, width: s.width - 2 * s.gap, cornerRadius: DEFAULT_TRAY.cornerRadius };
  const shell = shellRequestOf(s, outer);
  const inside = shell ? trayInsideShell(outer, shell.options) : outer;
  const options: TrayOptions = {
    ...DEFAULT_TRAY, ...inside, depth: s.depth,
    edge: s.edge, floor: s.floor, wall: s.wall,
    searchEffort: effort,
    lift: s.lift ? { ...DEFAULT_LIFT, diameter: s.liftDia, sides: s.liftSides } : null,
    maxDepth: s.height === null ? null : s.height - (shell ? shellExtraHeight(shell.options) : 0),
    fingerDiameter: s.fingerDia, fingerExtraDepth: s.fingerExtra, fingerSwept: s.fingerSwept, stacking: s.stacking, stackGap: s.stackGap,
    pocket: { ...DEFAULT_TRAY.pocket, clearance: s.clearance, split: s.split, minFeature: s.minFeature },
  };
  return { s, shell, outer, options };
}

/** Put a finished result on screen and describe it. */
function showResult(result: TrayInfo, shell: SavedLayout['shell'], outer: Footprint, height: number | null, note: string) {
  trayShell = shell;
  parts = result.parts; // unlocked parts now lie the way the layout chose
  picker = null;
  tray = result;
  renderList();
  showTray();
  const n = result.trays.length, count = result.trays.reduce((c, t) => c + t.placements.length, 0);
  const volume = result.trays.reduce((v, t) => v + t.volume, 0);
  const so = shell?.options;
  // In a stack each shell's bottom step sits inside the rim below, so only the lowest step adds height.
  const stack = so ? result.trays.reduce((v, t) => v + shellPitch(t.depth, so), so.plug) : result.trays.reduce((v, t) => v + t.depth, 0);
  const shellVolume = result.shells?.reduce((v, x) => v + x.volume, 0) ?? 0;
  const dims = (l: number, w: number) => fmtDims([l, w, 0], units).replace(/ × [\d.]+ (mm|in)$/, ' $1');
  $('#tray-status').textContent =
    `${n === 1 ? '1 tray' : `${n} trays`} of ${dims(outer.length, outer.width)}${so ? ` with the shell (tray inside ${dims(result.length, result.width)})` : ''}, ${count} pocket${count === 1 ? '' : 's'}. ` +
    result.trays.map((t, i) => `Tray ${i + 1}: ${t.placements.length} part${t.placements.length === 1 ? '' : 's'}, ${fmtLen(t.depth, units)} ${units} deep${result.shells ? `, ${fmtLen(result.shells[i].height, units)} ${units} tall in its shell` : ''}.`).join(' ') +
    stackNote(result) +
    (shell?.liner
      ? ` About ${(volume / 1000).toFixed(0)} cm³ of TPU liner (${fmtLen(shell.liner, units)} ${units} thick) before infill, plus ${(shellVolume / 1000).toFixed(0)} cm³ for the shell and its rigid core.`
      : ` About ${(volume / 1000).toFixed(0)} cm³ of material before infill` + (so ? `, plus ${(shellVolume / 1000).toFixed(0)} cm³ for the shell.` : '.')) +
    (height !== null && stack > height + 1e-6 ? ` Note: stacked, the trays are ${fmtLen(stack, units)} ${units} tall — more than the case height of ${fmtLen(height, units)} ${units}.` : n > 1 ? ` Stacked height ${fmtLen(stack, units)} ${units}.` : '') +
    note;
  $('#tray-view-row').hidden = false;
  renderExport();
  return n;
}

/** Remember the arrangement with the project, so it comes back exactly as it is. */
function rememberLayout(result: TrayInfo, options: TrayOptions, shell: SavedLayout['shell'], outer: Footprint, height: number | null) {
  const index = new Map(parts.map((p, i) => [p.partId, i]));
  const at = (id: number) => index.get(id) ?? -1;
  savedLayout = {
    options, shell, outer, height,
    layout: { ...result.layout, entries: result.layout.entries.map((e) => ({ ...e, partId: at(e.partId), under: e.under.map(at) })) },
  };
  scheduleSave();
}

async function generateTray(effort: Effort = lastEffort) {
  const req = trayRequest(effort);
  if (typeof req === 'string') { $('#tray-status').textContent = req; return; }
  const { s, shell, outer, options } = req;
  const hard = effort === 'hard';
  lastEffort = effort;
  const btn = $<HTMLButtonElement>('#tray-build');
  btn.disabled = true;
  try {
    showProgress(0.02, 'Generating tray');
    const result = await geo.tray(options, shell, showProgress);
    const n = showResult(result, shell, outer, s.height, '');
    rememberLayout(result, options, shell, outer, s.height);
    // More than one tray: a longer search may still find a one-tray layout.
    $('#tray-harder').hidden = n <= 1 || hard;
    $('#tray-suggest').hidden = n <= 1;
    if (n <= 1) $('#suggest').hidden = true;
    if (n > 1) $('#tray-status').textContent += hard ? ' The longer search did not find a one-tray layout either.' : ' This search did not find a one-tray layout; a longer search sometimes does.';
  } catch (e) {
    $('#tray-status').textContent = e instanceof Error ? e.message : String(e);
  } finally {
    hideProgress();
    btn.disabled = false;
  }
}

/** Show a project's saved arrangement again: cut it as it was, with no searching. */
async function restoreLayout(saved: SavedLayout) {
  if (!saved?.layout?.entries || saved.layout.entries.some((e) => !parts[e.partId])) return;
  try {
    showProgress(0.02, 'Restoring the saved layout');
    const id = (i: number) => parts[i].partId;
    const layout: LayoutData = { ...saved.layout, entries: saved.layout.entries.map((e) => ({ ...e, partId: id(e.partId), under: e.under.map(id) })) };
    const result = await geo.tray(saved.options, saved.shell, showProgress, layout);
    const n = showResult(result, saved.shell, saved.outer, saved.height, ' (Saved layout.)');
    savedLayout = saved;
    $('#tray-harder').hidden = true;
    $('#tray-suggest').hidden = n <= 1;
  } catch (e) {
    $('#tray-status').textContent = `The saved layout could not be restored (${e instanceof Error ? e.message : e}). Generate the tray again.`;
  } finally {
    hideProgress();
  }
}

$('#tray-build').addEventListener('click', () => generateTray('normal'));
$('#tray-harder').addEventListener('click', () => generateTray('hard'));

// ---------- "what would make it fit one tray?" ----------
let suggesting = false;

function showSuggestion(sg: Suggestion) {
  const li = document.createElement('li');
  li.className = 'part';
  const text = document.createElement('div');
  text.className = 'suggest-text';
  text.textContent = sg.text;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = sg.stacks ? `One tray, with ${sg.stacks} part${sg.stacks === 1 ? '' : 's'} tucked under others.` : 'One tray, nothing stacked.';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const apply = document.createElement('button');
  apply.className = 'btn';
  apply.textContent = sg.change.kind === 'effort' ? 'Use it' : 'Apply';
  apply.onclick = () => applyChange(sg.change);
  actions.append(apply);
  li.append(text, actions, meta);
  $('#suggest-list').append(li);
}

/** Make one suggested change, then lay the tray out again the same thorough way the suggestion was found. */
async function applyChange(c: Change) {
  if (suggesting) return;
  const part = 'partId' in c ? parts.find((p) => p.partId === c.partId) : undefined;
  const swap = (next: ParsedPart) => { parts = parts.map((q) => (q.partId === next.partId ? next : q)); };
  if (c.kind === 'setting') {
    if (c.key === 'fingerDiameter') traySettings.fingerDia = c.value as number;
    else if (c.key === 'depth') traySettings.depth = c.value as number;
    else if (c.key === 'stackGap') traySettings.stackGap = c.value as number;
    else if (c.key === 'clearance') traySettings.clearance = c.value as number;
    else if (c.key === 'edge') traySettings.edge = c.value as number;
    else traySettings.stacking = c.value as boolean;
    fillTrayInputs();
  } else if (c.kind === 'part' && part) {
    swap(await (c.change === 'unlock' ? geo.lock(part.partId, false) : c.change === 'allowStack' ? geo.stackable(part.partId, true) : geo.stackGap(part.partId, null)));
  } else if (c.kind === 'fingers' && part) {
    swap(await geo.finger(part.partId, c.fingers));
  } else if (c.kind === 'remove' && part) {
    if (!confirm(`Remove "${part.mesh.name}" from the parts list?`)) return;
    await geo.remove(part.partId);
    parts = parts.filter((q) => q.partId !== part.partId);
  }
  $('#suggest').hidden = true;
  viewer.setParts(parts, false);
  renderList();
  scheduleSave();
  await generateTray(c.kind === 'effort' ? 'hard' : 'thorough');
}

$('#tray-suggest').addEventListener('click', async () => {
  const req = trayRequest('thorough');
  if (typeof req === 'string') { $('#tray-status').textContent = req; return; }
  suggesting = true;
  $('#suggest').hidden = false;
  $('#suggest-list').replaceChildren();
  $('#suggest-status').textContent = 'Working… each change is tested with a full layout search. Suggestions appear here as they are found.';
  for (const id of ['#tray-build', '#tray-harder', '#tray-suggest']) $<HTMLButtonElement>(id).disabled = true;
  $('#tray-stop').hidden = false;
  let count = 0;
  try {
    const r = await geo.suggest(req.options, (fraction, label, sg) => {
      showProgress(fraction, label);
      if (sg) { count++; showSuggestion(sg); }
    });
    $('#suggest-status').textContent = r.list.length
      ? `${r.list.length} change${r.list.length === 1 ? '' : 's'} found after ${r.tried} trial${r.tried === 1 ? '' : 's'}. Each one is a single change; nothing has been applied.`
      : `No single change made everything fit, after ${r.tried} trials. That is not proof none exists, and combinations of changes were not tried.`;
  } catch (e) {
    const stopped = e instanceof Error && e.message === 'Stopped';
    $('#suggest-status').textContent = stopped ? `Stopped. ${count} change${count === 1 ? '' : 's'} found so far.` : `Could not finish: ${e instanceof Error ? e.message : e}`;
  } finally {
    suggesting = false;
    hideProgress();
    $('#tray-stop').hidden = true;
    for (const id of ['#tray-build', '#tray-harder', '#tray-suggest']) $<HTMLButtonElement>(id).disabled = false;
  }
});

// Stop a long run: the worker cannot be interrupted, so it is replaced and the parts loaded back into it.
$('#tray-stop').addEventListener('click', async () => {
  const saved = lastProject?.parts ?? [];
  geo.restart();
  hideProgress();
  if (saved.length) {
    restoring = true;
    try {
      const keep = tray;
      parts = await geo.restore(saved, showProgress);
      hideProgress();
      tray = null; // part ids changed, so the old layout no longer matches
      viewer.setTrays(null);
      viewer.setParts(parts);
      renderList();
      if (keep) $('#tray-status').textContent = 'Stopped. Generate the tray again when ready.';
    } finally { restoring = false; }
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((b) =>
  b.addEventListener('click', () => {
    traySettings.stacking = b.dataset.stack === '1';
    document.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (tray) generateTray();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-liner]').forEach((b) =>
  b.addEventListener('click', () => {
    traySettings.liner = b.dataset.liner === '1';
    document.querySelectorAll<HTMLButtonElement>('[data-liner]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('#liner-row').hidden = !traySettings.liner;
    if (tray) generateTray();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-shell]').forEach((b) =>
  b.addEventListener('click', () => {
    traySettings.shell = b.dataset.shell === '1';
    document.querySelectorAll<HTMLButtonElement>('[data-shell]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('#shell-rows').hidden = !traySettings.shell;
    if (tray) generateTray();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-swept]').forEach((b) =>
  b.addEventListener('click', () => {
    traySettings.fingerSwept = b.dataset.swept === '1';
    document.querySelectorAll<HTMLButtonElement>('[data-swept]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (tray) generateTray();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((b) =>
  b.addEventListener('click', () => {
    showPartsInTray = b.dataset.show === '1';
    document.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    showTray();
  }),
);

// ---------- projects (saved on this device) ----------
let projectName = '';
try { projectName = localStorage.getItem('project') || ''; } catch { /* private mode */ }
if (!projectName) projectName = 'My tray';
/** Stays with the project through renames; its saved versions are filed under it. */
let projectId = newProjectId();
let saveTimer = 0;
let restoring = false;

function scheduleSave() {
  if (restoring) return;
  $('#save-state').textContent = `${projectName} · saving…`;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 600);
}

let cloudTimer = 0;
let lastProject: Project | null = null;

/** Copy the project to the cloud (your Cloudflare account) so other devices can open it. */
async function uploadProject(version = false) {
  clearTimeout(cloudTimer);
  if (!lastProject) return;
  const p = lastProject;
  const ok = await cloudSave(p, version);
  if (p === lastProject) {
    const time = new Date(p.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#save-state').textContent = ok ? `${p.name} · saved ${time} · ${version ? 'version kept' : 'synced'}` : `${p.name} · saved ${time} on this device only`;
  }
  if (ok) renderProjects();
}

/**
 * Save the project on this device and copy it to the cloud. With `version`
 * (the Save button), the cloud also keeps this save as a version.
 */
async function saveNow(uploadNow = false, version = false) {
  try {
    const saved = await geo.exportParts();
    const project: Project = { name: projectName, id: projectId, savedAt: new Date().toISOString(), settings: { ...traySettings }, parts: saved, layout: savedLayout ?? undefined };
    await saveProject(project);
    lastProject = project;
    try { localStorage.setItem('project', projectName); } catch { /* private mode */ }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#project-status').textContent = `“${projectName}” — saved ${time} (${saved.length} part${saved.length === 1 ? '' : 's'}).`;
    $('#save-state').textContent = `${projectName} · saved ${time}`;
    clearTimeout(cloudTimer);
    if (uploadNow) await uploadProject(version);
    else cloudTimer = window.setTimeout(uploadProject, 2500);
    renderProjects();
    return true;
  } catch (e) {
    $('#project-status').textContent = `Could not save: ${e instanceof Error ? e.message : e}`;
    $('#save-state').textContent = 'Could not save';
    return false;
  }
}

/** Put a saved project on screen as the open one. */
async function showProject(p: Project, name: string, note: string) {
  restoring = true;
  try {
    projectName = name;
    projectId = p.id || newProjectId(); // saves from before projects had ids get one now
    try { localStorage.setItem('project', projectName); } catch { /* private mode */ }
    traySettings = { ...traySettings, ...(p.settings as Partial<TraySettings>) };
    fillTrayInputs();
    picker = null; fingerOpen = null;
    if (p.parts.length) showProgress(0.02, `Opening “${projectName}”`);
    parts = await geo.restore(p.parts, showProgress);
    hideProgress();
    clearTray();
    viewer.setParts(parts);
    renderList();
    if (p.layout) await restoreLayout(p.layout as SavedLayout);
    $('#project-status').textContent = `“${projectName}” — ${note} (${parts.length} part${parts.length === 1 ? '' : 's'}).`;
    $('#save-state').textContent = `${projectName} · saved`;
  } catch (e) {
    hideProgress();
    toast(`Could not open “${name}”: ${e instanceof Error ? e.message : e}`);
  } finally {
    restoring = false;
  }
}

/** Open a project from this device or the cloud, whichever copy is newer. */
async function openProject(name: string) {
  let p: Project | null | undefined = await loadProject(name).catch(() => undefined);
  const cloud = (await cloudList())?.find((c) => c.name === cloudName(name));
  if (cloud && (!p || (cloud.savedAt ?? '') > p.savedAt)) p = (await cloudLoad(name)) ?? p;
  if (!p) return false;
  await showProject(p, p.name || name, 'opened');
  renderProjects();
  return true;
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** The saved versions of the open project, newest first, each of which can be brought back. */
async function renderVersions() {
  const name = projectName;
  const list = await cloudVersions(name);
  if (name !== projectName) return; // another project was opened meanwhile
  $('#version-status').textContent = list === null
    ? 'Versions are kept in the cloud; they are not available offline.'
    : list.length ? `${list.length} version${list.length === 1 ? '' : 's'} of “${name}”. Press Save to keep another.` : 'Press Save to keep a version you can come back to.';
  $('#version-list').replaceChildren(
    ...(list ?? []).map((v, i) => {
      const li = document.createElement('li');
      li.className = 'part';
      const title = document.createElement('div');
      title.className = 'name';
      title.textContent = when(v.savedAt ?? v.version);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${i === 0 ? 'Newest · ' : ''}${v.parts ?? 0} part${v.parts === 1 ? '' : 's'}${v.size ? ` · ${(v.size / 1048576).toFixed(2)} MB` : ''}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const open = document.createElement('button');
      open.className = 'btn';
      open.textContent = 'Open';
      open.onclick = async () => {
        if (!confirm(`Go back to the version saved ${when(v.savedAt ?? v.version)}?\n\nWhat you have now is kept as a version first, so you can return to it.`)) return;
        clearTimeout(saveTimer);
        if (!(await saveNow(true, true))) { toast('Could not keep the current work as a version, so nothing was changed.'); return; }
        const p = await cloudLoadVersion(name, v.version);
        if (!p) { toast('Could not load that version.'); return; }
        await showProject({ ...p, id: projectId }, name, `went back to the version of ${when(v.savedAt ?? v.version)}`);
        await saveNow(true); // the working copy is now that version
        renderProjects();
      };
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '🗑';
      del.setAttribute('aria-label', `Delete the version of ${when(v.savedAt ?? v.version)}`);
      del.onclick = async () => {
        if (!confirm(`Delete the version saved ${when(v.savedAt ?? v.version)}? This cannot be undone.`)) return;
        await cloudDeleteVersion(name, v.version);
        li.remove(); // the server's list can take a minute to catch up
      };
      actions.append(open, del);
      li.append(title, actions, meta);
      return li;
    }),
  );
}

async function renderProjects() {
  renderVersions();
  let local: Awaited<ReturnType<typeof listProjects>> = [];
  try { local = await listProjects(); } catch { /* storage unavailable */ }
  const cloud = (await cloudList()) ?? [];
  interface Row { name: string; savedAt: string; parts: number; where: string }
  const rows = new Map<string, Row>();
  for (const it of local) rows.set(cloudName(it.name), { ...it, where: 'this device' });
  for (const c of cloud) {
    const r = rows.get(c.name);
    if (r) { r.where = 'this device + cloud'; if ((c.savedAt ?? '') > r.savedAt) { r.savedAt = c.savedAt!; r.parts = c.parts ?? r.parts; } }
    else rows.set(c.name, { name: c.name, savedAt: c.savedAt ?? '', parts: c.parts ?? 0, where: 'cloud' });
  }
  const list = [...rows.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  $('#project-list').replaceChildren(
    ...list.map((it) => {
      const li = document.createElement('li');
      li.className = 'part';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.name + (it.name === projectName ? ' (open)' : '');
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${it.parts} part${it.parts === 1 ? '' : 's'} · ${it.savedAt ? new Date(it.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''} · ${it.where}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      if (it.name !== projectName) {
        const open = document.createElement('button');
        open.className = 'btn';
        open.textContent = 'Open';
        open.onclick = async () => { await saveNow(true); openProject(it.name); };
        actions.append(open);
      }
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '🗑';
      del.setAttribute('aria-label', `Delete project ${it.name}`);
      del.onclick = async () => {
        if (!confirm(`Delete the saved project “${it.name}” from this device and the cloud? This cannot be undone.`)) return;
        await deleteProject(it.name).catch(() => undefined);
        await cloudDelete(it.name);
        if (it.name === projectName) { lastProject = null; $('#project-status').textContent = 'Not saved yet.'; }
        renderProjects();
      };
      actions.append(del);
      li.append(name, actions, meta);
      return li;
    }),
  );
}

$('#save-now').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  const btn = $<HTMLButtonElement>('#save-now');
  const ok = await saveNow(true, true); // the Save button keeps a version
  btn.textContent = ok ? 'Saved ✓' : 'Failed';
  setTimeout(() => (btn.textContent = 'Save'), 1500);
});

$('#project-save-as').addEventListener('click', async () => {
  const name = prompt('Save a copy of this project as:', projectName)?.trim();
  if (!name) return;
  projectName = name.slice(0, 60);
  projectId = newProjectId(); // a copy is its own project, with its own versions
  await saveNow(true, true);
});

$('#project-rename').addEventListener('click', async () => {
  const old = projectName;
  const name = prompt('New name for this project:', old)?.trim().slice(0, 60);
  if (!name || name === old) return;
  if (cloudName(name) !== name) { toast('Project names can use letters, digits, spaces and _.()+,- only.'); return; }
  clearTimeout(saveTimer); clearTimeout(cloudTimer);
  const local = await listProjects().catch(() => []);
  if (local.some((p) => p.name === name)) { toast(`You already have a project called “${name}”.`); return; }
  // Make sure everything is saved under the old name, then move it.
  await saveNow(true);
  const cloud = await cloudList();
  if (cloud) {
    if (cloud.some((c) => c.name === name)) { toast(`You already have a project called “${name}”.`); return; }
    const r = await cloudRename(old, name);
    if (r === 'exists') { toast(`You already have a project called “${name}”.`); return; }
    if (r === 'failed') { toast('Could not rename it in the cloud just now, so nothing was changed. Try again when you are online.'); return; }
  }
  projectName = name;
  await saveNow(true); // under the new name, here and in the cloud
  await deleteProject(old).catch(() => undefined);
  $('#project-status').textContent = `Renamed “${old}” to “${name}”.`;
  renderProjects();
});

$('#project-new').addEventListener('click', async () => {
  const name = prompt('Name for the new project:', 'New tray')?.trim();
  if (!name) return;
  await saveNow(); // keep the current one
  projectName = name.slice(0, 60);
  projectId = newProjectId();
  for (const p of parts) geo.remove(p.partId);
  parts = [];
  picker = null; fingerOpen = null;
  refresh();
  await saveNow();
});

// ---------- library (parts uploaded to this site, e.g. by the Fusion script) ----------
interface LibraryItem { name: string; size?: number; uploaded?: string; version?: string; folder?: string }
/** Folders that exist (created, or holding a part), and the one that is open ('' = parts in no folder). */
let libraryFolders: string[] = [];
let libraryFolder = '';
try { libraryFolder = localStorage.getItem('libraryFolder') ?? ''; } catch { /* private mode */ }
/** Moves made moments ago: the server's listing can lag, so they are shown straight away. */
const justMoved = new Map<string, { folder: string; until: number }>();
const FOLDER_NAME = /^[\w .()+,\-]{1,40}$/;

async function loadLibrary() {
  let items: LibraryItem[], folders: string[] = [];
  try {
    const [res, fres] = await Promise.all([fetch('/api/parts', { headers: { accept: 'application/json' } }), fetch('/api/folders', { headers: { accept: 'application/json' } })]);
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return; // no API (dev) or signed out
    items = await res.json();
    if (fres.ok && fres.headers.get('content-type')?.includes('json')) folders = await fres.json();
  } catch { return; } // offline
  for (const [name, it] of justUploaded) {
    if (items.some((x) => x.name === name) || Date.now() > it.until) justUploaded.delete(name);
    else items.push({ name, size: it.size, uploaded: it.uploaded, folder: it.folder });
  }
  for (const [name, mv] of justMoved) {
    const it = items.find((x) => x.name === name);
    if (!it || (it.folder ?? '') === mv.folder || Date.now() > mv.until) justMoved.delete(name);
    else it.folder = mv.folder || undefined;
  }
  libraryItems = items.sort((a, b) => a.name.localeCompare(b.name));
  fillConnectors();
  libraryFolders = [...new Set([...folders, ...libraryFolders.filter((f) => recentFolders.has(f)), ...items.map((x) => x.folder ?? '').filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  renderLibrary();
}
/** Folders made in this session, kept in the list until the server's listing shows them. */
const recentFolders = new Set<string>();

function openFolder(name: string) {
  libraryFolder = name;
  try { localStorage.setItem('libraryFolder', name); } catch { /* private mode */ }
  renderLibrary();
}

/** Ask for a new folder's name and create it. Returns the name, or null if cancelled or refused. */
async function newFolder(): Promise<string | null> {
  const name = prompt('Name for the new folder')?.trim();
  if (!name) return null;
  if (!FOLDER_NAME.test(name)) { toast('Folder names can use letters, digits, spaces and _.()+,- (up to 40 characters).'); return null; }
  try {
    const res = await fetch(`/api/folders/${encodeURIComponent(name)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(String(res.status));
  } catch (e) { toast(`Could not create the folder (${e instanceof Error ? e.message : e}).`); return null; }
  recentFolders.add(name);
  if (!libraryFolders.includes(name)) libraryFolders = [...libraryFolders, name].sort((a, b) => a.localeCompare(b));
  return name;
}

async function moveToFolder(it: LibraryItem, folder: string) {
  try {
    const res = await fetch(`/api/parts/${encodeURIComponent(it.name)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder }) });
    if (!res.ok) throw new Error(String(res.status));
    justMoved.set(it.name, { folder, until: Date.now() + 120_000 });
    it.folder = folder || undefined;
    toast(`${it.name} moved to ${folder || 'No folder'}.`);
  } catch (e) { toast(`Could not move ${it.name} (${e instanceof Error ? e.message : e}).`); }
  renderLibrary();
}

/** Show the open folder's parts. Parts stay listed after they are added, so one can be added several times. */
function renderLibrary() {
  if (!libraryItems) return;
  const all = libraryItems;
  const unfiled = all.some((it) => !it.folder);
  // The open folder may be gone (deleted, or emptied of unfiled parts): fall back to the first there is.
  if (libraryFolder ? !libraryFolders.includes(libraryFolder) : !unfiled && libraryFolders.length) libraryFolder = libraryFolders[0] ?? '';
  const count = (f: string) => all.filter((it) => (it.folder ?? '') === f).length;
  const pick = $('#library-folder') as HTMLSelectElement;
  pick.replaceChildren(
    ...[...libraryFolders, ...(unfiled || !libraryFolders.length ? [''] : [])].map((f) => {
      const o = document.createElement('option');
      o.value = f; o.textContent = `${f || 'No folder'} (${count(f)})`; o.selected = f === libraryFolder;
      return o;
    }),
  );
  const items = all.filter((it) => (it.folder ?? '') === libraryFolder);
  $('#library').hidden = false;
  $('#library-delete-folder').hidden = !(libraryFolder && items.length === 0);
  $('#library-empty').hidden = items.length > 0;
  $('#library-empty').textContent = all.length
    ? 'This folder is empty. Use "Move" on a part in another folder to put it here.'
    : 'No parts yet. Parts you add, and files sent by the Fusion 360 add-in, appear here.';
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
      meta.textContent = [mb, it.version && `v${it.version}`, it.uploaded?.slice(0, 10), inProject(it.name) && 'in this project'].filter(Boolean).join(' · ');
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
          await addFiles([new File([await res.blob()], it.name)], true);
        } catch (e) {
          hideProgress();
          toast(`${it.name}: ${e instanceof Error ? e.message : e}`);
        }
      };
      const move = document.createElement('select');
      move.className = 'btn';
      move.setAttribute('aria-label', `Move ${it.name} to another folder`);
      const opt = (value: string, label: string, disabled = false) => { const o = document.createElement('option'); o.value = value; o.textContent = label; o.disabled = disabled; return o; };
      move.append(opt('', 'Move…', true), ...libraryFolders.filter((f) => f !== libraryFolder).map((f) => opt(`f:${f}`, f)), opt('new', 'New folder…'), ...(libraryFolder ? [opt('f:', 'No folder')] : []));
      move.selectedIndex = 0;
      move.onchange = async () => {
        const v = move.value;
        move.selectedIndex = 0;
        const target = v === 'new' ? await newFolder() : v.slice(2);
        if (target === null) return;
        await moveToFolder(it, target);
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
      actions.append(add, move, del);
      li.append(name, actions, meta);
      return li;
    }),
  );
}
($('#library-folder') as HTMLSelectElement).addEventListener('change', (e) => openFolder((e.target as HTMLSelectElement).value));
$('#library-new-folder').addEventListener('click', async () => { const name = await newFolder(); if (name) openFolder(name); });
$('#library-delete-folder').addEventListener('click', async () => {
  const name = libraryFolder;
  if (!name || !confirm(`Delete the empty folder "${name}"?`)) return;
  try {
    const res = await fetch(`/api/folders/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(res.status === 409 ? 'it still has parts in it' : String(res.status));
    recentFolders.delete(name);
    libraryFolders = libraryFolders.filter((f) => f !== name);
    openFolder(libraryFolders[0] ?? '');
  } catch (e) { toast(`Could not delete the folder: ${e instanceof Error ? e.message : e}.`); }
});
// ---------- coiled cable (a generated part: stacked coil, a lead at each end, connector models on the ends) ----------
type Which = 'top' | 'bottom';
interface LeadSettings { at: number; stem: number; angle: number; radius: number; length: number; conn: string; /** Which way the model points along the cable (0..5), or null = its longest side. */ axis: number | null; roll: number }
interface CableSettings { d: number; len: number; l: number; w: number; r: number; mirror: boolean; top: LeadSettings; bottom: LeadSettings }
const noConn = { conn: '', axis: null, roll: 0 };
let cable: CableSettings = {
  d: DEFAULT_CABLE.wireD, len: DEFAULT_CABLE.totalLen, l: DEFAULT_CABLE.outerL, w: DEFAULT_CABLE.outerW, r: DEFAULT_CABLE.cornerR, mirror: false,
  top: { ...DEFAULT_CABLE.top, ...noConn }, bottom: { ...DEFAULT_CABLE.bottom, ...noConn },
};
try {
  const saved = JSON.parse(localStorage.getItem('cable3') || '{}');
  cable = { ...cable, ...saved, top: { ...cable.top, ...saved.top }, bottom: { ...cable.bottom, ...saved.bottom } };
} catch { /* ignore */ }
/** The cable part made from this form, so changing the form updates it instead of adding another. */
let cablePartId: number | null = null;
const connectorMeshes = new Map<string, TriMesh>();
const ENDS: Which[] = ['top', 'bottom'];
/** The end the controls under the drawing belong to. */
let cableEnd: Which = 'top';
/** Each end's connector as it is turned now (loaded from the library in the background). */
const turned: Record<Which, { o: OrientedConnector; name: string } | null> = { top: null, bottom: null };
/** The last coil that could be worked out: what the drawing shows and what dragging measures against. */
let cableShown: SolvedCable | null = null;
/** True while a handle in the drawing is being dragged. */
let cableHeld = false;

const cableSpec = (c: CableSettings): CableSpec => {
  const lead = (n: Which): LeadSpec => {
    const t = c[n].conn ? turned[n] : null;
    return { at: c[n].at, stem: c[n].stem, angle: c[n].angle, radius: c[n].radius, length: c[n].length, connector: t ? { height: t.o.height, width: t.o.width, length: t.o.length } : null };
  };
  return { wireD: c.d, totalLen: c.len, outerL: c.l, outerW: c.w, cornerR: c.r, gap: DEFAULT_CABLE.gap, fit: 'nearest', climbR: Math.max(8, 1.3 * c.d), mirror: c.mirror, top: lead('top'), bottom: lead('bottom') };
};

function fillCable() {
  num('#cable-d').value = fromMM(cable.d);
  num('#cable-len').value = fromMM(cable.len);
  num('#cable-l').value = fromMM(cable.l);
  num('#cable-w').value = fromMM(cable.w);
  num('#cable-r').value = fromMM(cable.r);
  document.querySelectorAll<HTMLButtonElement>('[data-cmir]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.cmir === '1') === cable.mirror)));
  fillCableEnd();
  document.querySelectorAll('#cable .u').forEach((e) => (e.textContent = units));
}

/** The controls under the drawing, for whichever end is selected. */
function fillCableEnd() {
  const e = cable[cableEnd];
  document.querySelectorAll<HTMLButtonElement>('[data-cend]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.cend === cableEnd)));
  num('#cable-angle').value = String(+e.angle.toFixed(1));
  num('#cable-leadlen').value = fromMM(e.length);
  num('#cable-radius').value = fromMM(e.radius);
  const el = $('#cable-conn') as HTMLSelectElement;
  const opt = (value: string, label: string) => { const o = document.createElement('option'); o.value = value; o.textContent = label; o.selected = value === e.conn; return o; };
  const items = [...(libraryItems ?? [])].sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name));
  el.replaceChildren(opt('', 'None (bare end)'), ...items.map((it) => opt(it.name, `${it.folder ? `${it.folder} / ` : ''}${it.name.replace(/\.(stl|3mf)$/i, '')}`)));
  // Keep a saved choice visible even before the library has loaded.
  if (e.conn && !items.some((it) => it.name === e.conn)) el.append(opt(e.conn, e.conn.replace(/\.(stl|3mf)$/i, '')));
  for (const b of ['#cable-turn', '#cable-roll']) ($(b) as HTMLButtonElement).disabled = !e.conn;
  const t = e.conn ? turned[cableEnd] : null;
  $('#cable-info').textContent = t ? `${fmtLen(t.o.length, units)} long × ${fmtLen(t.o.width, units)} wide × ${fmtLen(t.o.height, units)} tall ${units}` : '';
}
const fillConnectors = fillCableEnd;

async function connectorMesh(name: string): Promise<TriMesh> {
  const have = connectorMeshes.get(name);
  if (have) return have;
  const res = await fetch(`/api/parts/${encodeURIComponent(name)}`);
  if (!res.ok) throw new CableError(`Could not load ${name} from the library (${res.status}).`);
  const buf = await res.arrayBuffer();
  const bodies = /\.3mf$/i.test(name) ? parse3MF(buf, name) : [parseSTL(buf, name)];
  // A connector drawn as several bodies is used as one.
  const positions = new Float32Array(bodies.reduce((n, b) => n + b.positions.length, 0));
  let at = 0;
  for (const b of bodies) { positions.set(b.positions, at); at += b.positions.length; }
  const mesh = { name: name.replace(/\.(stl|3mf)$/i, ''), positions };
  connectorMeshes.set(name, mesh);
  return mesh;
}

/** Load and turn each end's connector model, so its size is known to the coil sums and the drawing. */
async function turnConnectors() {
  for (const n of ENDS) {
    const e = cable[n];
    if (!e.conn) { turned[n] = null; continue; }
    const mesh = await connectorMesh(e.conn);
    turned[n] = { o: orientConnector(mesh, e.axis ?? defaultConnectorAxis(mesh), e.roll), name: mesh.name };
  }
}

/** Read the number boxes into the settings (mm). Returns what is wrong, or null. */
function readCable(): string | null {
  const v = (id: string) => toMM(parseFloat(num(id).value.replace(',', '.')));
  const d = v('#cable-d'), len = v('#cable-len'), l = v('#cable-l'), w = v('#cable-w'), r = v('#cable-r');
  if (![d, len, l, w, r].every(Number.isFinite)) return 'Fill in the cable and coil sizes.';
  if (!(d >= 0.5 && d <= 40)) return 'Cable diameter must be between 0.5 and 40 mm.';
  if (!(len >= 10 && len <= 30000)) return 'Cable length must be between 10 mm and 30 m.';
  if (!(w >= 3 * d)) return `The coil must be at least ${fmtLen(3 * d, units)} ${units} wide (three cable diameters), so it has a hollow middle.`;
  if (!(l >= w)) return 'Coil length must be at least the coil width.';
  const angle = parseFloat(num('#cable-angle').value.replace(',', '.').replace('−', '-')), length = v('#cable-leadlen'), radius = v('#cable-radius');
  if (!(Math.abs(angle) <= 180)) return 'The bend must be between −180 and 180 degrees.';
  if (!(length >= 0)) return 'The length after the bend must be 0 or more.';
  if (!(radius > 0)) return 'Enter a bend radius.';
  cable = { ...cable, d, len, l, w, r, [cableEnd]: { ...cable[cableEnd], angle, length, radius } };
  return null;
}

const END_COLOUR: Record<Which, string> = { top: 'top', bottom: 'bottom' };
/** Work the coil out again and redraw it from above. Fast enough to run on every drag movement. */
function previewCable(): SolvedCable | null {
  const status = $('#cable-status');
  try {
    cableShown = solveCable(cableSpec(cable));
    const f = cableShown.footprint;
    status.textContent = `${cableShown.turns.toFixed(2)} turns. Coil ${fmtDims([f.length, f.width, f.height], units)} (you asked for ${fmtLen(cable.l, units)} long). Hollow middle ${fmtLen(cableShown.hollow.length, units)} × ${fmtLen(cableShown.hollow.width, units)} ${units}.`;
    drawCable(cableShown);
    return cableShown;
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
    return null;
  }
}

function drawCable(c: SolvedCable) {
  const svg = $('#cable-edit') as unknown as SVGSVGElement;
  // Corners of each connector, seen from above.
  const box = (n: Which): [number, number][] | null => {
    const t = cable[n].conn ? turned[n] : null;
    if (!t) return null;
    const { at, dir } = c.ends[n], [dx, dy] = dir, hw = t.o.width / 2;
    return [[at[0] - dy * hw, at[1] + dx * hw], [at[0] + dx * t.o.length - dy * hw, at[1] + dy * t.o.length + dx * hw], [at[0] + dx * t.o.length + dy * hw, at[1] + dy * t.o.length - dx * hw], [at[0] + dy * hw, at[1] - dx * hw]];
  };
  const boxes = { top: box('top'), bottom: box('bottom') };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const p of c.path) grow(p[0], p[1]);
  for (const n of ENDS) for (const p of boxes[n] ?? []) grow(p[0], p[1]);
  const pad = Math.max(14, cable.d * 2.5);
  // The far side is drawn at the top, so the picture is flipped top to bottom.
  // While a handle is held the picture keeps its scale, so the handle stays under the finger.
  if (!cableHeld || !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
  const view = svg.viewBox.baseVal;
  const el = (tag: string, attrs: Record<string, string | number>, cls = '') => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (cls) e.setAttribute('class', cls); return e; };
  const kids: Element[] = [el('polyline', { points: c.path.map((p) => `${p[0].toFixed(2)},${(-p[1]).toFixed(2)}`).join(' '), 'stroke-width': cable.d }, 'wire')];
  // Handles are sized by the picture, so a thumb can take hold of them whatever the coil's size.
  const unit = Math.max(view.width / Math.max(1, svg.clientWidth || 340), view.height / Math.max(1, svg.clientHeight || 260)), hr = 8 * unit, hit = 22 * unit;
  for (const n of ENDS) {
    const b = boxes[n], cls = END_COLOUR[n], sel = n === cableEnd ? ' sel' : '';
    if (b) kids.push(el('polygon', { points: b.map((p) => `${p[0].toFixed(2)},${(-p[1]).toFixed(2)}`).join(' '), 'stroke-width': unit * 1.5 }, `conn-${cls}`));
    const j = c.leads[n].junction, t = c.ends[n].at;
    kids.push(el('circle', { cx: j[0], cy: -j[1], r: hr, 'stroke-width': unit * 2 }, `h-${cls}${sel}`));
    kids.push(el('rect', { x: t[0] - hr, y: -t[1] - hr, width: 2 * hr, height: 2 * hr, 'stroke-width': unit * 2 }, `h-${cls}${sel}`));
    // Bigger invisible targets on top; the tip's goes last so it wins where the two overlap.
    const grab = (x: number, y: number, part: 'junction' | 'tip') => { const g = el('circle', { cx: x, cy: -y, r: hit }, 'hit'); g.setAttribute('data-end', n); g.setAttribute('data-part', part); return g; };
    kids.push(grab(j[0], j[1], 'junction'), grab(t[0], t[1], 'tip'));
  }
  svg.replaceChildren(...kids);
}

/** Move the end being dragged to follow the pointer (x, y in mm, seen from above). */
function dragCable(n: Which, part: 'junction' | 'tip', x: number, y: number) {
  const shown = cableShown;
  if (!shown) return;
  const e = cable[n];
  if (part === 'junction') e.at = nearestAt({ ...cableSpec(cable) }, shown.footprint.length, x, y);
  else {
    // Find the bend and length that put the tip nearest the pointer: try every degree, and for each take the best length.
    const { junction, heading, turn } = shown.leads[n];
    let best = { err: Infinity, angle: e.angle, length: e.length };
    for (let a = -180; a <= 180; a++) {
      const base = leadTip(junction, heading, turn, e.stem, a, e.radius, 0);
      const length = Math.max(0, (x - base.at[0]) * Math.cos(base.heading) + (y - base.at[1]) * Math.sin(base.heading));
      const err = Math.hypot(base.at[0] + Math.cos(base.heading) * length - x, base.at[1] + Math.sin(base.heading) * length - y);
      // Prefer the tidy angles when they are nearly as good.
      const tidy = a % 15 === 0 ? 2.5 : 0;
      if (err - tidy < best.err) best = { err: err - tidy, angle: a, length };
    }
    e.angle = best.angle;
    e.length = Math.round(best.length);
  }
  cableEnd = n;
  fillCableEnd();
  previewCable();
}

{
  const svg = $('#cable-edit') as unknown as SVGSVGElement;
  let held: { n: Which; part: 'junction' | 'tip' } | null = null;
  const where = (ev: PointerEvent) => { const m = svg.getScreenCTM(); if (!m) return null; const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()); return [p.x, -p.y] as const; };
  svg.addEventListener('pointerdown', (ev) => {
    const t = ev.target as Element;
    const n = t.getAttribute('data-end') as Which | null, part = t.getAttribute('data-part') as 'junction' | 'tip' | null;
    if (!n || !part) return;
    ev.preventDefault();
    held = { n, part };
    cableHeld = true;
    svg.setPointerCapture(ev.pointerId);
    if (cableEnd !== n) { cableEnd = n; fillCableEnd(); if (cableShown) drawCable(cableShown); }
  });
  svg.addEventListener('pointermove', (ev) => { if (!held) return; const p = where(ev); if (p) dragCable(held.n, held.part, p[0], p[1]); });
  const drop = () => { if (!held) return; held = null; cableHeld = false; if (cableShown) drawCable(cableShown); saveCable(); cableChanged(); };
  svg.addEventListener('pointerup', drop);
  svg.addEventListener('pointercancel', drop);
}

const saveCable = () => { try { localStorage.setItem('cable3', JSON.stringify(cable)); } catch { /* private mode */ } };

/** One build at a time: a change made while one is running is picked up by a rerun, never a second cable. */
let cableBusy = false, cableAgain = false;
async function buildCable() {
  if (cableBusy) { cableAgain = true; return; }
  cableBusy = true;
  try {
    do { cableAgain = false; await buildCableOnce(); } while (cableAgain);
  } finally { cableBusy = false; }
}
async function buildCableOnce() {
  const status = $('#cable-status');
  const wrong = readCable();
  if (wrong) { status.textContent = wrong; return; }
  saveCable();
  try {
    showProgress(0.05, 'Working out the coil');
    await turnConnectors();
    fillCableEnd();
    const c = cable, solved = previewCable();
    if (!solved) { hideProgress(); return; }
    const bodies: TriMesh[] = [tubeMesh(solved.path, c.d)];
    const used = ENDS.filter((n) => c[n].conn && turned[n]);
    for (const n of used) bodies.push(placeConnector(turned[n]!.o, solved.ends[n], turned[n]!.name));
    const name = `Cable ${fmtLen(c.d, units)} × ${fmtLen(c.len, units)} ${units}${used.length ? ` (${used.map((n) => turned[n]!.name).join(' + ')})` : ''}`;
    const replace = cablePartId !== null && parts.some((p) => p.partId === cablePartId) ? cablePartId : undefined;
    const hadTray = !!tray;
    const part = await geo.cable(name, bodies, replace, (fr, label) => showProgress(fr, label));
    parts = replace === undefined ? [...parts, part] : parts.map((p) => (p.partId === replace ? part : p));
    cablePartId = part.partId;
    hideProgress();
    refresh(replace === undefined);
    if (hadTray) generateTray();
    status.textContent += ` Whole part ${fmtDims(part.size, units)}.`;
    $('#cable-build').textContent = 'Update cable';
  } catch (e) {
    hideProgress();
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}

/** After a change: redraw the picture, and the 3D cable too once there is one. */
async function cableChanged() {
  if (cablePartId !== null && parts.some((p) => p.partId === cablePartId)) { await buildCable(); return; }
  const wrong = readCable();
  if (wrong) { $('#cable-status').textContent = wrong; return; }
  saveCable();
  try { await turnConnectors(); } catch (e) { $('#cable-status').textContent = e instanceof Error ? e.message : String(e); return; }
  fillCableEnd();
  previewCable();
}
$('#cable-build').addEventListener('click', buildCable);
($('#cable') as HTMLDetailsElement).addEventListener('toggle', () => { if (($('#cable') as HTMLDetailsElement).open) cableChanged(); });
document.querySelectorAll<HTMLButtonElement>('[data-cmir]').forEach((b) => b.addEventListener('click', () => {
  cable.mirror = b.dataset.cmir === '1';
  document.querySelectorAll<HTMLButtonElement>('[data-cmir]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  cableChanged();
}));
document.querySelectorAll<HTMLButtonElement>('[data-cend]').forEach((b) => b.addEventListener('click', () => {
  if (readCable()) { /* keep what was typed for the other end if it was valid; otherwise drop it */ }
  cableEnd = b.dataset.cend as Which;
  fillCableEnd();
  if (cableShown) drawCable(cableShown);
}));
document.querySelectorAll<HTMLButtonElement>('[data-cpre]').forEach((b) => b.addEventListener('click', () => {
  readCable();
  // Stay at the end of the coil this lead is at now.
  const end = (cableShown?.leads[cableEnd].junction[0] ?? -1) < 0 ? 'left' : 'right';
  const e = cable[cableEnd];
  cable[cableEnd] = { ...e, ...presetLead(b.dataset.cpre as LeadPreset, cableEnd === 'top', end, { wireD: cable.d, outerL: cable.l, outerW: cable.w, cornerR: cable.r, gap: DEFAULT_CABLE.gap }, b.dataset.cpre === 'middle' ? Math.min(e.length, 10) : e.length || 30) };
  fillCableEnd();
  cableChanged();
}));
$('#cable-flip').addEventListener('click', () => { readCable(); cable[cableEnd].at = (cable[cableEnd].at + 4) % 8; cableChanged(); });
($('#cable-conn') as HTMLSelectElement).addEventListener('change', (e) => {
  readCable();
  cable[cableEnd] = { ...cable[cableEnd], conn: (e.target as HTMLSelectElement).value, axis: null, roll: 0 };
  cableChanged();
});
// Turn: point a different side of the model along the cable. Roll: a quarter turn about the cable.
$('#cable-turn').addEventListener('click', async () => {
  const ch = cable[cableEnd];
  if (!ch.conn) return;
  try { ch.axis = ((ch.axis ?? defaultConnectorAxis(await connectorMesh(ch.conn))) + 1) % CONNECTOR_TURNS; } catch (e) { toast(e instanceof Error ? e.message : String(e)); return; }
  cableChanged();
});
$('#cable-roll').addEventListener('click', () => {
  if (!cable[cableEnd].conn) return;
  cable[cableEnd].roll = (cable[cableEnd].roll + 1) % CONNECTOR_ROLLS;
  cableChanged();
});
document.querySelectorAll<HTMLInputElement>('#cable input.num').forEach((i) => i.addEventListener('change', cableChanged));
fillCable();

$('#library-refresh').addEventListener('click', loadLibrary);
loadLibrary();

// When a new version of the app takes over, reload once so it is actually shown
// (otherwise the previous version stays on screen until the next visit).
// Work is saved automatically, so nothing is lost.
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    saveNow().finally(() => location.reload());
  });
}

$('#version').textContent = `Version ${__APP_VERSION__}`;
setUnits(units);
viewer.setParts([]);
openProject(projectName).then((found) => { if (!found) renderProjects(); });
cloudUser().then((u) => { if (u) $('#project-user').textContent = `Signed in as ${u}; projects saved here belong to that login.`; });
