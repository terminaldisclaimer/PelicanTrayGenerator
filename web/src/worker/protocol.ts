import type { TriMesh } from '../mesh/types';
import type { Silhouette } from '../geom/analyze';
import type { Side, Tray, TrayOptions } from '../geom/tray';

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
  /** Choose which sides of the pocket get a finger cutout, or 'auto'. */
  | { id: number; type: 'finger'; partId: number; fingers: Side[] | 'auto' }
  /** Lock the part in its current pose (true), or let the layout turn it (false). */
  | { id: number; type: 'lock'; partId: number; on: boolean }
  /** Allow or forbid putting this part in a stack. */
  | { id: number; type: 'stackable'; partId: number; on: boolean }
  /** Everything needed to rebuild the current parts later (for saving). */
  | { id: number; type: 'export' }
  /** Replace all parts with previously saved ones. */
  | { id: number; type: 'restore'; parts: SavedPart[] }
  /** Arrange every loaded part into trays and cut the pockets. */
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
  /** Sides of the pocket that get a finger cutout in the current pose. */
  fingers: Side[];
  /** True while the app picks the cutouts (they then depend on the pose). */
  fingerAuto: boolean;
  /** False = this part is never put in a stack. */
  stackable: boolean;
  suggestInches: boolean;
  large: boolean;
}

/** Generated trays, plus every part as it now lies (Auto parts may have been re-posed). */
export interface TrayInfo { trays: Tray[]; stacks: number; length: number; width: number; parts: ParsedPart[] }

/** A part as stored in a saved project: its mesh in mm plus the user's choices. */
export interface SavedPart {
  name: string;
  positions: Float32Array;
  /** Index into the automatic pose list, and whether the user chose it. */
  poseIndex: number;
  locked: boolean;
  /** Rotation matrix (row-major 3×3), used when the pose is a custom one. */
  rotation: number[];
  fingers: Side[] | 'auto';
  stackable?: boolean;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label: string }
  | { id: number; type: 'result'; parts: ParsedPart[] }
  | { id: number; type: 'tray'; tray: TrayInfo }
  | { id: number; type: 'saved'; parts: SavedPart[] }
  /** `expected` = a problem to explain to the user (e.g. parts do not fit), not a bug. */
  | { id: number; type: 'error'; message: string; expected?: boolean };
