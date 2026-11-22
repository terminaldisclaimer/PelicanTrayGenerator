import type { TriMesh } from '../mesh/types';
import type { Silhouette } from '../geom/analyze';
import type { Placement, TrayOptions } from '../geom/tray';

export type FileKind = 'stl' | '3mf';
export type PoseAction = 'next' | 'x90' | 'y90' | 'z90' | 'flip';

export type WorkerRequest =
  | { id: number; type: 'parse'; fileName: string; kind: FileKind; data: ArrayBuffer }
  | { id: number; type: 'pose'; partId: number; action: PoseAction }
  /** All automatic poses of one part, for the picker. */
  | { id: number; type: 'poses'; partId: number }
  /** Pick automatic pose `index` (locks it), or index -1 to hand the choice back to the app. */
  | { id: number; type: 'select'; partId: number; index: number }
  | { id: number; type: 'scale'; partId: number; factor: number }
  | { id: number; type: 'remove'; partId: number }
  /** Build one tray holding every loaded part. */
  | { id: number; type: 'tray'; options: TrayOptions };

/** A part as posed on the bed: mesh in mm resting on z=0, plus its top-down outline. */
export interface ParsedPart {
  partId: number;
  mesh: TriMesh;
  triangles: number;
  size: [number, number, number];
  height: number;
  silhouette: Silhouette;
  silhouetteArea: number;
  solid: boolean;
  poseIndex: number; // which auto pose is active, or -1 after manual rotation
  poseCount: number;
  /** True once the user has chosen or adjusted the pose; the layout step may
   *  only re-orient parts whose pose is not locked. */
  poseLocked: boolean;
  suggestInches: boolean;
  large: boolean;
}

export interface TrayInfo { mesh: TriMesh; depth: number; placements: Placement[]; volume: number; length: number; width: number }

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label: string }
  | { id: number; type: 'result'; parts: ParsedPart[] }
  | { id: number; type: 'tray'; tray: TrayInfo }
  /** `expected` = a problem to explain to the user (e.g. parts do not fit), not a bug. */
  | { id: number; type: 'error'; message: string; expected?: boolean };
