import type { TriMesh } from '../mesh/types';

export type FileKind = 'stl' | '3mf';

export type WorkerRequest =
  | { id: number; type: 'parse'; fileName: string; kind: FileKind; data: ArrayBuffer };

export interface ParsedPart {
  mesh: TriMesh;
  triangles: number;
  size: [number, number, number];
  suggestInches: boolean;
  large: boolean;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label: string }
  | { id: number; type: 'result'; parts: ParsedPart[] }
  | { id: number; type: 'error'; message: string };
