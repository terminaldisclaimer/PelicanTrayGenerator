import type { FileKind, ParsedPart, WorkerRequest, WorkerResponse } from './protocol';

type Progress = (fraction: number, label: string) => void;

/** Promise wrapper around the geometry worker. */
export class GeometryClient {
  private worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (p: ParsedPart[]) => void; reject: (e: Error) => void; progress?: Progress }>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.progress?.(msg.fraction, msg.label);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.parts);
        else p.reject(new Error(msg.message));
      }
    };
  }

  parse(fileName: string, kind: FileKind, data: ArrayBuffer, progress?: Progress): Promise<ParsedPart[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      const req: WorkerRequest = { id, type: 'parse', fileName, kind, data };
      this.worker.postMessage(req, [data]);
    });
  }
}
