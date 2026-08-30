import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Settings, SolveResult, Tray } from './types';
import { emptyProject } from './defaults';
import { initCad, type TriMesh } from './lib/cad/manifold';
import { buildTrayMesh } from './lib/cad/tray';
import { buildInsertMesh, insertProblem } from './lib/cad/insert';
import { solve } from './lib/solver/solve';
import { meshToStl } from './lib/export/stl';
import { download, meshTo3mf, meshesTo3mf, zipFiles } from './lib/export/threemf';
import { autosave, loadAutosave, loadProjectFile, saveProjectFile } from './lib/project';
import { CasePanel, SettingsPanel, InsertPanel } from './ui/SettingsPanel';
import { PartsPanel } from './ui/PartsPanel';
import { ResultsPanel } from './ui/ResultsPanel';
import { Preview } from './three/Preview';
import { TrayView2D } from './ui/TrayView2D';
import { autoPlacePair, alignOppositeT, resolveTrayNotches } from './lib/solver/notches';
import { movePlacedPart, placementProblemAt, updateTrayBlocked } from './lib/solver/placement';
import { computeThumbNotches } from './lib/solver/solve';
import { REG } from './lib/cad/profile';

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export default function App() {
  const [project, setProjectState] = useState<Project>(() => loadAutosave() ?? emptyProject());
  const [result, setResult] = useState<SolveResult | null>(null);
  const [meshes, setMeshes] = useState<Map<string, TriMesh>>(new Map());
  // Liners, keyed by tray id. One entry per pocket, in tray-local coordinates.
  const [inserts, setInserts] = useState<Map<string, { name: string; mesh: TriMesh }[]>>(new Map());
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [exploded, setExploded] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [frameRequest, setFrameRequest] = useState<{ n: number; mode: 'iso' | 'top' }>({ n: 0, mode: 'iso' });
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [notchMessage, setNotchMessage] = useState<string | null>(null);
  const reframe = (mode: 'iso' | 'top') => setFrameRequest((f) => ({ n: f.n + 1, mode }));
  const loadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    initCad().then(() => setReady(true)).catch((e) => setError(`Could not start the CAD kernel: ${e.message}`));
  }, []);

  const setProject = useCallback((updater: (p: Project) => Project) => {
    setProjectState((prev) => {
      const next = updater(prev);
      autosave(next);
      return next;
    });
    setStale(true);
  }, []);

  const setSettings = useCallback(
    (patch: Partial<Settings>) => setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } })),
    [setProject],
  );

  const generate = useCallback(async () => {
    if (!ready) return;
    setError(null);
    setBusy('Packing parts...');
    setSelected(null);
    await yieldToUi();
    try {
      const res = solve(project.parts, project.settings);
      setResult(res);
      setMeshes(new Map());
      setInserts(new Map());
      const built = new Map<string, TriMesh>();
      const liners = new Map<string, { name: string; mesh: TriMesh }[]>();
      const linerIssue = project.settings.generateInserts ? insertProblem(project.settings) : null;
      if (linerIssue) res.warnings.push(linerIssue);

      for (let i = 0; i < res.trays.length; i++) {
        const tray = res.trays[i];
        if (tray.blocked) continue; // invalid finger notch: withhold geometry
        setBusy(`Building geometry ${i + 1} of ${res.trays.length}...`);
        await yieldToUi();
        built.set(tray.id, buildTrayMesh(tray, project.settings));
        setMeshes(new Map(built));

        if (project.settings.generateInserts && !linerIssue) {
          setBusy(`Building liners ${i + 1} of ${res.trays.length}...`);
          await yieldToUi();
          const forTray: { name: string; mesh: TriMesh }[] = [];
          for (const part of tray.parts) {
            const ins = buildInsertMesh(part, project.settings);
            if (ins) forTray.push({ name: linerName(part.name, part.instance), mesh: ins.mesh });
            else part.insertProblem = 'This pocket is too small for a liner.';
          }
          if (forTray.length) liners.set(tray.id, forTray);
          setInserts(new Map(liners));
        }
      }
      setStale(false);
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }, [ready, project]);

  /** Compact settings fingerprint stamped into every exported file. */
  const settingsStamp = useMemo(() => {
    const s = project.settings;
    return `clr${s.clearance} tr${s.traceOffset} w${s.wall} f${s.floor} fit${s.insertFit} bw${s.insertWall} sq${s.insertSqueeze}`;
  }, [project.settings]);

  const fileBase = useMemo(
    () => (project.name || 'trays').replace(/[^\w.-]+/g, '_'),
    [project.name],
  );

  const exportTray = useCallback((tray: Tray, format: 'stl' | '3mf' | 'liners') => {
    const name = `${fileBase}-${tray.name.replace(/\s+/g, '')}`;
    if (format === 'liners') {
      const set = inserts.get(tray.id);
      if (!set?.length) return;
      // One 3MF holding every liner for this tray: they are a single TPU job.
      download(meshesTo3mf(set, `${tray.name} liners`), `${name}-liners.3mf`, 'model/3mf');
      return;
    }
    const mesh = meshes.get(tray.id);
    if (!mesh) return;
    if (format === 'stl') download(meshToStl(mesh, settingsStamp), `${name}.stl`, 'model/stl');
    else download(meshTo3mf(mesh, tray.name), `${name}.3mf`, 'model/3mf');
  }, [meshes, inserts, fileBase, settingsStamp]);

  const exportAll = useCallback(() => {
    if (!result) return;
    const files: Record<string, Uint8Array> = {};
    for (const tray of result.trays) {
      const mesh = meshes.get(tray.id);
      if (!mesh) continue;
      const name = tray.name.replace(/\s+/g, '');
      files[`petg-trays/3mf/${name}.3mf`] = meshTo3mf(mesh, tray.name);
      files[`petg-trays/stl/${name}.stl`] = meshToStl(mesh, settingsStamp);

      const set = inserts.get(tray.id);
      if (set?.length) {
        files[`tpu-liners/3mf/${name}-liners.3mf`] = meshesTo3mf(set, `${tray.name} liners`);
        for (const liner of set) {
          files[`tpu-liners/stl/${name}-${liner.name}.stl`] = meshToStl(liner.mesh, settingsStamp);
        }
      }
    }
    files['print-notes.txt'] = new TextEncoder().encode(printNotes(project, result));
    files['project.traygen.json'] = new TextEncoder().encode(JSON.stringify(project, null, 2));
    download(zipFiles(files), `${fileBase}.zip`, 'application/zip');
  }, [result, meshes, inserts, project, fileBase, settingsStamp]);

  /** Rebuild one tray's mesh and liners after a notch edit. */
  const rebuildTray = useCallback(async (tray: Tray, parts: Project['parts'], s: Settings) => {
    setBusy(`Rebuilding ${tray.name}...`);
    await yieldToUi();
    try {
      setMeshes((prev) => {
        const next = new Map(prev);
        if (tray.blocked) next.delete(tray.id);
        else next.set(tray.id, buildTrayMesh(tray, s));
        return next;
      });
      setInserts((prev) => {
        const next = new Map(prev);
        next.delete(tray.id);
        if (!tray.blocked && s.generateInserts && !insertProblem(s)) {
          const forTray: { name: string; mesh: TriMesh }[] = [];
          for (const part of tray.parts) {
            const ins = buildInsertMesh(part, s);
            if (ins) forTray.push({ name: linerName(part.name, part.instance), mesh: ins.mesh });
          }
          if (forTray.length) next.set(tray.id, forTray);
        }
        return next;
      });
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
    void parts; // placement is unchanged by a notch edit; parts kept for clarity
  }, []);

  /**
   * Re-derive everything on a tray that depends on pocket positions - thumb
   * notches, finger notches, blocked state - then publish and rebuild.
   */
  const refreshTray = useCallback((tray: Tray, parts: Project['parts'], s: Settings) => {
    if (!result) return;
    tray.warnings = tray.warnings.filter(
      (w) => !w.includes('finger notch') && !w.includes('moved position') && !w.includes('thumb notch'),
    );
    const thumbs = computeThumbNotches(tray, s);
    tray.notches = thumbs.notches;
    if (thumbs.warning) tray.warnings.push(thumbs.warning);
    for (const placed of tray.parts) {
      placed.placementProblem = placed.moved
        ? placementProblemAt(tray, placed, s, placed.bbox.x, placed.bbox.y) ?? undefined
        : undefined;
      if (placed.placementProblem) {
        tray.warnings.push(
          `${placed.name}${placed.instance ? ` #${placed.instance + 1}` : ''}: moved position is ` +
          `${placed.placementProblem}. Fix or reset it in the 2D view - geometry for this tray is withheld until then.`,
        );
      }
    }
    const notchProblems = resolveTrayNotches(tray, parts, s);
    for (const msg of notchProblems) tray.warnings.push(msg);
    updateTrayBlocked(tray);
    setResult({ ...result, warnings: result.warnings.filter((w) => !w.includes('finger notch') && !w.includes('moved position')) });
    void rebuildTray(tray, parts, s);
  }, [result, rebuildTray]);

  /**
   * Apply a change to one copy's notch pair: persist it on the part, re-check
   * validity on the tray that holds the copy, and rebuild that tray.
   */
  const editNotches = useCallback((
    partId: string,
    instance: number,
    change: (current: { a: number; b: number } | undefined) => { a: number; b: number } | null | undefined,
  ) => {
    if (!result || busy) return;
    setNotchMessage(null);

    const tray = result.trays.find((t) => t.parts.some((p) => p.partId === partId && p.instance === instance));
    if (!tray) return;

    const parts = project.parts.map((p) => {
      if (p.id !== partId) return p;
      const current = p.fingerNotches.find((n) => n.instance === instance);
      const next = change(current ? { a: current.a, b: current.b } : undefined);
      if (next === undefined) return p;
      const rest = p.fingerNotches.filter((n) => n.instance !== instance);
      return { ...p, fingerNotches: next === null ? rest : [...rest, { instance, ...next }] };
    });
    const nextProject = { ...project, parts };
    setProjectState(nextProject);
    autosave(nextProject);

    refreshTray(tray, parts, nextProject.settings);
  }, [result, busy, project, refreshTray]);

  /** Move one copy to (x, y), or reset it to the packed position on null. */
  const editPlacement = useCallback((partId: string, instance: number, pos: { x: number; y: number } | null) => {
    if (!result || busy) return;
    setNotchMessage(null);
    const tray = result.trays.find((t) => t.parts.some((p) => p.partId === partId && p.instance === instance));
    const placed = tray?.parts.find((p) => p.partId === partId && p.instance === instance);
    if (!tray || !placed) return;

    const parts = project.parts.map((p) => {
      if (p.id !== partId) return p;
      const rest = (p.placements ?? []).filter((o) => o.instance !== instance);
      return { ...p, placements: pos === null ? rest : [...rest, { instance, ...pos }] };
    });
    const nextProject = { ...project, parts };
    setProjectState(nextProject);
    autosave(nextProject);

    const target = pos ?? placed.packed ?? { x: placed.bbox.x, y: placed.bbox.y };
    movePlacedPart(placed, target.x, target.y);
    placed.moved = pos !== null;
    refreshTray(tray, parts, nextProject.settings);
  }, [result, busy, project, refreshTray]);

  const notchHandlers = useMemo(() => ({
    add: (partId: string, instance: number) => {
      const tray = result?.trays.find((t) => t.parts.some((p) => p.partId === partId && p.instance === instance));
      const part = tray?.parts.find((p) => p.partId === partId && p.instance === instance);
      if (!tray || !part) return;
      const pair = autoPlacePair({ tray, part, settings: project.settings });
      if (!pair) {
        setNotchMessage('No room for a notch pair around this pocket - try a smaller notch radius.');
        return;
      }
      editNotches(partId, instance, () => pair);
    },
    remove: (partId: string, instance: number) => editNotches(partId, instance, () => null),
    move: (partId: string, instance: number, key: 'a' | 'b', t: number) =>
      editNotches(partId, instance, (cur) => (cur ? { ...cur, [key]: t } : undefined)),
    align: (partId: string, instance: number, dragged: 'a' | 'b') => {
      const tray = result?.trays.find((t) => t.parts.some((p) => p.partId === partId && p.instance === instance));
      const part = tray?.parts.find((p) => p.partId === partId && p.instance === instance);
      if (!tray || !part) return;
      editNotches(partId, instance, (cur) => {
        if (!cur) return undefined;
        const t = alignOppositeT({ tray, part, settings: project.settings }, cur[dragged]);
        if (t === null) {
          setNotchMessage('Nowhere valid directly across the shape - drag the other notch instead.');
          return undefined;
        }
        return dragged === 'a' ? { a: cur.a, b: t } : { a: t, b: cur.b };
      });
    },
  }), [result, project.settings, editNotches]);

  const tray2d = result?.trays.find((t) => t.id === selected) ?? result?.trays[0] ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Pelican Tray Generator</h1>
        <input
          className="project-name"
          value={project.name}
          onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))}
          aria-label="Project name"
        />
        <div className="spacer" />
        <button className="ghost" onClick={() => saveProjectFile(project)}>Save project</button>
        <button className="ghost" onClick={() => loadRef.current?.click()}>Open project</button>
        <input
          ref={loadRef}
          type="file"
          accept=".json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const p = await loadProjectFile(f);
              setProjectState(p);
              autosave(p);
              setResult(null);
              setMeshes(new Map());
              setStale(true);
            } catch (err) {
              setError(`Could not read that project file: ${(err as Error).message}`);
            }
            e.target.value = '';
          }}
        />
        <button
          className="primary"
          onClick={() => void generate()}
          disabled={!ready || busy !== null || project.parts.length === 0}
        >
          {busy ?? (ready ? 'Generate' : 'Loading CAD kernel...')}
        </button>
      </header>

      {error && <p className="error banner">{error}</p>}

      <main>
        <div className="sidebar">
          <CasePanel s={project.settings} set={setSettings} />
          <PartsPanel project={project} setProject={setProject} />
          <SettingsPanel s={project.settings} set={setSettings} />
          <InsertPanel s={project.settings} set={setSettings} />
          <ResultsPanel
            result={result}
            selected={selected}
            onSelect={setSelected}
            onExport={exportTray}
            inserts={inserts}
            exportAll={exportAll}
            busy={busy !== null}
          />
          <p className="muted small footer-note">
            Stacking interface: Gridfinity lip and base profile ({REG.chamferLower} / {REG.straight} /{' '}
            {REG.chamferUpper} mm, {REG.height} mm tall) re-pitched to {project.settings.gridPitch} mm.
          </p>
        </div>

        <div className="viewport">
          <div className="viewport-bar">
            <div className="seg">
              <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button>
              <button
                className={view === '2d' ? 'on' : ''}
                disabled={!result || result.trays.length === 0}
                title={result?.trays.length ? 'Edit finger notches on a tray' : 'Generate first'}
                onClick={() => setView('2d')}
              >
                2D
              </button>
            </div>
            {view === '2d' && tray2d && (
              <select
                className="tray-pick"
                value={tray2d.id}
                onChange={(e) => setSelected(e.target.value)}
              >
                {result!.trays.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {view === '3d' && <label className={(result?.stats.layerCount ?? 0) < 2 ? 'disabled' : undefined}>
              Explode
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={exploded}
                disabled={(result?.stats.layerCount ?? 0) < 2}
                title={(result?.stats.layerCount ?? 0) < 2 ? 'Everything fits in one layer, so there is nothing to explode.' : 'Separate the layers'}
                onChange={(e) => setExploded(parseFloat(e.target.value))}
              />
            </label>}
            {view === '3d' && <button className="ghost small" onClick={() => reframe('iso')}>Iso</button>}
            {view === '3d' && <button className="ghost small" onClick={() => reframe('top')}>Top</button>}
            {stale && result && <span className="badge warnbadge">Inputs changed - regenerate</span>}
            {selected && <span className="badge">{result?.trays.find((t) => t.id === selected)?.name}</span>}
          </div>
          {view === '2d' && tray2d ? (
            <TrayView2D
              tray={tray2d}
              settings={project.settings}
              message={notchMessage}
              onAddPair={notchHandlers.add}
              onRemovePair={notchHandlers.remove}
              onMoveNotch={notchHandlers.move}
              onAlignOpposite={notchHandlers.align}
              onMovePart={(partId, instance, x, y) => editPlacement(partId, instance, { x, y })}
              onResetPart={(partId, instance) => editPlacement(partId, instance, null)}
            />
          ) : (
            <Preview
              result={result}
              settings={project.settings}
              meshes={meshes}
              exploded={exploded}
              selected={selected}
              onSelect={setSelected}
              frameRequest={frameRequest}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function printNotes(project: Project, result: SolveResult): string {
  const s = project.settings;
  const lines: string[] = [
    `${project.name} - Pelican Tray Generator`,
    '',
    `Cutout            ${s.cutoutLength} x ${s.cutoutWidth} x ${s.cutoutDepth} mm`,
    `Grid pitch        ${s.gridPitch} mm`,
    `Pocket clearance  ${s.clearance} mm (single global offset, covers the liner)`,
    `Wall / floor      ${s.wall} / ${s.floor} mm`,
    `Stack tolerance   ${s.stackTolerance} mm per side`,
    s.generateInserts
      ? `Liners            pad ${s.insertPad} mm, wall ${s.insertWall} mm, squeeze ${s.insertSqueeze} mm, ribs every ${s.insertRibSpacing} mm`
      : 'Liners            not generated (use adhesive foam or felt)',
    `Stack height      ${result.stats.stackHeight.toFixed(1)} mm of ${s.cutoutDepth} mm`,
    '',
    'Printing:',
    '  petg-trays/  Tray bodies. PETG: heat tolerance in a vehicle, and tough.',
    '               0.2 mm layers, 3 walls, 15% infill, flat with the feet down,',
    '               no supports.',
    '  tpu-liners/  One liner per pocket, if liners were generated. Print in TPU',
    '               from an external spool, not through the AMS. 0.2 mm layers,',
    '               slow, no supports. Each tray\'s liners are also bundled as a',
    '               single 3MF so they print as one job.',
    '',
    '  The liners hold parts on crush ribs rather than a solid sleeve, because',
    '  TPU is not dimensionally predictable enough for a press fit. If parts',
    '  rattle, raise the rib squeeze; if they are too tight, lower it.',
    '',
    'Trays:',
  ];
  for (const t of result.trays) {
    lines.push(
      `  ${t.name}  ${t.cellsX}x${t.cellsY} cells  ${t.sizeX.toFixed(1)} x ${t.sizeY.toFixed(1)} x ${t.height.toFixed(1)} mm  layer ${t.layer + 1}`,
    );
    for (const p of t.parts) lines.push(`      ${p.name}  pocket depth ${p.depth} mm`);
    for (const w of t.warnings) lines.push(`      ! ${w}`);
  }
  if (result.warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of result.warnings) lines.push(`  ! ${w}`);
  }
  if (result.unplaced.length) {
    lines.push('', 'Not placed:');
    for (const u of result.unplaced) lines.push(`  ! ${u.name} - ${u.reason}`);
  }
  return lines.join('\n') + '\n';
}

/** File-safe name for one pocket's liner. */
function linerName(part: string, instance: number): string {
  const base = part.replace(/[^\w.-]+/g, '_');
  return instance ? `${base}-${instance + 1}` : base;
}
