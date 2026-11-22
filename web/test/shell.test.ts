import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initKernel } from '../src/geom/kernel';
import { toManifold } from '../src/geom/analyze';
import { buildShell, DEFAULT_SHELL, shellExtraHeight, shellPitch, shellProblem, trayInsideShell, type Footprint } from '../src/geom/shell';
import { TrayError } from '../src/geom/tray';
import { meshBounds } from '../src/mesh/bounds';

let k: ManifoldToplevel;
beforeAll(async () => { k = await initKernel(); });

const outer: Footprint = { length: 200, width: 120, cornerRadius: 4 };
const DEPTH = 30;
/** Volume two solids share, then free them. */
function shared(a: Manifold, b: Manifold) {
  const both = a.intersect(b);
  const v = both.volume();
  both.delete(); a.delete(); b.delete();
  return v;
}
const solidOf = (s = DEFAULT_SHELL) => toManifold(k, buildShell(k, outer, DEPTH, s).mesh)!;
const block = (f: Footprint, z0: number, z1: number) => {
  // Rounded the same way the tray outline is.
  const r = f.cornerRadius;
  const core = k.CrossSection.square([f.length - 2 * r, f.width - 2 * r], true), sq = r > 0 ? core.offset(r, 'Round', 2, 32) : core;
  const ex = sq.extrude(z1 - z0), out = ex.translate(0, 0, z0);
  if (sq !== core) sq.delete();
  core.delete(); ex.delete();
  return out;
};

describe('shell', () => {
  it('stays inside the footprint and stands the rim above the tray top', () => {
    const s = DEFAULT_SHELL;
    const shell = buildShell(k, outer, DEPTH, s);
    const b = meshBounds(shell.mesh);
    expect(b.max[0] - b.min[0]).toBeCloseTo(outer.length, 3);
    expect(b.max[1] - b.min[1]).toBeCloseTo(outer.width, 3);
    expect(b.max[2]).toBeCloseTo(DEPTH + s.rim, 4); // 4 mm above the tray top
    expect(b.min[2]).toBeCloseTo(-(s.floor + s.plug), 4);
    expect(shell.height).toBeCloseTo(DEPTH + shellExtraHeight(s), 6);
    expect(shell.below).toBeCloseTo(s.floor + s.plug, 6);
    expect(toManifold(k, shell.mesh)).not.toBeNull(); // watertight
  });

  it('leaves exactly the room the tray needs', () => {
    const inside = trayInsideShell(outer, DEFAULT_SHELL);
    expect(inside).toEqual({ length: 194, width: 114, cornerRadius: 1 });
    // The tray's box does not touch the shell; a box one wall bigger does.
    expect(shared(solidOf(), block(inside, 0, DEPTH))).toBeLessThan(1e-3);
    expect(shared(solidOf(), block(outer, 0, DEPTH))).toBeGreaterThan(1000);
    const loose = trayInsideShell(outer, { ...DEFAULT_SHELL, gap: 0.2 });
    expect(loose.length).toBeCloseTo(193.6, 6);
  });

  it('stacks: the bottom step drops into the rim below without touching it', () => {
    const s = DEFAULT_SHELL;
    const upper = () => { const m = solidOf(), up = m.translate(0, 0, shellPitch(DEPTH, s)); m.delete(); return up; };
    expect(shared(solidOf(), upper())).toBeLessThan(1e-3);
    // The step really is inside the recess: `plug` deep, so it cannot slide sideways more than the fit.
    const b = meshBounds(buildShell(k, outer, DEPTH, s).mesh);
    expect(b.max[2] - (b.min[2] + shellPitch(DEPTH, s))).toBeCloseTo(s.plug, 4);
    const nudged = (dx: number) => { const u = upper(), n = u.translate(dx, 0, 0); u.delete(); return shared(solidOf(), n); };
    expect(nudged(s.fit - 0.05)).toBeLessThan(1e-3);
    expect(nudged(s.fit + 0.2)).toBeGreaterThan(1);
  });

  it('rejects settings that cannot be built', () => {
    expect(shellProblem(outer, DEFAULT_SHELL)).toBeNull();
    expect(shellProblem(outer, { ...DEFAULT_SHELL, plug: 5 })).toMatch(/taller than the rim/);
    expect(shellProblem({ ...outer, length: 400 }, DEFAULT_SHELL)).toMatch(/print bed/);
    expect(shellProblem({ ...outer, width: 24 }, DEFAULT_SHELL)).toMatch(/too small/);
    expect(() => buildShell(k, outer, DEPTH, { ...DEFAULT_SHELL, wall: 0.5 })).toThrow(TrayError);
  });
});
