/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { parseSTL } from '../mesh/stl';
import { parse3MF } from '../mesh/threemf';
import { looksLikeInches, meshBounds, scaleMesh, LARGE_MESH_TRIANGLES, MAX_MESH_TRIANGLES } from '../mesh/bounds';
import type { TriMesh } from '../mesh/types';
import { initKernel } from '../geom/kernel';
import { poseCandidates, posePart, type PoseCandidate } from '../geom/analyze';
import { FLIP, mul, ROT_X90, ROT_Y90, ROT_Z90, type Mat3 } from '../geom/vec';
import { buildTrays, TrayError, type TrayPart } from '../geom/tray';
import type { ParsedPart, PoseAction, WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/** Originals stay in the worker so re-posing never re-sends the mesh. */
interface Stored { original: TriMesh; candidates: PoseCandidate[]; rotation: Mat3; poseIndex: number; locked: boolean; finger: boolean; inchesChecked: boolean }
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
    poseIndex: candidate ?? s.poseIndex, poseCount: s.candidates.length, poseLocked: s.locked, finger: s.finger,
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
  parts.set(id, { original: mesh, candidates, rotation: candidates[0].rotation, poseIndex: 0, locked: false, finger: true, inchesChecked: false });
  return id;
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
    } else if (req.type === 'finger') {
      const s = parts.get(req.partId);
      if (!s) throw new Error('Unknown part');
      s.finger = req.on;
      reply(req.id, [await describe(req.partId)]);
    } else if (req.type === 'tray') {
      const k = await initKernel(wasmUrl);
      post({ id: req.id, type: 'progress', fraction: 0.01, label: 'Preparing parts' });
      // Locked parts keep their pose; parts on Auto offer their best few poses to the packer.
      const AUTO_POSES = 3;
      const list: TrayPart[] = [...parts].map(([partId, s]) => {
        const rotations: [number, Mat3][] = s.locked
          ? [[-1, s.rotation]]
          : s.candidates.slice(0, AUTO_POSES).map((c, i) => [i, c.rotation] as [number, Mat3]);
        return {
          partId, name: s.original.name, finger: s.finger,
          poses: rotations.map(([poseIndex, r]) => { const p = posePart(k, s.original, r); return { poseIndex, mesh: p.mesh, silhouette: p.silhouette, height: p.height }; }),
        };
      });
      const result = buildTrays(k, list, req.options, (fraction, label) => post({ id: req.id, type: 'progress', fraction, label }));
      // Auto parts take the pose the packer chose (still unlocked).
      for (const t of result.trays)
        for (const pl of t.placements) {
          const s = parts.get(pl.partId)!;
          if (!s.locked && pl.poseIndex >= 0) { s.poseIndex = pl.poseIndex; s.rotation = s.candidates[pl.poseIndex].rotation; }
        }
      const now: ParsedPart[] = [];
      for (const id of parts.keys()) now.push(await describe(id));
      post(
        { id: req.id, type: 'tray', tray: { trays: result.trays, length: req.options.length, width: req.options.width, parts: now } },
        [...result.trays.map((t) => t.mesh.positions.buffer as ArrayBuffer), ...now.map((p) => p.mesh.positions.buffer as ArrayBuffer)],
      );
    } else if (req.type === 'remove') {
      parts.delete(req.partId);
      reply(req.id, []);
    }
  } catch (e) {
    post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e), expected: e instanceof TrayError });
  }
};
