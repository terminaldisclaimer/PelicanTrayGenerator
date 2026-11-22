import './style.css';
import { Viewer, renderThumbnail } from './viewer';
import { initSheet } from './ui/sheet';
import { GeometryClient } from './worker/client';
import type { ParsedPart, FileKind, TrayInfo } from './worker/protocol';
import { DEFAULT_TRAY, fingerCentre, SIDES, type Side, type TrayOptions } from './geom/tray';
import { writeSTL } from './mesh/stl';
import { deleteProject, listProjects, loadProject, saveProject } from './storage';
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

/** Library names allow letters, digits, spaces and _.()+,- only. */
function libraryName(fileName: string): string {
  const m = /^(.*)\.(stl|3mf)$/i.exec(fileName);
  const base = (m ? m[1] : fileName).replace(/[^\w .()+,\-]/g, '_').trim().slice(0, 110) || 'part';
  return `${base}.${(m ? m[2] : 'stl').toLowerCase()}`;
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
      const pose = !p.poseLocked ? 'auto pose' : p.poseIndex >= 0 ? `pose ${p.poseIndex + 1} (locked)` : 'custom pose (locked)';
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
      const stackRow = document.createElement('div');
      stackRow.className = 'pose-row';
      stackRow.append(stack);
      li.append(stackRow);
      if (fingerOpen === p.partId) li.append(fingerPicker(p));

      if (picker?.partId === p.partId) {
        const grid = document.createElement('div');
        grid.className = 'pose-grid';
        const pick = (index: number) => { picker = null; update(p, geo.select(p.partId, index)); };
        const auto = document.createElement('button');
        auto.className = 'pose-option';
        auto.setAttribute('aria-pressed', String(!p.poseLocked));
        auto.innerHTML = '<span class="pose-auto">Auto</span><span>App decides</span><span class="muted">best use of tray</span>';
        auto.onclick = () => pick(-1);
        grid.append(auto);
        for (const o of picker.options) {
          const b = document.createElement('button');
          b.className = 'pose-option';
          b.setAttribute('aria-pressed', String(p.poseLocked && p.poseIndex === o.index));
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
interface TraySettings { length: number; width: number; height: number | null; gap: number; depth: number | null; clearance: number; split: number; fingerExtra: number; fingerSwept: boolean; stacking: boolean }
let traySettings: TraySettings = { length: 300, width: 200, height: null, gap: 1, depth: null, clearance: DEFAULT_TRAY.pocket.clearance, split: DEFAULT_TRAY.pocket.split, fingerExtra: 0, fingerSwept: true, stacking: true };
try { traySettings = { ...traySettings, ...JSON.parse(localStorage.getItem('tray') || '{}') }; } catch { /* ignore */ }
let tray: TrayInfo | null = null;
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
  return { length, width, height, gap, depth, clearance, split, fingerExtra, fingerSwept: traySettings.fingerSwept, stacking: traySettings.stacking };
}

function renderExport() {
  const list = $('#export-list');
  if (!tray) {
    list.replaceChildren();
    $('#export-status').textContent = 'Generate a tray first (Trays tab).';
    return;
  }
  const info = tray;
  list.replaceChildren(
    ...info.trays.map((t, i) => {
      const b = document.createElement('button');
      b.className = 'btn primary wide';
      b.textContent = info.trays.length === 1 ? 'Download STL' : `Download tray ${i + 1} STL`;
      b.onclick = () => {
        const name = `tray${info.trays.length === 1 ? '' : `-${i + 1}`}-${Math.round(info.length)}x${Math.round(info.width)}x${Math.round(t.depth)}.stl`;
        const url = URL.createObjectURL(new Blob([writeSTL({ name: 'tray', positions: t.mesh.positions })], { type: 'model/stl' }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      };
      return b;
    }),
  );
  $('#export-status').textContent = info.trays
    .map((t, i) => `Tray ${i + 1}: ${fmtDims([info.length, info.width, t.depth], units)}, ${(t.mesh.positions.length / 9).toLocaleString()} triangles.`)
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
  if (tray) viewer.setTrays(tray.trays, tray.width, parts, showPartsInTray);
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

async function generateTray() {
  const s = readTrayInputs();
  if (typeof s === 'string') { $('#tray-status').textContent = s; return; }
  traySettings = s;
  try { localStorage.setItem('tray', JSON.stringify(s)); } catch { /* private mode */ }
  scheduleSave();
  const options: TrayOptions = {
    ...DEFAULT_TRAY, length: s.length - 2 * s.gap, width: s.width - 2 * s.gap, depth: s.depth, maxDepth: s.height,
    fingerExtraDepth: s.fingerExtra, fingerSwept: s.fingerSwept, stacking: s.stacking,
    pocket: { ...DEFAULT_TRAY.pocket, clearance: s.clearance, split: s.split },
  };
  const btn = $<HTMLButtonElement>('#tray-build');
  btn.disabled = true;
  try {
    showProgress(0.02, 'Generating tray');
    const result = await geo.tray(options, showProgress);
    parts = result.parts; // Auto parts now lie the way the layout chose
    picker = null;
    tray = result;
    renderList();
    showTray();
    const n = result.trays.length, count = result.trays.reduce((c, t) => c + t.placements.length, 0);
    const volume = result.trays.reduce((v, t) => v + t.volume, 0);
    const stack = result.trays.reduce((v, t) => v + t.depth, 0);
    $('#tray-status').textContent =
      `${n === 1 ? '1 tray' : `${n} trays`} of ${fmtDims([result.length, result.width, 0], units).replace(/ × [\d.]+ (mm|in)$/, ' $1')}, ${count} pocket${count === 1 ? '' : 's'}. ` +
      result.trays.map((t, i) => `Tray ${i + 1}: ${t.placements.length} part${t.placements.length === 1 ? '' : 's'}, ${fmtLen(t.depth, units)} ${units} deep.`).join(' ') +
      stackNote(result) +
      ` About ${(volume / 1000).toFixed(0)} cm³ of material before infill.` +
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

async function saveNow() {
  try {
    const saved = await geo.exportParts();
    await saveProject({ name: projectName, savedAt: new Date().toISOString(), settings: { ...traySettings }, parts: saved });
    try { localStorage.setItem('project', projectName); } catch { /* private mode */ }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#project-status').textContent = `“${projectName}” — saved ${time} (${saved.length} part${saved.length === 1 ? '' : 's'}).`;
    $('#save-state').textContent = `${projectName} · saved ${time}`;
    return true;
    renderProjects();
  } catch (e) {
    $('#project-status').textContent = `Could not save: ${e instanceof Error ? e.message : e}`;
    $('#save-state').textContent = 'Could not save';
    return false;
  }
}

async function openProject(name: string) {
  const p = await loadProject(name);
  if (!p) return false;
  restoring = true;
  try {
    projectName = name;
    try { localStorage.setItem('project', name); } catch { /* private mode */ }
    traySettings = { ...traySettings, ...(p.settings as Partial<TraySettings>) };
    fillTrayInputs();
    picker = null; fingerOpen = null;
    if (p.parts.length) showProgress(0.02, `Opening “${name}”`);
    parts = await geo.restore(p.parts, showProgress);
    hideProgress();
    clearTray();
    viewer.setParts(parts);
    renderList();
    $('#project-status').textContent = `“${name}” — opened (${parts.length} part${parts.length === 1 ? '' : 's'}).`;
    $('#save-state').textContent = `${name} · saved`;
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
  let list: Awaited<ReturnType<typeof listProjects>> = [];
  try { list = await listProjects(); } catch { /* storage unavailable */ }
  $('#project-list').replaceChildren(
    ...list.map((it) => {
      const li = document.createElement('li');
      li.className = 'part';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.name + (it.name === projectName ? ' (open)' : '');
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${it.parts} part${it.parts === 1 ? '' : 's'} · ${new Date(it.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      if (it.name !== projectName) {
        const open = document.createElement('button');
        open.className = 'btn';
        open.textContent = 'Open';
        open.onclick = async () => { await saveNow(); openProject(it.name); };
        actions.append(open);
      }
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '🗑';
      del.setAttribute('aria-label', `Delete project ${it.name}`);
      del.onclick = async () => {
        if (!confirm(`Delete the saved project “${it.name}”? This cannot be undone.`)) return;
        await deleteProject(it.name);
        if (it.name === projectName) $('#project-status').textContent = 'Not saved yet.';
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
  const ok = await saveNow();
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

$('#version').textContent = `Version ${__APP_VERSION__}`;
setUnits(units);
viewer.setParts([]);
openProject(projectName).then((found) => { if (!found) renderProjects(); });
