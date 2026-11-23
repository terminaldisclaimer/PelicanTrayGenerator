/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { parseSTL } from '../mesh/stl';
import { parse3MF } from '../mesh/threemf';
import { looksLikeInches, meshBounds, scaleMesh, LARGE_MESH_TRIANGLES, MAX_MESH_TRIANGLES } from '../mesh/bounds';
import type { TriMesh } from '../mesh/types';
import { initKernel } from '../geom/kernel';
import { poseCandidates, posePart, type PoseCandidate } from '../geom/analyze';
import { FLIP, mul, ROT_X90, ROT_Y90, ROT_Z90, type Mat3 } from '../geom/vec';
import { autoFingers, buildFromLayout, buildTrays, distinctPoses, planTrays, TrayError, type Side, type TrayOptions, type TrayPart } from '../geom/tray';
import { buildShell, shellProblem, splitLiner } from '../geom/shell';
import type { ParsedPart, PoseAction, Suggestion, WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/** Originals stay in the worker so re-posing never re-sends the mesh. */
interface Stored { original: TriMesh; candidates: PoseCandidate[]; rotation: Mat3; poseIndex: number; locked: boolean; fingers: Side[] | 'auto'; stackable: boolean; stackGap: number | null; inchesChecked: boolean }
const parts = new Map<number, Stored>();
let nextPartId = 1;

const DELTA: Record<Exclude<PoseAction, 'next'>, Mat3> = { x90: ROT_X90, y90: ROT_Y90, z90: ROT_Z90, flip: FLIP };

async function describe(partId: number, candidate?: number): Promise<ParsedPart> {
  const k = await initKernel(wasmUrl);
  const s = parts.get(partId)!;
  const posed = posePart(k, s.original, candidate === undefined ? s.rotation : s.candidates[candidate].rotation);
  const triangles = s.original.positions.length / 9;
  return {
    partId, ...posed, triangles,
    poseIndex: candidate ?? s.poseIndex, poseCount: s.candidates.length, poseLocked: s.locked,
    fingers: s.fingers === 'auto' ? autoFingers(posed.height) : s.fingers, fingerAuto: s.fingers === 'auto', stackable: s.stackable, stackGap: s.stackGap,
    suggestInches: !s.inchesChecked && looksLikeInches(meshBounds(s.original)),
    large: triangles > LARGE_MESH_TRIANGLES,
  };
}

async function add(mesh: TriMesh): Promise<number> {
  const k = await initKernel(wasmUrl);
  const triangles = mesh.positions.length / 9;
  if (triangles > MAX_MESH_TRIANGLES)
    throw new Error(`${mesh.name}: ${triangles.toLocaleString()} triangles exceeds the ${MAX_MESH_TRIANGLES.toLocaleString()} limit`);
  const candidates = poseCandidates(k, mesh);
  const id = nextPartId++;
  parts.set(id, { original: mesh, candidates, rotation: candidates[0].rotation, poseIndex: 0, locked: false, fingers: 'auto', stackable: true, stackGap: null, inchesChecked: false });
  return id;
}


/** What-if overrides for one part when testing a change. */
interface Override { unlock?: boolean; allowStack?: boolean; clearGap?: boolean; fingers?: Side[] }

/**
 * The loaded parts as the layout sees them. Locked parts keep their pose;
 * unlocked parts offer every 90° orientation that actually differs.
 */
async function trayParts(overrides = new Map<number, Override>(), omit = -1): Promise<TrayPart[]> {
  const k = await initKernel(wasmUrl);
  return [...parts].filter(([partId]) => partId !== omit).map(([partId, s]) => {
    const ov = overrides.get(partId) ?? {};
    const pose = (poseIndex: number, r: Mat3) => { const p = posePart(k, s.original, r); return { poseIndex, mesh: p.mesh, silhouette: p.silhouette, height: p.height, size: p.size }; };
    let poses = [pose(-1, s.rotation)];
    if (!s.locked || ov.unlock) poses = distinctPoses(s.candidates.map((c, i) => pose(i, c.rotation)).sort((a, b) => a.height - b.height || a.poseIndex - b.poseIndex));
    return {
      partId, name: s.original.name, poses,
      fingers: ov.fingers ?? s.fingers, stackable: ov.allowStack ? true : s.stackable, stackGap: ov.clearGap ? null : s.stackGap,
    };
  });
}

/**
 * Relax one rule at a time and report every change that gets everything into
 * one tray. Each trial is a full, thorough layout search; nothing is applied.
 */
async function suggest(id: number, base: TrayOptions): Promise<{ list: Suggestion[]; tried: number }> {
  const k = await initKernel(wasmUrl);
  const found: Suggestion[] = [];
  const o: TrayOptions = { ...base, searchEffort: 'thorough' };
  const normal = await trayParts();
  const nameOf = (partId: number) => parts.get(partId)!.original.name;
  const fits = (ps: TrayPart[], opts: TrayOptions): number | null => {
    try { const r = planTrays(k, ps, opts); return r.trays === 1 ? r.stacks : null; } catch { return null; }
  };
  type Trial = { label: string; run: () => Promise<Suggestion | null> | Suggestion | null };
  const trials: Trial[] = [];
  const mm = (v: number) => `${+v.toFixed(1)} mm`;

  // 0. No change at all, just the longest search.
  trials.push({ label: 'your settings as they are, with the longest search', run: () => {
    const st = fits(normal, { ...base, searchEffort: 'hard' });
    return st === null ? null : { text: 'No change needed: a longer search finds a one-tray layout with your settings as they are.', change: { kind: 'effort' }, stacks: st };
  } });

  // 1. Global settings, smallest change first; stop at the first value that works.
  const ladder = (label: string, values: number[], opts: (v: number) => TrayOptions, text: (v: number) => string, key: 'fingerDiameter' | 'depth' | 'stackGap' | 'clearance' | 'edge') => {
    let done = false;
    for (const v of values)
      trials.push({ label: `${label} ${mm(v)}`, run: () => {
        if (done) return null;
        const st = fits(normal, opts(v));
        if (st === null) return null;
        done = true;
        return { text: text(v), change: { kind: 'setting', key, value: v }, stacks: st };
      } });
  };
  const d = base.fingerDiameter;
  ladder('finger holes at', [d - 1, d - 2, d - 3, d - 4, d - 6, d - 8].filter((v) => v >= 10), (v) => ({ ...o, fingerDiameter: v }), (v) => `Finger holes ${mm(v)} across instead of ${mm(d)}.`, 'fingerDiameter');
  if (base.depth !== null) {
    const cap = base.maxDepth ?? base.depth + 12;
    const dep = base.depth;
    ladder('tray depth', [dep + 1, dep + 2, dep + 4, dep + 6, dep + 8, dep + 12].filter((v) => v <= cap + 1e-9), (v) => ({ ...o, depth: v }), (v) => `Tray ${mm(v)} deep instead of ${mm(dep)}.`, 'depth');
  }
  if (base.stackGap > 0) {
    const g = base.stackGap;
    ladder('gap between stacked parts', [g / 2, 0].filter((v, i, a) => a.indexOf(v) === i), (v) => ({ ...o, stackGap: v }), (v) => `Gap between stacked parts ${mm(v)} instead of ${mm(g)}.`, 'stackGap');
  }
  if (base.edge > 1.2) {
    const e = base.edge;
    ladder('tray edge thickness', [Math.max(1.2, e - 0.5), 1.2].filter((v, i, a) => v < e && a.indexOf(v) === i), (v) => ({ ...o, edge: v }), (v) => `Minimum tray thickness at the edge ${mm(v)} instead of ${mm(e)}.`, 'edge');
  }
  if (base.pocket.clearance > 0.3) {
    const c = base.pocket.clearance;
    ladder('clearance around parts', [0.3], (v) => ({ ...o, pocket: { ...o.pocket, clearance: v } }), (v) => `Clearance around parts ${mm(v)} instead of ${mm(c)} (a tighter fit).`, 'clearance');
  }
  if (!base.stacking)
    trials.push({ label: 'stacking switched on', run: () => {
      const st = fits(normal, { ...o, stacking: true });
      return st === null ? null : { text: 'Switch on "Stack parts if they don\'t all fit".', change: { kind: 'setting', key: 'stacking', value: true }, stacks: st };
    } });

  // 2. One part's own choices.
  for (const [partId, s] of parts) {
    const one = async (ov: Override) => fits(await trayParts(new Map([[partId, ov]])), o);
    if (s.locked)
      trials.push({ label: `${nameOf(partId)} with its pose unlocked`, run: async () => {
        const st = await one({ unlock: true });
        return st === null ? null : { text: `Untick "Lock pose" on ${nameOf(partId)}, so it can be turned.`, change: { kind: 'part', partId, change: 'unlock' }, stacks: st };
      } });
    if (!s.stackable && base.stacking)
      trials.push({ label: `${nameOf(partId)} allowed to stack`, run: async () => {
        const st = await one({ allowStack: true });
        return st === null ? null : { text: `Allow stacking on ${nameOf(partId)}.`, change: { kind: 'part', partId, change: 'allowStack' }, stacks: st };
      } });
    if (s.stackGap !== null && s.stackGap > base.stackGap)
      trials.push({ label: `${nameOf(partId)} without its own stacking gap`, run: async () => {
        const st = await one({ clearGap: true });
        return st === null ? null : { text: `Remove the ${mm(s.stackGap!)} "Gap when stacked" on ${nameOf(partId)} (it then uses the tray's ${mm(base.stackGap)}).`, change: { kind: 'part', partId, change: 'clearGap' }, stacks: st };
      } });
    const mine = normal.find((p) => p.partId === partId)!;
    const sides = s.fingers === 'auto' ? autoFingers(mine.poses[0].height) : s.fingers;
    if (sides.length >= 2)
      trials.push({ label: `${nameOf(partId)} with one finger hole`, run: async () => {
        const st = await one({ fingers: [sides[0]] });
        return st === null ? null : { text: `One finger hole instead of ${sides.length} on ${nameOf(partId)}.`, change: { kind: 'fingers', partId, fingers: [sides[0]] }, stacks: st };
      } });
  }

  // 3. Leaving one part out: smallest first, stop at the first that works.
  const bySize = [...normal].sort((a, b) => {
    const area = (p: TrayPart) => { const [w, h] = (p.poses[0] as unknown as { size: number[] }).size; return w * h; };
    return area(a) - area(b);
  });
  let left = false;
  for (const p of bySize)
    trials.push({ label: `everything except ${p.name}`, run: async () => {
      if (left || normal.length < 2) return null;
      const st = fits(await trayParts(new Map(), p.partId), o);
      if (st === null) return null;
      left = true;
      return { text: `Leave out ${p.name} (the smallest part whose removal makes the rest fit).`, change: { kind: 'remove', partId: p.partId }, stacks: st };
    } });

  for (let i = 0; i < trials.length; i++) {
    post({ id, type: 'progress', fraction: i / trials.length, label: `Trying ${i + 1} of ${trials.length}: ${trials[i].label}` });
    const sug = await trials[i].run();
    if (sug) {
      found.push(sug);
      post({ id, type: 'progress', fraction: (i + 1) / trials.length, label: `Found: ${sug.text}`, suggestion: sug });
      // Your settings already fit with a longer search: nothing needs relaxing.
      if (sug.change.kind === 'effort') return { list: found, tried: i + 1 };
    }
  }
  return { list: found, tried: trials.length };
}

const reply = (id: number, list: ParsedPart[]) =>
  post({ id, type: 'result', parts: list }, list.map((p) => p.mesh.positions.buffer as ArrayBuffer));

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'parse') {
      post({ id: req.id, type: 'progress', fraction: 0.1, label: `Reading ${req.fileName}` });
      const base = req.fileName.replace(/\.(stl|3mf)$/i, '');
      const meshes: TriMesh[] = req.kind === 'stl' ? [parseSTL(req.data, base)] : parse3MF(req.data, base);
      // Name parts after the file; add the body name only when a file has several.
      meshes.forEach((m, i) => (m.name = meshes.length === 1 ? base : `${base} · ${m.name === base ? i + 1 : m.name}`));
      const out: ParsedPart[] = [];
      for (let i = 0; i < meshes.length; i++) {
        post({ id: req.id, type: 'progress', fraction: 0.3 + (0.7 * i) / meshes.length, label: `Finding resting pose: ${meshes[i].name}` });
        out.push(await describe(await add(meshes[i])));
      }
      reply(req.id, out);
    } else if (req.type === 'pose') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      if (req.action === 'next') {
        s.poseIndex = (Math.max(s.poseIndex, -1) + 1) % s.candidates.length;
        s.rotation = s.candidates[s.poseIndex].rotation;
      } else {
        s.rotation = mul(DELTA[req.action], s.rotation);
        s.poseIndex = -1;
      }
      s.locked = true;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'poses') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      const out: ParsedPart[] = [];
      for (let i = 0; i < s.candidates.length; i++) out.push(await describe(req.partId, i));
      reply(req.id, out);
    } else if (req.type === 'select') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      s.locked = req.index >= 0;
      s.poseIndex = req.index >= 0 ? Math.min(req.index, s.candidates.length - 1) : 0;
      s.rotation = s.candidates[s.poseIndex].rotation;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'scale') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      if (req.factor !== 1) s.original = scaleMesh(s.original, req.factor);
      s.inchesChecked = true;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'export') {
      // Copies (not transfers): the worker keeps its meshes.
      const out = [...parts.values()].map((s) => ({
        name: s.original.name, positions: s.original.positions, poseIndex: s.poseIndex, locked: s.locked, rotation: [...s.rotation], fingers: s.fingers, stackable: s.stackable, stackGap: s.stackGap,
      }));
      post({ id: req.id, type: 'saved', parts: out });
    } else if (req.type === 'restore') {
      parts.clear();
      const out: ParsedPart[] = [];
      for (let i = 0; i < req.parts.length; i++) {
        const sp = req.parts[i];
        post({ id: req.id, type: 'progress', fraction: i / req.parts.length, label: `Opening ${sp.name}` });
        const id = await add({ name: sp.name, positions: sp.positions });
        const s = parts.get(id)!;
        s.inchesChecked = true;
        s.fingers = sp.fingers;
        s.stackable = sp.stackable !== false;
        s.stackGap = sp.stackGap ?? null;
        s.locked = sp.locked;
        if (sp.poseIndex >= 0 && sp.poseIndex < s.candidates.length) { s.poseIndex = sp.poseIndex; s.rotation = s.candidates[sp.poseIndex].rotation; }
        else if (sp.rotation.length === 9) { s.poseIndex = -1; s.rotation = sp.rotation as Mat3; }
        out.push(await describe(id));
      }
      reply(req.id, out);
    } else if (req.type === 'lock') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      s.locked = req.on;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'stackgap') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      s.stackGap = req.gap;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'stackable') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      s.stackable = req.on;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'finger') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      s.fingers = req.fingers;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'tray') {
      const k = await initKernel(wasmUrl);
      const shellError = req.shell ? shellProblem(req.shell.outer, req.shell.options) : null;
      if (shellError) throw new TrayError(shellError);
      post({ id: req.id, type: 'progress', fraction: 0.01, label: 'Preparing parts' });
      const list = await trayParts();
      const progress = (fraction: number, label: string) => post({ id: req.id, type: 'progress', fraction, label });
      const result = req.layout ? buildFromLayout(k, list, req.options, req.layout, progress) : buildTrays(k, list, req.options, progress);
      // Auto parts take the pose the packer chose (still unlocked).
      for (const t of result.trays)
        for (const pl of t.placements) {
          const s = parts.get(pl.partId)!;
          if (!s.locked && pl.poseIndex >= 0) { s.poseIndex = pl.poseIndex; s.rotation = s.candidates[pl.poseIndex].rotation; }
        }
      const now: ParsedPart[] = [];
      for (const id of parts.keys()) now.push(await describe(id));
      const sh = req.shell;
      if (sh?.liner && sh.options.gap > 0) throw new TrayError('The TPU liner is printed onto the shell, so the gap between tray and shell has to be 0.');
      const shells = sh ? result.trays.map((t, i) => {
        let core: TriMesh | null = null;
        if (sh.liner) {
          progress(0.98, `Splitting tray ${i + 1} into liner and rigid core`);
          const split = splitLiner(k, t.mesh, t.depth, sh.liner);
          t.mesh = split.liner; t.volume = split.volume; core = split.core;
        }
        return buildShell(k, sh.outer, t.depth, sh.options, `shell-${i + 1}`, t.lifts, core);
      }) : null;
      post(
        { id: req.id, type: 'tray', tray: { trays: result.trays, stacks: result.stacks, layout: result.layout, length: req.options.length, width: req.options.width, parts: now, shells } },
        [...result.trays.map((t) => t.mesh.positions.buffer as ArrayBuffer), ...now.map((p) => p.mesh.positions.buffer as ArrayBuffer), ...(shells ?? []).map((s) => s.mesh.positions.buffer as ArrayBuffer)],
      );
    } else if (req.type === 'suggest') {
      const r = await suggest(req.id, req.options);
      post({ id: req.id, type: 'suggestions', list: r.list, tried: r.tried });
    } else if (req.type === 'remove') {
      parts.delete(req.partId);
      reply(req.id, []);
    }
  } catch (e) {
    post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e), expected: e instanceof TrayError });
  }
};
