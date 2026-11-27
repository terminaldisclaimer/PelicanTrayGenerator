/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { parseSTL } from '../mesh/stl';
import { parse3MF, read3MFMetadata } from '../mesh/threemf';
import { looksLikeInches, meshBounds, scaleMesh, LARGE_MESH_TRIANGLES, MAX_MESH_TRIANGLES } from '../mesh/bounds';
import type { TriMesh } from '../mesh/types';
import { initKernel } from '../geom/kernel';
import type { Manifold } from 'manifold-3d';
import { poseCandidates, posePart, toManifold, type PoseCandidate } from '../geom/analyze';
import { FLIP, IDENTITY, mul, ROT_X90, ROT_Y90, ROT_Z90, type Mat3 } from '../geom/vec';
import { autoFingers, buildFromLayout, buildTrays, distinctPoses, planTrays, TrayError, type Side, type TrayOptions, type TrayPart } from '../geom/tray';
import { buildShell, shellProblem, splitLiner } from '../geom/shell';
import type { ParsedPart, PoseAction, Suggestion, WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/** Originals stay in the worker so re-posing never re-sends the mesh. */
/** One body of a multi-body part: its mesh as it was in the file, and what has been done to it since. */
interface Body { name: string; positions: Float32Array; on: boolean; rot: Mat3; move: [number, number, number] }
interface Stored { bodies?: Body[]; cable?: unknown; pinned?: boolean; /** Where a pinned part's outline is centred, measured from the middle of its coil. */ pinnedAt?: [number, number]; original: TriMesh; candidates: PoseCandidate[]; rotation: Mat3; poseIndex: number; locked: boolean; fingers: Side[] | 'auto'; stackable: boolean; stackGap: number | null; inchesChecked: boolean }
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
    bodies: s.bodies?.map((b) => ({ name: b.name, on: b.on, rot: [...b.rot], move: [...b.move] as [number, number, number] })), cable: s.cable, pinned: s.pinned, pinnedAt: s.pinnedAt,
    suggestInches: !s.inchesChecked && looksLikeInches(meshBounds(s.original)),
    large: triangles > LARGE_MESH_TRIANGLES,
  };
}

/** The bodies of a part put together: each turned about its own middle and moved, those switched off left out. */
function compose(bodies: Body[]): Float32Array {
  const used = bodies.filter((b) => b.on);
  const out = new Float32Array(used.reduce((n, b) => n + b.positions.length, 0));
  let at = 0;
  for (const b of used) {
    const p = b.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) { const a = i % 3; if (p[i] < lo[a]) lo[a] = p[i]; if (p[i] > hi[a]) hi[a] = p[i]; }
    const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2), r = b.rot;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] - c[0], y = p[i + 1] - c[1], z = p[i + 2] - c[2];
      out[at++] = r[0] * x + r[1] * y + r[2] * z + c[0] + b.move[0];
      out[at++] = r[3] * x + r[4] * y + r[5] * z + c[1] + b.move[1];
      out[at++] = r[6] * x + r[7] * y + r[8] * z + c[2] + b.move[2];
    }
  }
  return out;
}

/** After a body changes: rebuild the part's mesh. A locked pose is kept; otherwise it lies however suits the new shape. */
async function recompose(s: Stored) {
  const k = await initKernel(wasmUrl);
  s.original = { name: s.original.name, positions: compose(s.bodies!) };
  if (s.original.positions.length === 0) throw new Error('A part needs at least one of its bodies switched on.');
  s.candidates = poseCandidates(k, s.original);
  if (s.locked) s.poseIndex = -1;
  else { s.poseIndex = 0; s.rotation = s.candidates[0].rotation; }
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
    if (!s.pinned && (!s.locked || ov.unlock)) poses = distinctPoses(s.candidates.map((c, i) => pose(i, c.rotation)).sort((a, b) => a.height - b.height || a.poseIndex - b.poseIndex));
    return {
      partId, name: s.original.name, poses,
      fingers: s.pinned ? [] : ov.fingers ?? s.fingers, stackable: s.pinned ? false : ov.allowStack ? true : s.stackable, stackGap: ov.clearGap ? null : s.stackGap, pinned: s.pinned, pinnedAt: s.pinnedAt,
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
      const out: ParsedPart[] = [];
      const cableNote = req.kind === '3mf' ? read3MFMetadata(req.data, 'CutoutsCable') : null;
      post({ id: req.id, type: 'progress', fraction: 0.4, label: `Finding resting pose: ${base}` });
      if (meshes.length === 1 || cableNote) {
        // One body, or a coiled cable saved from this app (cable and connectors, kept as they were built).
        const positions = meshes.length === 1 ? meshes[0].positions : compose(meshes.map((m) => ({ name: m.name, positions: m.positions, on: true, rot: IDENTITY, move: [0, 0, 0] })));
        const id = await add({ name: base, positions });
        if (cableNote) {
          const s = parts.get(id)!;
          try {
            const note = JSON.parse(cableNote);
            // A cable saved while coiled round the tray edge comes back pinned there (and is re-sized to the tray when one is generated).
            if (note?.wrap) { s.pinned = true; s.pinnedAt = Array.isArray(note.pinnedAt) ? note.pinnedAt : [0, 0]; }
            delete note.pinnedAt;
            s.cable = note;
          } catch { /* an unreadable note: it is still a part */ }
          s.rotation = IDENTITY; s.poseIndex = -1; s.locked = true; s.inchesChecked = true;
        }
        out.push(await describe(id));
      } else {
        // Several bodies: one part, put together the way the file has them. Each body can be changed later.
        const bodies: Body[] = meshes.map((m, i) => ({ name: m.name === base ? `Body ${i + 1}` : m.name, positions: m.positions, on: true, rot: IDENTITY, move: [0, 0, 0] }));
        const id = await add({ name: base, positions: compose(bodies) });
        const s = parts.get(id)!;
        s.bodies = bodies;
        // It starts the way up the file has it, since the bodies were arranged that way on purpose (untick Lock pose to let it be turned).
        s.rotation = IDENTITY; s.poseIndex = -1; s.locked = true;
        out.push(await describe(id));
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
    } else if (req.type === 'cable') {
      const k = await initKernel(wasmUrl);
      post({ id: req.id, type: 'progress', fraction: 0.3, label: 'Joining the cable and its connectors' });
      // One solid where the bodies are closed; otherwise the triangles side by side (pockets still follow them).
      const solids = req.bodies.map((b) => toManifold(k, b));
      let positions: Float32Array;
      if (solids.every((m) => m)) {
        const joined = solids.length === 1 ? solids[0]! : k.Manifold.union(solids as Manifold[]);
        const g = joined.getMesh(), v = g.vertProperties, t = g.triVerts, np = g.numProp;
        positions = new Float32Array(t.length * 3);
        for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = v[t[i] * np + c];
        if (solids.length > 1) joined.delete();
      } else {
        positions = new Float32Array(req.bodies.reduce((n, b) => n + b.positions.length, 0));
        let at = 0;
        for (const b of req.bodies) { positions.set(b.positions, at); at += b.positions.length; }
      }
      for (const m of solids) m?.delete();
      const old = req.replace !== undefined ? parts.get(req.replace) : undefined;
      const id = await add({ name: req.name, positions });
      const s = parts.get(id)!;
      // A coil only makes sense lying flat, the way it was built.
      s.rotation = IDENTITY; s.poseIndex = -1; s.locked = true; s.inchesChecked = true;
      s.cable = req.settings;
      s.pinned = req.pinned || undefined;
      if (s.pinned) {
        // The bodies are built round the coil's middle; the part is shown centred on its outline. Remember the difference.
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < positions.length; i += 3) { x0 = Math.min(x0, positions[i]); x1 = Math.max(x1, positions[i]); y0 = Math.min(y0, positions[i + 1]); y1 = Math.max(y1, positions[i + 1]); }
        s.pinnedAt = [(x0 + x1) / 2, (y0 + y1) / 2];
      }
      if (old) { s.fingers = old.fingers; s.stackable = old.stackable; s.stackGap = old.stackGap; parts.delete(req.replace!); }
      reply(req.id, [await describe(id)]);
    } else if (req.type === 'body') {
      const s = parts.get(req.partId), b = s?.bodies?.[req.index];
      if (!s || !b) throw new Error('Unknown part or body');
      const before = { on: b.on, rot: b.rot, move: b.move };
      if (req.reset) { b.on = true; b.rot = IDENTITY; b.move = [0, 0, 0]; }
      if (req.on !== undefined) b.on = req.on;
      if (req.turn) b.rot = mul(DELTA[req.turn], b.rot);
      if (req.move) b.move = req.move;
      try { await recompose(s); } catch (e) { Object.assign(b, before); await recompose(s); throw e; }
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'split') {
      const s = parts.get(req.partId);
      if (!s?.bodies) throw new Error('This part is a single body.');
      const made: number[] = [];
      for (const b of s.bodies.filter((x) => x.on)) made.push(await add({ name: `${s.original.name} · ${b.name}`, positions: compose([b]) }));
      parts.delete(req.partId);
      const out: ParsedPart[] = [];
      for (const id of parts.keys()) out.push(await describe(id));
      reply(req.id, out);
    } else if (req.type === 'scale') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      if (req.factor !== 1) {
        s.original = scaleMesh(s.original, req.factor);
        // The bodies are scaled too (about the origin, like the whole), and how far each was moved with them.
        for (const b of s.bodies ?? []) { b.positions = b.positions.map((v) => v * req.factor); b.move = b.move.map((v) => v * req.factor) as [number, number, number]; }
      }
      s.inchesChecked = true;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'export') {
      // Copies (not transfers): the worker keeps its meshes.
      const out = [...parts.values()].map((s) => ({
        name: s.original.name, positions: s.original.positions, poseIndex: s.poseIndex, locked: s.locked, rotation: [...s.rotation], fingers: s.fingers, stackable: s.stackable, stackGap: s.stackGap,
        cable: s.cable, pinned: s.pinned, pinnedAt: s.pinnedAt,
        ...(s.bodies ? (() => {
          const all = new Float32Array(s.bodies.reduce((n, b) => n + b.positions.length, 0));
          let at = 0;
          for (const b of s.bodies) { all.set(b.positions, at); at += b.positions.length; }
          return { bodies: s.bodies.map((b) => ({ name: b.name, on: b.on, rot: [...b.rot], move: b.move, floats: b.positions.length })), bodyPositions: all };
        })() : {}),
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
        s.cable = sp.cable;
        s.pinned = sp.pinned || undefined;
        s.pinnedAt = sp.pinnedAt;
        if (sp.bodies && sp.bodyPositions) {
          let at = 0;
          s.bodies = sp.bodies.map((b) => {
            const positions = sp.bodyPositions!.slice(at, at + b.floats);
            at += b.floats;
            return { name: b.name, positions, on: b.on, rot: (b.rot.length === 9 ? b.rot : IDENTITY) as Mat3, move: b.move };
          });
        }
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
