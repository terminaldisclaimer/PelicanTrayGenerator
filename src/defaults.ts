import type { Settings, Project } from './types';

export const DEFAULT_SETTINGS: Settings = {
  cutoutLength: 430,
  cutoutWidth: 290,
  cutoutDepth: 155,

  clearance: 2,

  wall: 2,
  floor: 3,

  caseFit: 0.5,

  gridPitch: 25,
  maxBed: 256,

  depthBucketTolerance: 5,
  stackTolerance: 0.25,

  thumbNotches: true,
  allowRotation: true,
};

export const emptyProject = (): Project => ({
  formatVersion: 1,
  name: 'Untitled case',
  settings: { ...DEFAULT_SETTINGS },
  parts: [],
  groups: [],
});
