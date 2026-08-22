import type { Ring } from '../../types';
import { roundedRect } from '../geom2d';
import { loft, type Solid } from './manifold';

/**
 * Stacking interface.
 *
 * The three-segment chamfer stack and the 0.5 mm cell clearance are taken
 * straight from the Gridfinity specification, which has years of field use
 * behind these exact numbers. Only the X/Y pitch is changed: 25 mm here
 * instead of Gridfinity's 42 mm. The Z profile is pitch-independent, so it
 * transfers unmodified.
 *
 * Cross-section of one registration cell, measured from the bottom of the
 * foot upwards, as an inset from the cell's widest width:
 *
 *   z = 0.00   inset 2.95   (bottom of foot)
 *   z = 0.80   inset 2.15   45 degree chamfer
 *   z = 2.60   inset 2.15   vertical
 *   z = 4.75   inset 0.00   45 degree chamfer, widest
 */
export const REG = {
  chamferLower: 0.8,
  straight: 1.8,
  chamferUpper: 2.15,
  /** Total height of the foot, and of the recess it drops into. */
  height: 4.75,
  /** pitch - (widest foot width). Gridfinity uses 0.5 mm. */
  cellGap: 0.5,
  /** Outer corner radius at the widest point of the profile. */
  cornerRadius: 3.0,
  cornerSegs: 6,
} as const;

/**
 * Wall thickness that fully preserves the perimeter lip. Pockets are kept at
 * least this far from the tray edge so the lip keeps its complete profile.
 */
export const LIP_BASE = REG.chamferLower + REG.chamferUpper; // 2.95

interface Step { z: number; inset: number }

const STEPS: Step[] = [
  { z: 0, inset: REG.chamferLower + REG.chamferUpper },
  { z: REG.chamferLower, inset: REG.chamferUpper },
  { z: REG.chamferLower + REG.straight, inset: REG.chamferUpper },
  { z: REG.height, inset: 0 },
];

function profileSolid(pitch: number, grow: number): Solid {
  const widest = pitch - REG.cellGap + 2 * grow;
  const sections = STEPS.map(({ z, inset }) => {
    const w = widest - 2 * inset;
    const r = Math.max(0.15, REG.cornerRadius + grow - inset);
    return { ring: roundedRect(w, w, r, REG.cornerSegs) as Ring, z };
  });
  return loft(sections);
}

/** The foot on the underside of a tray, centred on the origin, sitting on z = 0. */
export const footSolid = (pitch: number): Solid => profileSolid(pitch, 0);

/**
 * The recess cut into the top of a tray, centred on the origin, spanning
 * z = 0..REG.height. Grown by `tolerance` per side so feet drop in freely.
 * At the default 0.25 mm this makes the recess exactly one pitch wide at the
 * top, so adjacent cells meet at a knife edge - the same geometry a
 * Gridfinity baseplate uses between cells.
 */
export const socketSolid = (pitch: number, tolerance: number): Solid => profileSolid(pitch, tolerance);

/** Outer footprint of a tray that spans the given number of grid cells. */
export const trayFootprint = (cells: number, pitch: number) => cells * pitch - REG.cellGap;

/** Centre of grid cell `i` in tray-local coordinates. */
export const cellCentre = (i: number, pitch: number) => (i + 0.5) * pitch - REG.cellGap / 2;

/** Height a tray adds to the stack once its feet are seated in the tray below. */
export const stackPitch = (floor: number, pocketZone: number) => REG.height + floor + pocketZone;

/** Total printed height of a tray, including the ridges above its top plane. */
export const trayHeight = (floor: number, pocketZone: number) => stackPitch(floor, pocketZone) + REG.height;
