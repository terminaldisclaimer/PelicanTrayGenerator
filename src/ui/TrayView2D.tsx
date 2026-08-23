import { useMemo, useRef, useState } from 'react';
import type { PlacedPart, Ring, Settings, Tray, Vec2 } from '../types';
import { REG } from '../lib/cad/profile';
import { nearestT, notchProblemAt, pointAtT } from '../lib/solver/notches';

export interface TrayView2DProps {
  tray: Tray;
  settings: Settings;
  message: string | null;
  onAddPair: (partId: string, instance: number) => void;
  onRemovePair: (partId: string, instance: number) => void;
  onMoveNotch: (partId: string, instance: number, key: 'a' | 'b', t: number) => void;
  onAlignOpposite: (partId: string, instance: number, dragged: 'a' | 'b') => void;
}

interface Sel { partId: string; instance: number }
interface Drag extends Sel { key: 'a' | 'b'; t: number }

const sameSel = (a: Sel | null, b: Sel) => !!a && a.partId === b.partId && a.instance === b.instance;

export function TrayView2D({
  tray, settings: s, message, onAddPair, onRemovePair, onMoveNotch, onAlignOpposite,
}: TrayView2DProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const MARGIN = 14;
  const [vb, setVb] = useState({ x: -MARGIN, y: -MARGIN, w: tray.sizeX + 2 * MARGIN, h: tray.sizeY + 2 * MARGIN });
  const [trayId, setTrayId] = useState(tray.id);
  if (trayId !== tray.id) {
    // New tray selected: refit the view.
    setTrayId(tray.id);
    setVb({ x: -MARGIN, y: -MARGIN, w: tray.sizeX + 2 * MARGIN, h: tray.sizeY + 2 * MARGIN });
  }
  const [sel, setSel] = useState<Sel | null>(null);
  const [selNotch, setSelNotch] = useState<'a' | 'b' | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pan, setPan] = useState<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  // World y-up -> svg y-down.
  const Y = (wy: number) => tray.sizeY - wy;
  const path = (rings: Ring[]) =>
    rings.map((r) => `M ${r.map(([x, y]) => `${x.toFixed(2)},${Y(y).toFixed(2)}`).join(' L ')} Z`).join(' ');

  /** Client coords -> tray world coords. */
  const toWorld = (e: { clientX: number; clientY: number }): Vec2 => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const sx = vb.x + ((e.clientX - r.left) / r.width) * vb.w;
    const sy = vb.y + ((e.clientY - r.top) / r.height) * vb.h;
    return [sx, tray.sizeY - sy];
  };

  const selected = sel && tray.parts.find((p) => p.partId === sel.partId && p.instance === sel.instance);
  const selectedPair = selected?.fingerNotches;

  const dragProblem = useMemo(() => {
    if (!drag) return null;
    const part = tray.parts.find((p) => p.partId === drag.partId && p.instance === drag.instance);
    if (!part) return null;
    const pt = pointAtT(part.poly[0], drag.t);
    return notchProblemAt({ tray, part, settings: s }, pt);
  }, [drag, tray, s]);

  function notchesFor(part: PlacedPart) {
    return (part.fingerNotches ?? []).map((n) => {
      if (drag && drag.partId === part.partId && drag.instance === part.instance && drag.key === n.key) {
        const [x, y] = pointAtT(part.poly[0], drag.t);
        return { ...n, x, y, valid: !dragProblem, live: true };
      }
      return { ...n, live: false };
    });
  }

  const onMove = (e: React.PointerEvent) => {
    if (drag) {
      const part = tray.parts.find((p) => p.partId === drag.partId && p.instance === drag.instance);
      if (part) setDrag({ ...drag, t: nearestT(part.poly[0], toWorld(e)) });
    } else if (pan) {
      const svg = svgRef.current!;
      const r = svg.getBoundingClientRect();
      setVb((v) => ({
        ...v,
        x: pan.vx - ((e.clientX - pan.sx) / r.width) * v.w,
        y: pan.vy - ((e.clientY - pan.sy) / r.height) * v.h,
      }));
    }
  };

  const onUp = () => {
    if (drag) {
      // Commit even when invalid: the position is the user's, and validity is
      // reported rather than enforced by snapping.
      onMoveNotch(drag.partId, drag.instance, drag.key, drag.t);
      setSelNotch(drag.key);
      setDrag(null);
    }
    setPan(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const cx = vb.x + ((e.clientX - r.left) / r.width) * vb.w;
    const cy = vb.y + ((e.clientY - r.top) / r.height) * vb.h;
    setVb((v) => {
      const w = Math.min(Math.max(v.w * factor, 20), tray.sizeX * 4 + 200);
      const h = (w / v.w) * v.h;
      return { x: cx - ((cx - v.x) / v.w) * w, y: cy - ((cy - v.y) / v.h) * h, w, h };
    });
  };

  const gridLines = [];
  for (let i = 1; i < tray.cellsX; i++) gridLines.push({ x1: i * s.gridPitch - REG.cellGap / 2, y1: 0, x2: i * s.gridPitch - REG.cellGap / 2, y2: tray.sizeY });
  for (let j = 1; j < tray.cellsY; j++) gridLines.push({ x1: 0, y1: j * s.gridPitch - REG.cellGap / 2, x2: tray.sizeX, y2: j * s.gridPitch - REG.cellGap / 2 });

  return (
    <div className="view2d">
      <div className="v2-toolbar">
        {selected ? (
          <>
            <span className="v2-name">{selected.name}{selected.instance ? ` #${selected.instance + 1}` : ''}</span>
            {!selectedPair?.length ? (
              <button className="primary small" onClick={() => onAddPair(selected.partId, selected.instance)}>
                Add finger notches
              </button>
            ) : (
              <>
                <button
                  className="small"
                  disabled={!selNotch}
                  title="Move the other notch directly across the shape from the selected one"
                  onClick={() => selNotch && onAlignOpposite(selected.partId, selected.instance, selNotch)}
                >
                  Align opposite
                </button>
                <button className="ghost small" onClick={() => { onRemovePair(selected.partId, selected.instance); setSelNotch(null); }}>
                  Remove notches
                </button>
              </>
            )}
          </>
        ) : (
          <span className="muted small">Click a pocket to add or edit its finger notches. Drag a notch around the outline.</span>
        )}
        {drag && dragProblem && <span className="warn small">{dragProblem}</span>}
        {message && <span className="warn small">{message}</span>}
        {tray.blocked && !drag && <span className="warn small">A notch collides - geometry for this tray is withheld.</span>}
      </div>
      <svg
        ref={svgRef}
        className="v2-canvas"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
        onPointerDown={(e) => {
          if (e.target === svgRef.current) {
            setSel(null);
            setSelNotch(null);
            setPan({ sx: e.clientX, sy: e.clientY, vx: vb.x, vy: vb.y });
          }
        }}
      >
        <rect
          x={0} y={0} width={tray.sizeX} height={tray.sizeY} rx={REG.cornerRadius}
          className="v2-tray"
          onPointerDown={(e) => { setSel(null); setSelNotch(null); setPan({ sx: e.clientX, sy: e.clientY, vx: vb.x, vy: vb.y }); e.stopPropagation(); }}
        />
        {gridLines.map((l, i) => (
          <line key={i} x1={l.x1} y1={Y(l.y1)} x2={l.x2} y2={Y(l.y2)} className="v2-grid" />
        ))}
        {tray.notches.map((n, i) => (
          <circle key={`thumb${i}`} cx={n.cx} cy={Y(n.cy)} r={n.radius} className="v2-thumb" />
        ))}
        {tray.parts.map((p) => (
          <g key={`${p.partId}#${p.instance}`}>
            <path
              d={path(p.poly)}
              className={`v2-pocket${sameSel(sel, p) ? ' sel' : ''}`}
              fillRule="evenodd"
              onPointerDown={(e) => { setSel({ partId: p.partId, instance: p.instance }); setSelNotch(null); e.stopPropagation(); }}
            />
            <path d={path(p.rawPoly)} className="v2-raw" fillRule="evenodd" />
            <text x={p.bbox.x + p.bbox.w / 2} y={Y(p.bbox.y + p.bbox.h / 2)} className="v2-label">
              {p.name}{p.instance ? ` #${p.instance + 1}` : ''}
            </text>
            {notchesFor(p).map((n) => (
              <circle
                key={n.key}
                cx={n.x}
                cy={Y(n.y)}
                r={s.fingerNotchRadius}
                className={
                  'v2-notch' +
                  (n.valid ? '' : ' bad') +
                  (sameSel(sel, p) && selNotch === n.key && !drag ? ' sel' : '') +
                  (n.live ? ' live' : '')
                }
                onPointerDown={(e) => {
                  setSel({ partId: p.partId, instance: p.instance });
                  setSelNotch(n.key);
                  setDrag({ partId: p.partId, instance: p.instance, key: n.key, t: n.t });
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  e.stopPropagation();
                }}
              />
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
