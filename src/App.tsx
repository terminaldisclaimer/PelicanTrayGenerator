import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Settings, SolveResult, Tray } from './types';
import { emptyProject } from './defaults';
import { initCad, type TriMesh } from './lib/cad/manifold';
import { buildTrayMesh } from './lib/cad/tray';
import { solve } from './lib/solver/solve';
import { meshToStl } from './lib/export/stl';
import { download, meshTo3mf, zipFiles } from './lib/export/threemf';
import { autosave, loadAutosave, loadProjectFile, saveProjectFile } from './lib/project';
import { CasePanel, SettingsPanel } from './ui/SettingsPanel';
import { PartsPanel } from './ui/PartsPanel';
import { ResultsPanel } from './ui/ResultsPanel';
import { Preview } from './three/Preview';
import { REG } from './lib/cad/profile';

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export default function App() {
  const [project, setProjectState] = useState<Project>(() => loadAutosave() ?? emptyProject());
  const [result, setResult] = useState<SolveResult | null>(null);
  const [meshes, setMeshes] = useState<Map<string, TriMesh>>(new Map());
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [exploded, setExploded] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [frameRequest, setFrameRequest] = useState<{ n: number; mode: 'iso' | 'top' }>({ n: 0, mode: 'iso' });
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
      const built = new Map<string, TriMesh>();
      for (let i = 0; i < res.trays.length; i++) {
        setBusy(`Building geometry ${i + 1} of ${res.trays.length}...`);
        await yieldToUi();
        built.set(res.trays[i].id, buildTrayMesh(res.trays[i], project.settings));
        setMeshes(new Map(built));
      }
      setStale(false);
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }, [ready, project]);

  const fileBase = useMemo(
    () => (project.name || 'trays').replace(/[^\w.-]+/g, '_'),
    [project.name],
  );

  const exportTray = useCallback((tray: Tray, format: 'stl' | '3mf') => {
    const mesh = meshes.get(tray.id);
    if (!mesh) return;
    const name = `${fileBase}-${tray.name.replace(/\s+/g, '')}`;
    if (format === 'stl') download(meshToStl(mesh), `${name}.stl`, 'model/stl');
    else download(meshTo3mf(mesh, tray.name), `${name}.3mf`, 'model/3mf');
  }, [meshes, fileBase]);

  const exportAll = useCallback(() => {
    if (!result) return;
    const files: Record<string, Uint8Array> = {};
    for (const tray of result.trays) {
      const mesh = meshes.get(tray.id);
      if (!mesh) continue;
      const name = tray.name.replace(/\s+/g, '');
      files[`3mf/${name}.3mf`] = meshTo3mf(mesh, tray.name);
      files[`stl/${name}.stl`] = meshToStl(mesh);
    }
    files['print-notes.txt'] = new TextEncoder().encode(printNotes(project, result));
    files['project.traygen.json'] = new TextEncoder().encode(JSON.stringify(project, null, 2));
    download(zipFiles(files), `${fileBase}.zip`, 'application/zip');
  }, [result, meshes, project, fileBase]);

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
          <ResultsPanel
            result={result}
            selected={selected}
            onSelect={setSelected}
            onExport={exportTray}
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
            <label className={(result?.stats.layerCount ?? 0) < 2 ? 'disabled' : undefined}>
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
            </label>
            <button className="ghost small" onClick={() => reframe('iso')}>Iso</button>
            <button className="ghost small" onClick={() => reframe('top')}>Top</button>
            {stale && result && <span className="badge warnbadge">Inputs changed - regenerate</span>}
            {selected && <span className="badge">{result?.trays.find((t) => t.id === selected)?.name}</span>}
          </div>
          <Preview
            result={result}
            settings={project.settings}
            meshes={meshes}
            exploded={exploded}
            selected={selected}
            onSelect={setSelected}
            frameRequest={frameRequest}
          />
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
    `Stack height      ${result.stats.stackHeight.toFixed(1)} mm of ${s.cutoutDepth} mm`,
    '',
    'Suggested printing:',
    '  Material   PETG for tray bodies (heat tolerance in a vehicle, tough).',
    '  Liner      Adhesive foam or felt in each pocket, or a printed TPU insert',
    '             (TPU runs from an external spool, not through the AMS).',
    '  Layer      0.2 mm, 3 walls, 15% infill. Trays print flat, feet down, no supports.',
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
