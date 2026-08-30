/** All lengths in millimetres. All angles in radians unless noted. */

export type Vec2 = [number, number];

/** A closed ring of points. First point is not repeated at the end. */
export type Ring = Vec2[];

/** A silhouette: ring[0] is the outer boundary, the rest are holes. */
export type Poly = Ring[];

export interface PartInput {
  id: string;
  name: string;
  /** Source silhouette in mm, normalised so its bounding box starts at (0,0). */
  poly: Poly;
  /** When false only poly[0] is used and interior holes are ignored. */
  keepHoles: boolean;
  /** Pocket depth = part height + margin, entered by the user. */
  depth: number;
  qty: number;
  /** Parts sharing a groupId are forced onto the same tray. */
  groupId: string | null;
  sourceFile: string;
  notes: string[];
  /**
   * Finger-notch pairs, one entry per placed copy that has notches. Positions
   * a/b are normalized arc-length along the pocket outline (0..1 from a
   * rotation-invariant canonical start), so they survive the solver moving or
   * rotating that copy.
   */
  fingerNotches: FingerNotchPair[];
  /**
   * Manual position overrides from the 2D editor, one per moved copy.
   * x/y is the pocket bounding box origin in tray-local mm, in the tray frame
   * the user saw when dragging.
   */
  placements: PlacementOverride[];

  /** Millimetres per SVG user unit that the parser applied to `poly`. */
  sourceUnitMm: number;
  /** User's correction, in millimetres per user unit. null keeps the parse. */
  unitOverrideMm: number | null;
  /** The parser had to guess the unit; the outline may be the wrong size. */
  unitsAmbiguous: boolean;
}

export interface Settings {
  /** Case cutout inner dimensions. length = X, width = Y, depth = Z. */
  cutoutLength: number;
  cutoutWidth: number;
  cutoutDepth: number;

  /** Single global outward offset applied around every part silhouette. */
  clearance: number;
  /**
   * Shrink every imported outline by this much per side before use, to cancel
   * the rim a tracing tool bakes into its export. 0 trusts outlines as drawn.
   */
  traceOffset: number;

  /** Tray wall thickness between pockets. */
  wall: number;
  /** Tray floor thickness beneath pockets (above the registration feet). */
  floor: number;

  /** Per-side gap between the outer tray assembly and the cutout walls. */
  caseFit: number;

  /** Footprint grid pitch. */
  gridPitch: number;
  /** Printer bed limit; trays wider than this are flagged. */
  maxBed: number;

  /** Parts whose depths differ by more than this may not share a layer. */
  depthBucketTolerance: number;
  /** Per-side clearance of the stacking recess over the foot. */
  stackTolerance: number;

  thumbNotches: boolean;
  /** Radius of the per-pocket finger notches placed in the 2D editor. */
  fingerNotchRadius: number;
  /** Allow parts to be rotated to their minimum-area orientation. */
  allowRotation: boolean;

  /* --- TPU liner inserts ------------------------------------------------ */

  /** Generate a printable TPU liner for every pocket. */
  generateInserts: boolean;
  /** Gap per side between the insert's outer wall and the pocket wall. */
  insertFit: number;
  /** Backing wall thickness of the insert. */
  insertWall: number;
  /** Floor pad the part rests on. */
  insertPad: number;
  /** How far a rib overlaps the part outline, i.e. how much it is squeezed. */
  insertSqueeze: number;
  /** Spacing of crush ribs measured along the pocket perimeter. */
  insertRibSpacing: number;
  /** Diameter of a crush rib. */
  insertRibWidth: number;
  /** Fraction of the pocket depth the insert walls rise to. */
  insertCoverage: number;
}

export interface Project {
  formatVersion: 1;
  name: string;
  settings: Settings;
  parts: PartInput[];
  groups: { id: string; name: string }[];
}

export interface PlacementOverride {
  /** Which placed copy of the part this override moves. */
  instance: number;
  x: number;
  y: number;
}

export interface FingerNotchPair {
  /** Which placed copy of the part this pair belongs to. */
  instance: number;
  /** Arc positions of the two notches, 0..1 around the pocket outline. */
  a: number;
  b: number;
}

/* ------------------------------------------------------------------ */
/* Solver output                                                       */
/* ------------------------------------------------------------------ */

export interface PlacedPart {
  partId: string;
  name: string;
  instance: number;
  /** Pocket outline (already offset by clearance) in tray-local mm. */
  poly: Poly;
  /** The part's own outline, concentric with `poly`, for liner generation. */
  rawPoly: Poly;
  /** Set when the clearance is too small to fit a liner in this pocket. */
  insertProblem?: string;
  /** Finger notches resolved to tray coordinates, with validity. */
  fingerNotches?: ResolvedNotch[];
  /** Where the packer put this copy, so a manual move can be reset. */
  packed?: { x: number; y: number };
  /** True when a manual override positioned this copy. */
  moved?: boolean;
  /** Why the manual position is unusable; blocks the tray's geometry. */
  placementProblem?: string;
  /** Depth of this pocket below the tray's stacking-recess floor. */
  depth: number;
  /** Rotation applied to the source silhouette, degrees CCW. */
  rotationDeg: number;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface ResolvedNotch {
  key: 'a' | 'b';
  /** Arc position along the pocket outline. */
  t: number;
  /** Centre in tray-local mm, on the pocket outline. */
  x: number;
  y: number;
  valid: boolean;
  reason?: string;
}

export interface TrayNotch {
  /** Centre of the scallop on the tray outline. */
  cx: number;
  cy: number;
  radius: number;
}

export interface Tray {
  id: string;
  name: string;
  cellsX: number;
  cellsY: number;
  /** Outer footprint (cells * pitch - cellGap). */
  sizeX: number;
  sizeY: number;
  /** Pocket-zone depth for this tray, after padding up to its layer. */
  pocketZone: number;
  /** Depth actually required by this tray's deepest part. */
  requiredDepth: number;
  /** Extra floor added to pad this tray up to its layer height. */
  padding: number;
  /** Total printed height including feet and stacking ridges. */
  height: number;
  parts: PlacedPart[];
  notches: TrayNotch[];
  /** Position within the case: layer index and grid cell offsets. */
  layer: number;
  cellX: number;
  cellY: number;
  z: number;
  oversize: boolean;
  /** A hand-placed finger notch collides; geometry and export are withheld. */
  blocked: boolean;
  warnings: string[];
}

export interface Layer {
  index: number;
  z: number;
  /** Stack pitch this layer contributes: feet + floor + pocket zone. */
  pitch: number;
  pocketZone: number;
  trays: Tray[];
  /** Fraction of the layer footprint covered by trays. */
  fill: number;
}

export interface SolveResult {
  layers: Layer[];
  trays: Tray[];
  unplaced: { partId: string; name: string; reason: string }[];
  warnings: string[];
  stats: {
    partCount: number;
    trayCount: number;
    layerCount: number;
    stackHeight: number;
    cutoutDepth: number;
    footprintFill: number;
    volumeFill: number;
    gridCellsX: number;
    gridCellsY: number;
  };
}
