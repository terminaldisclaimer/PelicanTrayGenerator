import type { LayoutData, Side, TrayOptions } from '../geom/tray';
import type { TriMesh } from '../mesh/types';
import type { FileKind, ParsedPart, PoseAction, SavedPart, ShellRequest, Suggestion, TrayInfo, WorkerRequest, WorkerResponse } from './protocol';

type Progress = (fraction: number, label: string, suggestion?: Suggestion) => void;
type Body = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Promise wrapper around the geometry worker. */
export class GeometryClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (p: any) => void; reject: (e: Error) => void; progress?: Progress }>();

  constructor() {
    this.start();
  }

  private start() {
    this.worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.progress?.(msg.fraction, msg.label, msg.suggestion);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.parts);
        else if (msg.type === 'tray') p.resolve(msg.tray);
        else if (msg.type === 'saved') p.resolve(msg.parts);
        else if (msg.type === 'suggestions') p.resolve({ list: msg.list, tried: msg.tried });
        else p.reject(new Error(msg.message));
      }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Geometry worker failed'));
      this.pending.clear();
    };
  }

  /**
   * Stop whatever the worker is doing by replacing it. Everything it held is
   * lost, so the caller must load the parts again (see `restore`).
   */
  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Stopped'));
    this.pending.clear();
    this.start();
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
  cable(name: string, bodies: TriMesh[], replace?: number, settings?: unknown, progress?: Progress, pinned = false) {
    return this.call({ type: 'cable', name, bodies, replace, settings, pinned }, [], progress).then((r) => r[0]);
  }
  body(partId: number, index: number, change: { on?: boolean; turn?: 'x90' | 'y90' | 'z90'; move?: [number, number, number]; reset?: boolean }) {
    return this.call({ type: 'body', partId, index, ...change }).then((r) => r[0]);
  }
  /** Break a multi-body part into one part per body; answers with every part now loaded. */
  split(partId: number) {
    return this.call({ type: 'split', partId });
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
  lock(partId: number, on: boolean) {
    return this.call({ type: 'lock', partId, on }).then((r) => r[0]);
  }
  stackGap(partId: number, gap: number | null) {
    return this.call({ type: 'stackgap', partId, gap }).then((r) => r[0]);
  }
  stackable(partId: number, on: boolean) {
    return this.call({ type: 'stackable', partId, on }).then((r) => r[0]);
  }
  exportParts() {
    return this.call<SavedPart[]>({ type: 'export' });
  }
  restore(parts: SavedPart[], progress?: Progress) {
    return this.call({ type: 'restore', parts }, [], progress);
  }
  suggest(options: TrayOptions, progress?: Progress) {
    return this.call<{ list: Suggestion[]; tried: number }>({ type: 'suggest', options }, [], progress);
  }
  tray(options: TrayOptions, shell: ShellRequest | null, progress?: Progress, layout?: LayoutData) {
    return this.call<TrayInfo>({ type: 'tray', options, shell, layout }, [], progress);
  }
  remove(partId: number) {
    return this.call({ type: 'remove', partId });
  }
}
