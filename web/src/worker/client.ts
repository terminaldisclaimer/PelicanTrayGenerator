import type { Side, TrayOptions } from '../geom/tray';
import type { FileKind, ParsedPart, PoseAction, SavedPart, TrayInfo, WorkerRequest, WorkerResponse } from './protocol';

type Progress = (fraction: number, label: string) => void;
type Body = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Promise wrapper around the geometry worker. */
export class GeometryClient {
  private worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (p: any) => void; reject: (e: Error) => void; progress?: Progress }>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.progress?.(msg.fraction, msg.label);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.parts);
        else if (msg.type === 'tray') p.resolve(msg.tray);
        else if (msg.type === 'saved') p.resolve(msg.parts);
        else p.reject(new Error(msg.message));
      }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Geometry worker failed'));
      this.pending.clear();
    };
  }

  private call<T = ParsedPart[]>(body: Body, transfer: Transferable[] = [], progress?: Progress): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker.postMessage({ id, ...body } as WorkerRequest, transfer);
    });
  }

  parse(fileName: string, kind: FileKind, data: ArrayBuffer, progress?: Progress) {
    return this.call({ type: 'parse', fileName, kind, data }, [data], progress);
  }
  pose(partId: number, action: PoseAction) {
    return this.call({ type: 'pose', partId, action }).then((r) => r[0]);
  }
  poses(partId: number) {
    return this.call({ type: 'poses', partId });
  }
  select(partId: number, index: number) {
    return this.call({ type: 'select', partId, index }).then((r) => r[0]);
  }
  scale(partId: number, factor: number) {
    return this.call({ type: 'scale', partId, factor }).then((r) => r[0]);
  }
  finger(partId: number, fingers: Side[] | 'auto') {
    return this.call({ type: 'finger', partId, fingers }).then((r) => r[0]);
  }
  exportParts() {
    return this.call<SavedPart[]>({ type: 'export' });
  }
  restore(parts: SavedPart[], progress?: Progress) {
    return this.call({ type: 'restore', parts }, [], progress);
  }
  tray(options: TrayOptions, progress?: Progress) {
    return this.call<TrayInfo>({ type: 'tray', options }, [], progress);
  }
  remove(partId: number) {
    return this.call({ type: 'remove', partId });
  }
}
