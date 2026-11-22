import './style.css';
import { Viewer, renderThumbnail } from './viewer';
import { initSheet } from './ui/sheet';
import { GeometryClient } from './worker/client';
import type { ParsedPart, FileKind, TrayInfo } from './worker/protocol';
import { DEFAULT_TRAY, fingerCentre, SIDES, type Side, type TrayOptions } from './geom/tray';
import { DEFAULT_SHELL, shellExtraHeight, shellPitch, shellProblem, trayInsideShell, type Footprint, type ShellOptions } from './geom/shell';
import { writeSTL } from './mesh/stl';
import { cloudDelete, cloudList, cloudLoad, cloudName, cloudSave, deleteProject, listProjects, loadProject, saveProject, type Project } from './storage';
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
const justUploaded = new Map<string, { name: string; size: number; uploaded: string; until: number }>();

/** The library's parts as last fetched; the list shows those not already in the project. */
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
    const res = await fetch(`/api/parts/${encodeURIComponent(libraryName(file.name))}`, { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream' } });
    if (res.ok) {
      // The library's listing can lag a minute behind an upload, so show the new part straight away.
      justUploaded.set(libraryName(file.name), { name: libraryName(file.name), size: buf.byteLength, uploaded: new Date().toISOString(), until: Date.now() + 120_000 });
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
  const clearance = traySettings.clearance, r = DEFAULT_TRAY.fingerDiameter / 2;
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
    ' Top-down view: tap + to add a cutout on that side, − to remove it. Depth and the swept shape are set on the Trays tab.';
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
      li.append(stackRow);
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
interface TraySettings { length: number; width: number; height: number | null; gap: number; depth: number | null; clearance: number; split: number; fingerExtra: number; fingerSwept: boolean; stacking: boolean; shell: boolean; shellWall: number; shellRim: number; shellPlug: number; shellGap: number }
let traySettings: TraySettings = { length: 300, width: 200, height: null, gap: 1, depth: null, clearance: DEFAULT_TRAY.pocket.clearance, split: DEFAULT_TRAY.pocket.split, fingerExtra: 0, fingerSwept: true, stacking: true, shell: true, shellWall: DEFAULT_SHELL.wall, shellRim: DEFAULT_SHELL.rim, shellPlug: DEFAULT_SHELL.plug, shellGap: DEFAULT_SHELL.gap };
try { traySettings = { ...traySettings, ...JSON.parse(localStorage.getItem('tray') || '{}') }; } catch { /* ignore */ }
let tray: TrayInfo | null = null;
/** Shell settings and outside footprint (tray + shell) used for the tray on screen; null = no shell. */
let trayShell: { outer: Footprint; options: ShellOptions } | null = null;
let showPartsInTray = true;

function fillTrayInputs() {
  num('#tray-length').value = fromMM(traySettings.length);
  num('#tray-width').value = fromMM(traySettings.width);
  num('#tray-height').value = traySettings.height == null ? '' : fromMM(traySettings.height);
  num('#tray-gap').value = fromMM(traySettings.gap);
  num('#tray-depth').value = traySettings.depth == null ? '' : fromMM(traySettings.depth);
  num('#tray-clearance').value = fromMM(traySettings.clearance);
  num('#tray-split').value = String(Math.round(traySettings.split * 100));
  num('#tray-finger-extra').value = fromMM(traySettings.fingerExtra);
  document.querySelectorAll<HTMLButtonElement>('[data-swept]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.swept === '1') === traySettings.fingerSwept)));
  document.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.stack === '1') === traySettings.stacking)));
  num('#shell-wall').value = fromMM(traySettings.shellWall);
  num('#shell-rim').value = fromMM(traySettings.shellRim);
  num('#shell-plug').value = fromMM(traySettings.shellPlug);
  num('#shell-gap').value = fromMM(traySettings.shellGap);
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
  const fingerExtra = toMM(val('#tray-finger-extra') || 0);
  if (!(fingerExtra >= 0 && fingerExtra <= 30)) return 'Finger hole extra depth must be between 0 and 30 mm.';
  const shell = traySettings.shell;
  // With the shell off its boxes are hidden, so keep whatever was set before.
  const sv = (id: string, old: number) => (shell ? toMM(val(id)) : old);
  const shellWall = sv('#shell-wall', traySettings.shellWall), shellRim = sv('#shell-rim', traySettings.shellRim), shellPlug = sv('#shell-plug', traySettings.shellPlug), shellGap = sv('#shell-gap', traySettings.shellGap);
  if (shell) {
    const o = shellOptions({ shellWall, shellRim, shellPlug, shellGap });
    if (![shellWall, shellRim, shellPlug, shellGap].every(Number.isFinite)) return 'Enter the shell wall, rim, bottom step and gap, or switch the shell off.';
    const problem = shellProblem({ length: length - 2 * gap, width: width - 2 * gap, cornerRadius: DEFAULT_TRAY.cornerRadius }, o);
    if (problem) return problem;
    if (height !== null && height - shellExtraHeight(o) <= DEFAULT_TRAY.floor) return `The case height leaves no room for a tray inside the shell (the shell alone takes ${fmtLen(shellExtraHeight(o), units)} ${units}).`;
  }
  return { length, width, height, gap, depth, clearance, split, fingerExtra, fingerSwept: traySettings.fingerSwept, stacking: traySettings.stacking, shell, shellWall, shellRim, shellPlug, shellGap };
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
  const button = (label: string, file: string, positions: () => Float32Array) => {
    const b = document.createElement('button');
    b.className = 'btn primary wide';
    b.textContent = label;
    b.onclick = () => {
      const url = URL.createObjectURL(new Blob([writeSTL({ name: file.split('-')[0], positions: positions() })], { type: 'model/stl' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${file}.stl`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    return b;
  };
  const size = (l: number, w: number, h: number) => `${Math.round(l)}x${Math.round(w)}x${Math.round(h)}`;
  list.replaceChildren(
    ...info.trays.flatMap((t, i) => {
      const n = one ? '' : `-${i + 1}`;
      const out = [button(one ? (info.shells ? 'Download tray STL' : 'Download STL') : `Download tray ${i + 1} STL`, `tray${n}-${size(info.length, info.width, t.depth)}`, () => t.mesh.positions)];
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
  if (!tray) return;
  tray = null;
  viewer.setTrays(null);
  $('#tray-view-row').hidden = true;
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

/** Pocket-to-tray-edge margin (mm) when the tray sits in a shell. */
const SHELL_EDGE = 1.2;

async function generateTray() {
  const s = readTrayInputs();
  if (typeof s === 'string') { $('#tray-status').textContent = s; return; }
  traySettings = s;
  try { localStorage.setItem('tray', JSON.stringify(s)); } catch { /* private mode */ }
  scheduleSave();
  // The case sets the outside size. With a shell, the tray is what is left inside it.
  const outer: Footprint = { length: s.length - 2 * s.gap, width: s.width - 2 * s.gap, cornerRadius: DEFAULT_TRAY.cornerRadius };
  const shell = s.shell ? { outer, options: shellOptions(s) } : null;
  const inside = shell ? trayInsideShell(outer, shell.options) : outer;
  const options: TrayOptions = {
    ...DEFAULT_TRAY, ...inside, depth: s.depth,
    // Inside a rigid shell the tray needs no thick edge of its own: the shell is the outer wall.
    edge: shell ? SHELL_EDGE : DEFAULT_TRAY.edge,
    maxDepth: s.height === null ? null : s.height - (shell ? shellExtraHeight(shell.options) : 0),
    fingerExtraDepth: s.fingerExtra, fingerSwept: s.fingerSwept, stacking: s.stacking,
    pocket: { ...DEFAULT_TRAY.pocket, clearance: s.clearance, split: s.split },
  };
  const btn = $<HTMLButtonElement>('#tray-build');
  btn.disabled = true;
  try {
    showProgress(0.02, 'Generating tray');
    const result = await geo.tray(options, shell, showProgress);
    trayShell = shell;
    parts = result.parts; // Auto parts now lie the way the layout chose
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
      ` About ${(volume / 1000).toFixed(0)} cm³ of material before infill` + (so ? `, plus ${(shellVolume / 1000).toFixed(0)} cm³ for the shell.` : '.') +
      (s.height !== null && stack > s.height + 1e-6 ? ` Note: stacked, the trays are ${fmtLen(stack, units)} ${units} tall — more than the case height of ${fmtLen(s.height, units)} ${units}.` : n > 1 ? ` Stacked height ${fmtLen(stack, units)} ${units}.` : '');
    $('#tray-view-row').hidden = false;
    renderExport();
  } catch (e) {
    $('#tray-status').textContent = e instanceof Error ? e.message : String(e);
  } finally {
    hideProgress();
    btn.disabled = false;
  }
}
$('#tray-build').addEventListener('click', generateTray);

document.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((b) =>
  b.addEventListener('click', () => {
    traySettings.stacking = b.dataset.stack === '1';
    document.querySelectorAll<HTMLButtonElement>('[data-stack]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
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
async function uploadProject() {
  clearTimeout(cloudTimer);
  if (!lastProject) return;
  const p = lastProject;
  const ok = await cloudSave(p);
  if (p === lastProject) {
    const time = new Date(p.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#save-state').textContent = ok ? `${p.name} · saved ${time} · synced` : `${p.name} · saved ${time} on this device only`;
  }
  if (ok) renderProjects();
}

async function saveNow(uploadNow = false) {
  try {
    const saved = await geo.exportParts();
    const project: Project = { name: projectName, savedAt: new Date().toISOString(), settings: { ...traySettings }, parts: saved };
    await saveProject(project);
    lastProject = project;
    try { localStorage.setItem('project', projectName); } catch { /* private mode */ }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#project-status').textContent = `“${projectName}” — saved ${time} (${saved.length} part${saved.length === 1 ? '' : 's'}).`;
    $('#save-state').textContent = `${projectName} · saved ${time}`;
    clearTimeout(cloudTimer);
    if (uploadNow) await uploadProject();
    else cloudTimer = window.setTimeout(uploadProject, 2500);
    renderProjects();
    return true;
  } catch (e) {
    $('#project-status').textContent = `Could not save: ${e instanceof Error ? e.message : e}`;
    $('#save-state').textContent = 'Could not save';
    return false;
  }
}

/** Open a project from this device or the cloud, whichever copy is newer. */
async function openProject(name: string) {
  let p: Project | null | undefined = await loadProject(name).catch(() => undefined);
  const cloud = (await cloudList())?.find((c) => c.name === cloudName(name));
  if (cloud && (!p || (cloud.savedAt ?? '') > p.savedAt)) p = (await cloudLoad(name)) ?? p;
  if (!p) return false;
  restoring = true;
  try {
    projectName = p.name || name;
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
    $('#project-status').textContent = `“${projectName}” — opened (${parts.length} part${parts.length === 1 ? '' : 's'}).`;
    $('#save-state').textContent = `${projectName} · saved`;
  } catch (e) {
    hideProgress();
    toast(`Could not open “${name}”: ${e instanceof Error ? e.message : e}`);
  } finally {
    restoring = false;
  }
  renderProjects();
  return true;
}

async function renderProjects() {
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
  const ok = await saveNow(true);
  btn.textContent = ok ? 'Saved ✓' : 'Failed';
  setTimeout(() => (btn.textContent = 'Save'), 1500);
});

$('#project-save-as').addEventListener('click', async () => {
  const name = prompt('Save this project as:', projectName)?.trim();
  if (!name) return;
  projectName = name.slice(0, 60);
  await saveNow();
});

$('#project-new').addEventListener('click', async () => {
  const name = prompt('Name for the new project:', 'New tray')?.trim();
  if (!name) return;
  await saveNow(); // keep the current one
  projectName = name.slice(0, 60);
  for (const p of parts) geo.remove(p.partId);
  parts = [];
  picker = null; fingerOpen = null;
  refresh();
  await saveNow();
});

// ---------- library (parts uploaded to this site, e.g. by the Fusion script) ----------
interface LibraryItem { name: string; size?: number; uploaded?: string; version?: string }

async function loadLibrary() {
  let items: LibraryItem[];
  try {
    const res = await fetch('/api/parts', { headers: { accept: 'application/json' } });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return; // no API (dev) or signed out
    items = await res.json();
  } catch { return; } // offline
  for (const [name, it] of justUploaded) {
    if (items.some((x) => x.name === name) || Date.now() > it.until) justUploaded.delete(name);
    else items.push({ name, size: it.size, uploaded: it.uploaded });
  }
  libraryItems = items.sort((a, b) => a.name.localeCompare(b.name));
  renderLibrary();
}

/** List the library parts that are not in the project; a part comes back when it is removed from the project. */
function renderLibrary() {
  if (!libraryItems) return;
  const items = libraryItems.filter((it) => !inProject(it.name));
  $('#library').hidden = false;
  $('#library-empty').hidden = items.length > 0;
  $('#library-empty').textContent = libraryItems.length
    ? 'Every part in your library is already in this project.'
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
          await addFiles([new File([await res.blob()], it.name)], true);
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
