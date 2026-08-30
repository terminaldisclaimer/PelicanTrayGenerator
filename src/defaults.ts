import type { Settings, Project } from './types';

export const DEFAULT_SETTINGS: Settings = {
  cutoutLength: 430,
  cutoutWidth: 290,
  cutoutDepth: 155,

  clearance: 6.2,
  traceOffset: 0,

  wall: 2,
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
  insertWall: 5,
  insertPad: 2,
  insertSqueeze: 0.35,
  insertRibSpacing: 12,
  insertCoverage: 1,
};

export const emptyProject = (): Project => ({
  formatVersion: 1,
  name: 'Untitled case',
  settings: { ...DEFAULT_SETTINGS },
  parts: [],
  groups: [],
});
