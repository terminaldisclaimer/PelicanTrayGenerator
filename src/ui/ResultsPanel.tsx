import type { SolveResult, Tray } from '../types';
import { Panel } from './Field';

export function ResultsPanel({ result, selected, onSelect, onExport, exportAll, busy }: {
  result: SolveResult | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onExport: (tray: Tray, format: 'stl' | '3mf') => void;
  exportAll: () => void;
  busy: boolean;
}) {
  if (!result) {
    return (
      <Panel title="Result">
        <p className="muted">Add parts and press Generate.</p>
      </Panel>
    );
  }
  const { stats } = result;
  const overflow = stats.stackHeight > stats.cutoutDepth + 1e-6;
  return (
    <Panel
      title="Result"
      aside={
        stats.trayCount > 0 && (
          <button className="primary small" onClick={exportAll} disabled={busy}>
            Download all
          </button>
        )
      }
    >
      <dl className="stats">
        <div><dt>Parts</dt><dd>{stats.partCount}</dd></div>
        <div><dt>Trays</dt><dd>{stats.trayCount}</dd></div>
        <div><dt>Layers</dt><dd>{stats.layerCount}</dd></div>
        <div className={overflow ? 'bad' : undefined}>
          <dt>Stack height</dt>
          <dd>{stats.stackHeight.toFixed(1)} / {stats.cutoutDepth} mm</dd>
        </div>
        <div><dt>Footprint used</dt><dd>{(stats.footprintFill * 100).toFixed(0)}%</dd></div>
        <div><dt>Cutout filled</dt><dd>{(stats.volumeFill * 100).toFixed(0)}%</dd></div>
      </dl>

      {result.warnings.map((w, i) => <p className="warn" key={i}>{w}</p>)}
      {result.unplaced.length > 0 && (
        <div className="warn">
          <strong>Not placed:</strong>
          <ul>
            {result.unplaced.map((u, i) => <li key={i}>{u.name} - {u.reason}</li>)}
          </ul>
        </div>
      )}

      <ul className="trays">
        {result.trays.map((t) => (
          <li
            key={t.id}
            className={selected === t.id ? 'sel' : undefined}
            onClick={() => onSelect(selected === t.id ? null : t.id)}
          >
            <div className="tray-head">
              <strong>{t.name}</strong>
              <span className="mono">
                {t.sizeX.toFixed(1)} x {t.sizeY.toFixed(1)} x {t.height.toFixed(1)} mm
              </span>
              <span className="badge">layer {t.layer + 1}</span>
            </div>
            <div className="tray-parts">
              {t.parts.map((p) => `${p.name}${p.instance ? ` #${p.instance + 1}` : ''} (${p.depth} mm)`).join(', ')}
            </div>
            {t.warnings.map((w, i) => <div className="warn small" key={i}>{w}</div>)}
            <div className="tray-actions">
              <button className="ghost small" onClick={(e) => { e.stopPropagation(); onExport(t, '3mf'); }} disabled={busy}>3MF</button>
              <button className="ghost small" onClick={(e) => { e.stopPropagation(); onExport(t, 'stl'); }} disabled={busy}>STL</button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
