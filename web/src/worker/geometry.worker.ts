/// <reference lib="webworker" />
import { parseSTL } from '../mesh/stl';
import { parse3MF } from '../mesh/threemf';
import { centerOnBed, looksLikeInches, meshBounds, size, LARGE_MESH_TRIANGLES, MAX_MESH_TRIANGLES } from '../mesh/bounds';
import type { TriMesh } from '../mesh/types';
import type { ParsedPart, WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'parse') {
      post({ id: req.id, type: 'progress', fraction: 0.1, label: `Reading ${req.fileName}` });
      const base = req.fileName.replace(/\.(stl|3mf)$/i, '');
      const meshes: TriMesh[] = req.kind === 'stl' ? [parseSTL(req.data, base)] : parse3MF(req.data, base);
      post({ id: req.id, type: 'progress', fraction: 0.7, label: 'Analysing mesh' });
      const parts: ParsedPart[] = meshes.map((m) => {
        const triangles = m.positions.length / 9;
        if (triangles > MAX_MESH_TRIANGLES)
          throw new Error(`${m.name}: ${triangles.toLocaleString()} triangles exceeds the ${MAX_MESH_TRIANGLES.toLocaleString()} limit`);
        const centred = centerOnBed(m);
        const b = meshBounds(centred);
        return { mesh: centred, triangles, size: size(b), suggestInches: looksLikeInches(b), large: triangles > LARGE_MESH_TRIANGLES };
      });
      post({ id: req.id, type: 'result', parts }, parts.map((p) => p.mesh.positions.buffer as ArrayBuffer));
    }
  } catch (e) {
    post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
