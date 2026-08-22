import type { Settings } from '../types';
import { REG, LIP_BASE } from '../lib/cad/profile';
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
