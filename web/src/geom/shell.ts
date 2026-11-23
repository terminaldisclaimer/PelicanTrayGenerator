import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { TriMesh } from '../mesh/types';
import { toManifold } from './analyze';
import { BED, liftBore, TrayError, type LiftHole } from './tray';

/**
 * Rigid PLA/PETG shell around a tray.
 *
 * Seen from the side (one wall; the tray sits in the cup):
 *
 *        |##|                 <- rim: stands `rim` above the tray top
 *        |##|  tray top
 *        |##|[ tray ........
 *        |##|[ .............
 *        |#################   <- floor (`floor` thick, full footprint)
 *            |#############   <- step: `plug` tall, set in by wall + fit
 *
 * Stacked, the step of the tray above drops `plug` deep into the recess the
 * rim makes, so trays cannot slide off each other. The shell's outside is the
 * footprint that has to fit the case; the tray inside is smaller by the wall.
 */
export interface ShellOptions {
  /** Wall thickness (mm). */
  wall: number;
  /** How far the wall stands above the tray top (mm). */
  rim: number;
  /** Height of the step under the floor, which drops into the rim of the tray below (mm). */
  plug: number;
  /** Floor under the tray (mm). It joins the step to the walls. */
  floor: number;
  /** Play between the step and the rim it drops into, per side (mm). */
  fit: number;
  /** Space between the tray and the shell wall, per side (mm). 0 = printed as one piece. */
  gap: number;
}

export const DEFAULT_SHELL: ShellOptions = { wall: 3, rim: 4, plug: 2, floor: 1, fit: 0.3, gap: 0 };

/** Outside footprint of tray + shell: what has to fit in the case. */
export interface Footprint { length: number; width: number; cornerRadius: number }

/** Footprint left for the tray inside the shell. */
export function trayInsideShell(outer: Footprint, s: ShellOptions): Footprint {
  const inset = s.wall + s.gap;
  return { length: outer.length - 2 * inset, width: outer.width - 2 * inset, cornerRadius: Math.max(0, outer.cornerRadius - inset) };
}

/** Height the shell adds to one tray standing on its own. */
export const shellExtraHeight = (s: ShellOptions) => s.plug + s.floor + s.rim;
/** Height each tray takes up in a stack (the step sits inside the rim below). */
export const shellPitch = (trayDepth: number, s: ShellOptions) => s.floor + trayDepth + s.rim;

/** A reason these shell settings cannot be built, or null. */
export function shellProblem(outer: Footprint, s: ShellOptions): string | null {
  if (!(s.wall >= 1.2 && s.wall <= 15)) return 'Shell wall must be between 1.2 and 15 mm.';
  if (!(s.rim >= 0 && s.rim <= 30)) return 'Shell rim height must be between 0 and 30 mm.';
  if (!(s.plug >= 0 && s.plug <= s.rim)) return 'The shell\'s bottom step cannot be taller than the rim it drops into.';
  if (!(s.floor >= 0.4 && s.floor <= 10)) return 'Shell floor must be between 0.4 and 10 mm.';
  if (!(s.fit >= 0 && s.fit <= 2)) return 'Shell fit must be between 0 and 2 mm.';
  if (!(s.gap >= 0 && s.gap <= 2)) return 'Gap between tray and shell must be between 0 and 2 mm.';
  const fitsBed = (outer.length <= BED.x && outer.width <= BED.y) || (outer.length <= BED.y && outer.width <= BED.x);
  if (!fitsBed) return `A ${outer.length.toFixed(1)} × ${outer.width.toFixed(1)} mm shell does not fit the ${BED.x} × ${BED.y} mm print bed.`;
  const inside = trayInsideShell(outer, s);
  if (inside.length < 20 || inside.width < 20) return 'The case is too small for a tray inside a shell this thick.';
  return null;
}

export interface Shell {
  /** In the tray's coordinates: tray bottom at z = 0, so the shell starts below zero. */
  mesh: TriMesh;
  /** Total height, step included. */
  height: number;
  /** How far the shell reaches below the tray bottom (floor + step). */
  below: number;
  volume: number;
}

/**
 * Build the shell for a tray `trayDepth` deep. `outer` is the footprint of tray + shell.
 * `core` is rigid filling that stands on the shell floor inside the cup (see splitLiner); it is printed as part of the shell.
 * `holes` are the tray's lift-out grips (tray coordinates): their side holes carry on out through the wall.
 */
export function buildShell(k: ManifoldToplevel, outer: Footprint, trayDepth: number, s: ShellOptions, name = 'shell', holes: LiftHole[] = [], core: TriMesh | null = null): Shell {
  const problem = shellProblem(outer, s);
  if (problem) throw new TrayError(problem);
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  try {
    const rounded = (length: number, width: number, radius: number) => {
      const r = Math.max(0, Math.min(radius, length / 2 - 1, width / 2 - 1));
      const core = keep(k.CrossSection.square([length - 2 * r, width - 2 * r], true));
      return r > 0 ? keep(core.offset(r, 'Round', 2, 32)) : core;
    };
    const outline = rounded(outer.length, outer.width, outer.cornerRadius);
    // The cup the tray sits in; above the tray it is the recess the next tray's step drops into.
    const cup = rounded(outer.length - 2 * s.wall, outer.width - 2 * s.wall, outer.cornerRadius - s.wall);
    const top = trayDepth + s.rim;
    let solid: Manifold = keep(keep(outline.extrude(s.floor + top)).translate(0, 0, -s.floor));
    solid = keep(solid.subtract(keep(cup.extrude(top + 1))));
    if (s.plug > 0) {
      const step = s.fit > 0 ? keep(cup.offset(-s.fit, 'Round', 2, 32)) : cup;
      solid = keep(solid.add(keep(keep(step.extrude(s.plug)).translate(0, 0, -s.floor - s.plug))));
    }
    if (core) { const c = toManifold(k, core); if (c) solid = keep(solid.add(keep(c))); }
    for (const h of holes) solid = keep(solid.subtract(liftBore(k, h, h.z ?? trayDepth / 2, keep)));
    if (solid.isEmpty()) throw new Error('Shell geometry came out empty');
    const mesh = solid.getMesh();
    const v = mesh.vertProperties, t = mesh.triVerts, np = mesh.numProp;
    const positions = new Float32Array(t.length * 3);
    for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = v[t[i] * np + c];
    return { mesh: { name, positions }, height: s.plug + s.floor + top, below: s.floor + s.plug, volume: solid.volume() };
  } finally {
    for (const t of trash) t.delete();
  }
}

/**
 * Split a tray into a soft liner and a rigid core, to print less of the soft
 * material: the liner is everything within `thickness` of a pocket, finger
 * hole or the top face; the core is what is left, deep inside, and is printed
 * with the shell. Where the tray has less than `thickness` of material (thin
 * floors, walls between close pockets) it all stays liner.
 *
 * Worked in horizontal slabs: at each height the open space of the tray (at
 * that height and up to `thickness` above and below it) is grown sideways by
 * `thickness`, and the core is what that does not reach. Never thinner than
 * asked; up to about 1.4× in corners.
 */
export function splitLiner(k: ManifoldToplevel, trayMesh: TriMesh, depth: number, thickness: number, step = 1): { liner: TriMesh; volume: number; core: TriMesh | null; coreVolume: number } {
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => { trash.push(x); return x; };
  const mesh = (m: Manifold, name: string): TriMesh => {
    const g = m.getMesh(), v = g.vertProperties, t = g.triVerts, np = g.numProp;
    const positions = new Float32Array(t.length * 3);
    for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = v[t[i] * np + c];
    return { name, positions };
  };
  try {
    const tray = toManifold(k, trayMesh);
    if (!tray) throw new Error('The tray is not a closed solid, so it cannot be split into liner and core.');
    keep(tray);
    const whole = { liner: trayMesh, volume: tray.volume(), core: null, coreVolume: 0 };
    if (!(thickness > 0) || thickness >= depth - step / 2) return whole;
    const outline = keep(tray.slice(0.25)); // the floor is always whole
    const voids = new Map<number, ReturnType<typeof tray.slice>>();
    /** Open space of the tray at height z, grown sideways by the liner thickness. */
    const grownVoid = (z: number) => {
      const key = Math.round(z * 100);
      let g = voids.get(key);
      if (!g) {
        const open = z >= depth - 1e-6 ? outline : keep(outline.subtract(keep(tray.slice(Math.max(0.01, z) + 0.0137)))); // off the round heights where pocket steps lie, which slice badly
        // Shrink first: the subtraction leaves hairline slivers along the outline, which offset into nonsense.
        // Then a little over, so polygon rounding never leaves the liner thin.
        g = keep(keep(keep(open.offset(-0.02, 'Square')).offset(thickness + 0.15, 'Round', 2, 16)).simplify(0.03));
        voids.set(key, g);
      }
      return g;
    };
    const slabs: Manifold[] = [];
    let run: { shape: typeof outline; z0: number; z1: number } | null = null;
    const flush = () => { if (run) slabs.push(keep(keep(run.shape.extrude(run.z1 - run.z0)).translate(0, 0, run.z0))); run = null; };
    for (let z0 = 0; z0 < depth - thickness - 1e-6; z0 += step) {
      const z1 = Math.min(z0 + step, depth - thickness);
      const heights = [z0 - thickness, z0 - thickness / 2, z0, (z0 + z1) / 2, z1, z1 + thickness / 2, z1 + thickness].filter((z) => z > 0);
      const soft = keep(k.CrossSection.union(heights.map(grownVoid)));
      // Drop slivers under 2 mm wide: not worth a material change.
      const free = keep(outline.subtract(soft));
      const rigid = keep(keep(keep(keep(free.offset(-1, 'Round', 2, 8)).offset(1, 'Round', 2, 8)).simplify(0.02)).intersect(free)); // never back into the liner
      if (rigid.area() < 4) { flush(); continue; }
      // Same outline as the slab below (straight pocket walls): make one taller slab, not a stack of copies.
      if (run && keep(run.shape.subtract(rigid)).area() < 0.5 && keep(rigid.subtract(run.shape)).area() < 2) { run.z1 = z1; continue; }
      flush();
      run = { shape: rigid, z0, z1 };
    }
    flush();
    if (!slabs.length) return whole;
    const core = keep(slabs.length === 1 ? slabs[0] : k.Manifold.union(slabs));
    const liner = keep(tray.subtract(core));
    if (liner.isEmpty()) throw new Error('Liner geometry came out empty');
    return { liner: mesh(liner, trayMesh.name), volume: liner.volume(), core: mesh(core, 'core'), coreVolume: core.volume() };
  } finally {
    for (const t of trash) t.delete();
  }
}
