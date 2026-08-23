import type { Settings } from '../types';
import { REG, LIP_BASE } from '../lib/cad/profile';
import { insertProblem } from '../lib/cad/insert';
import { CheckField, NumberField, Panel } from './Field';

export function CasePanel({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const cellsX = Math.floor((s.cutoutLength - 2 * s.caseFit + REG.cellGap) / s.gridPitch);
  const cellsY = Math.floor((s.cutoutWidth - 2 * s.caseFit + REG.cellGap) / s.gridPitch);
  const spanX = cellsX * s.gridPitch - REG.cellGap;
  const spanY = cellsY * s.gridPitch - REG.cellGap;
  return (
    <Panel title="Case cutout">
      <div className="grid3">
        <NumberField label="Length" value={s.cutoutLength} onChange={(v) => set({ cutoutLength: v })} min={25} step={1} />
        <NumberField label="Width" value={s.cutoutWidth} onChange={(v) => set({ cutoutWidth: v })} min={25} step={1} />
        <NumberField label="Depth" value={s.cutoutDepth} onChange={(v) => set({ cutoutDepth: v })} min={10} step={1} />
      </div>
      <div className="grid3">
        <NumberField
          label="Fit to walls"
          value={s.caseFit}
          onChange={(v) => set({ caseFit: v })}
          min={0}
          max={10}
          step={0.1}
          hint="Gap per side between the tray assembly and the cutout walls."
        />
        <NumberField label="Grid pitch" value={s.gridPitch} onChange={(v) => set({ gridPitch: v })} min={10} max={100} step={1} />
        <NumberField label="Printer bed" value={s.maxBed} onChange={(v) => set({ maxBed: v })} min={50} step={1} />
      </div>
      <p className="muted small">
        {cellsX} x {cellsY} cells per layer ({spanX.toFixed(1)} x {spanY.toFixed(1)} mm used of{' '}
        {(s.cutoutLength - 2 * s.caseFit).toFixed(1)} x {(s.cutoutWidth - 2 * s.caseFit).toFixed(1)} mm available).
      </p>
    </Panel>
  );
}

export function SettingsPanel({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  return (
    <Panel title="Trays">
      <div className="grid3">
        <NumberField
          label="Pocket clearance"
          value={s.clearance}
          onChange={(v) => set({ clearance: v })}
          min={0}
          max={15}
          step={0.1}
          hint="Single global outward offset around every outline. Sized so a foam or felt liner takes up the slack."
        />
        <NumberField label="Wall" value={s.wall} onChange={(v) => set({ wall: v })} min={0.8} max={10} step={0.1} />
        <NumberField label="Floor" value={s.floor} onChange={(v) => set({ floor: v })} min={0.8} max={10} step={0.1} />
      </div>
      <div className="grid3">
        <NumberField
          label="Depth bucket"
          value={s.depthBucketTolerance}
          onChange={(v) => set({ depthBucketTolerance: v })}
          min={0}
          max={100}
          step={1}
          hint="Parts whose depths differ by more than this are steered onto different trays."
        />
        <NumberField
          label="Stack tolerance"
          value={s.stackTolerance}
          onChange={(v) => set({ stackTolerance: v })}
          min={0}
          max={1}
          step={0.05}
          hint="Per-side clearance of the stacking recess over the foot. 0.25 mm matches Gridfinity."
        />
        <NumberField
          label="Finger notch"
          value={s.fingerNotchRadius}
          onChange={(v) => set({ fingerNotchRadius: v })}
          min={3}
          max={20}
          step={0.5}
          hint="Radius of the per-pocket finger notches placed in the 2D view. 9 mm is a fingertip."
        />
      </div>
      <div className="checks">
        <CheckField
          label="Thumb notches"
          value={s.thumbNotches}
          onChange={(v) => set({ thumbNotches: v })}
          hint="Scallops on tray edges where there is room for them."
        />
        <CheckField
          label="Rotate parts to fit"
          value={s.allowRotation}
          onChange={(v) => set({ allowRotation: v })}
          hint="Turn each outline to its minimum-area orientation before packing."
        />
      </div>
      {s.wall < LIP_BASE && (
        <p className="muted small">
          Pockets are held {LIP_BASE} mm from the tray edge regardless of wall thickness, so the
          perimeter stacking lip keeps its full profile.
        </p>
      )}
    </Panel>
  );
}

export function InsertPanel({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const problem = s.generateInserts ? insertProblem(s) : null;
  return (
    <Panel title="TPU liners">
      <CheckField
        label="Generate a printable liner for every pocket"
        value={s.generateInserts}
        onChange={(v) => set({ generateInserts: v })}
        hint="Exported separately from the trays, since TPU runs from the external spool."
      />
      {s.generateInserts && (
        <>
          <div className="grid3">
            <NumberField
              label="Floor pad"
              value={s.insertPad}
              onChange={(v) => set({ insertPad: v })}
              min={0.4}
              max={20}
              step={0.2}
              hint="Cushion the part sits on."
            />
            <NumberField
              label="Backing wall"
              value={s.insertWall}
              onChange={(v) => set({ insertWall: v })}
              min={0.4}
              max={5}
              step={0.1}
              hint="Thin shell that hugs the pocket wall and carries the ribs."
            />
            <NumberField
              label="Pocket fit"
              value={s.insertFit}
              onChange={(v) => set({ insertFit: v })}
              min={0}
              max={1}
              step={0.05}
              hint="Gap per side so the liner drops into the pocket."
            />
          </div>
          <div className="grid3">
            <NumberField
              label="Rib squeeze"
              value={s.insertSqueeze}
              onChange={(v) => set({ insertSqueeze: v })}
              min={0}
              max={2}
              step={0.05}
              hint="How far the ribs overlap the part, i.e. how hard they grip. Raise it if parts rattle."
            />
            <NumberField
              label="Rib spacing"
              value={s.insertRibSpacing}
              onChange={(v) => set({ insertRibSpacing: v })}
              min={4}
              max={60}
              step={1}
              hint="Distance between ribs around the pocket perimeter."
            />
            <NumberField
              label="Coverage"
              value={s.insertCoverage}
              onChange={(v) => set({ insertCoverage: v })}
              min={0.1}
              max={1}
              step={0.05}
              suffix=""
              hint="Fraction of the pocket depth the liner walls rise to. 1 is full depth."
            />
          </div>
          <p className="muted small">
            Crush ribs rather than a solid sleeve: TPU is not dimensionally predictable enough for a
            press fit, but a rib squashes by whatever it needs to. Print in TPU from an external
            spool, 0.2 mm layers, slow, no supports.
          </p>
        </>
      )}
      {problem && <p className="warn small">{problem}</p>}
    </Panel>
  );
}
