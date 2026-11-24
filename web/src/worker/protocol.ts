import type { TriMesh } from '../mesh/types';
import type { Silhouette } from '../geom/analyze';
import type { LayoutData, Side, Tray, TrayOptions } from '../geom/tray';
import type { Footprint, Shell, ShellOptions } from '../geom/shell';

export type FileKind = 'stl' | '3mf';
export type PoseAction = 'next' | 'x90' | 'y90' | 'z90' | 'flip';

export type WorkerRequest =
  | { id: number; type: 'parse'; fileName: string; kind: FileKind; data: ArrayBuffer }
  /** Add a part made of several bodies joined into one (a coiled cable and its connectors), lying as built. `replace` swaps it for an earlier one. */
  | { id: number; type: 'cable'; name: string; bodies: TriMesh[]; replace?: number }
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
  /** Room to leave around this part when stacked (mm), or null to use the tray's setting. */
  | { id: number; type: 'stackgap'; partId: number; gap: number | null }
  /** Allow or forbid putting this part in a stack. */
  | { id: number; type: 'stackable'; partId: number; on: boolean }
  /** Everything needed to rebuild the current parts later (for saving). */
  | { id: number; type: 'export' }
  /** Replace all parts with previously saved ones. */
  | { id: number; type: 'restore'; parts: SavedPart[] }
  /** Try relaxing one rule at a time and report which changes let everything fit one tray. */
  | { id: number; type: 'suggest'; options: TrayOptions }
  /** Arrange every loaded part into trays and cut the pockets. */
  | { id: number; type: 'tray'; options: TrayOptions; shell?: ShellRequest | null; /** Cut this saved arrangement instead of searching for one. */ layout?: LayoutData };

/** A rigid shell to build around every tray: `outer` is the footprint of tray + shell. */
export interface ShellRequest { outer: Footprint; options: ShellOptions; /** Soft liner thickness (mm): the rest of the tray is printed rigid with the shell. Omitted = whole tray soft. */ liner?: number }

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
  /** This part's own stacking gap in mm, or null when it uses the tray's setting. */
  stackGap: number | null;
  suggestInches: boolean;
  large: boolean;
}

/** Generated trays, plus every part as it now lies (Auto parts may have been re-posed). */
export interface TrayInfo {
  trays: Tray[]; stacks: number; length: number; width: number; parts: ParsedPart[];
  /** The arrangement, for saving with the project. */
  layout: LayoutData;
  /** One shell per tray (same order), or null when no shell was asked for. */
  shells: Shell[] | null;
}

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
  stackGap?: number | null;
}

/** One change that would let everything fit in a single tray. */
export type Change =
  | { kind: 'effort' }
  | { kind: 'setting'; key: 'fingerDiameter' | 'depth' | 'stackGap' | 'clearance' | 'edge' | 'stacking'; value: number | boolean }
  | { kind: 'part'; partId: number; change: 'unlock' | 'allowStack' | 'clearGap' }
  | { kind: 'fingers'; partId: number; fingers: Side[] }
  | { kind: 'remove'; partId: number };
export interface Suggestion {
  /** What to change, in plain words. */
  text: string;
  change: Change;
  /** Parts that end up stacked with this change. */
  stacks: number;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label: string; suggestion?: Suggestion }
  | { id: number; type: 'suggestions'; list: Suggestion[]; tried: number }
  | { id: number; type: 'result'; parts: ParsedPart[] }
  | { id: number; type: 'tray'; tray: TrayInfo }
  | { id: number; type: 'saved'; parts: SavedPart[] }
  /** `expected` = a problem to explain to the user (e.g. parts do not fit), not a bug. */
  | { id: number; type: 'error'; message: string; expected?: boolean };
