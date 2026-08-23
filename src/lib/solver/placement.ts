import type { PartInput, PlacedPart, Settings, Tray } from '../../types';
import { LIP_BASE } from '../cad/profile';
import { translatePoly } from '../geom2d';

/**
 * Manual placement overrides: the packer decides the layout, the 2D editor
 * lets the user fine-tune it. An override translates one placed copy within
 * its tray; it is stored in tray-local coordinates of the frame the user saw.
 *
 * The same keep-and-warn contract as finger notches applies: a position that
 * no longer works is never nudged - it is flagged and the tray's geometry is
 * withheld until the user fixes or resets it.
 */

/** Move a placed copy so its pocket bounding box origin lands on (x, y). */
export function movePlacedPart(part: PlacedPart, x: number, y: number): void {
  const dx = x - part.bbox.x;
  const dy = y - part.bbox.y;
  if (dx === 0 && dy === 0) return;
  part.poly = translatePoly(part.poly, dx, dy);
  part.rawPoly = translatePoly(part.rawPoly, dx, dy);
  part.bbox = { ...part.bbox, x, y };
}

/**
 * Why this copy cannot sit at (x, y), or null when it can.
 * Bounding boxes are used deliberately: it matches the packer's own spacing
 * rule, so a manual layout obeys exactly the invariants a packed one does.
 */
export function placementProblemAt(
  tray: Tray, part: PlacedPart, s: Settings, x: number, y: number,
): string | null {
  const margin = Math.max(s.wall, LIP_BASE);
  if (
    x < margin - 1e-6 || y < margin - 1e-6 ||
    x + part.bbox.w > tray.sizeX - margin + 1e-6 ||
    y + part.bbox.h > tray.sizeY - margin + 1e-6
  ) {
    return 'outside the tray’s usable area';
  }
  for (const other of tray.parts) {
    if (other === part) continue;
    const gap = s.wall - 1e-4;
    const clear =
      x + part.bbox.w + gap <= other.bbox.x || other.bbox.x + other.bbox.w + gap <= x ||
      y + part.bbox.h + gap <= other.bbox.y || other.bbox.y + other.bbox.h + gap <= y;
    if (!clear) return `too close to the ${other.name} pocket`;
  }
  return null;
}

/** blocked = any unusable manual position or any invalid finger notch. */
export function updateTrayBlocked(tray: Tray): void {
  tray.blocked = tray.parts.some(
    (p) => !!p.placementProblem || (p.fingerNotches ?? []).some((n) => !n.valid),
  );
}

/**
 * Record packed positions, apply stored overrides, and validate the result.
 * Runs after the layer assembly (tray frames are final there) and before the
 * thumb and finger notches, which both depend on where pockets ended up.
 */
export function applyPlacementOverrides(tray: Tray, parts: PartInput[], s: Settings): string[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const problems: string[] = [];

  for (const placed of tray.parts) {
    placed.packed = { x: placed.bbox.x, y: placed.bbox.y };
    placed.moved = false;
    placed.placementProblem = undefined;
    const override = byId.get(placed.partId)?.placements?.find((o) => o.instance === placed.instance);
    if (override) {
      movePlacedPart(placed, override.x, override.y);
      placed.moved = true;
    }
  }
  // Validate only after every override is in place, so two moved pockets are
  // judged against each other's final positions.
  for (const placed of tray.parts) {
    if (!placed.moved) continue;
    const problem = placementProblemAt(tray, placed, s, placed.bbox.x, placed.bbox.y);
    if (problem) {
      placed.placementProblem = problem;
      problems.push(
        `${placed.name}${placed.instance ? ` #${placed.instance + 1}` : ''}: moved position is ${problem}. ` +
        `Fix or reset it in the 2D view - geometry for this tray is withheld until then.`,
      );
    }
  }
  return problems;
}
