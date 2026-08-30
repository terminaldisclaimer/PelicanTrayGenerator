import type { Settings, Project } from './types';

export const DEFAULT_SETTINGS: Settings = {
  cutoutLength: 430,
  cutoutWidth: 290,
  cutoutDepth: 155,

  // fit + 5: exactly 5 mm of TPU between the tool and the pocket wall
  // (3.95 solid backing + 1.05 rib crush zone), 10 mm tool-to-tool through
  // two insert walls.
  clearance: 5.15,
  rectPockets: true,
  insertSizeStep: 5,
  traceOffset: 0,

  wall: 3,
  floor: 3,

  caseFit: 0.5,

  gridPitch: 25,
  maxBed: 256,

  depthBucketTolerance: 5,
  stackTolerance: 0.25,

  thumbNotches: true,
  fingerNotchRadius: 9,
  allowRotation: true,

  generateInserts: true,
  insertFit: 0.15,
  insertWall: 3.95,
  insertPad: 5,
  insertSqueeze: 0.35,
  insertRibSpacing: 12,
  insertRibWidth: 5,
  insertGrip: 0.3,
  insertCoverage: 1,
};

export const emptyProject = (): Project => ({
  formatVersion: 1,
  name: 'Untitled case',
  settings: { ...DEFAULT_SETTINGS },
  parts: [],
  groups: [],
});
