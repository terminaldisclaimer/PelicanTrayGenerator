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
    if (format === 'stl') download(meshToStl(mesh), `${name}.stl`, 'model/stl');
    else download(meshTo3mf(mesh, tray.name), `${name}.3mf`, 'model/3mf');
  }, [meshes, inserts, fileBase]);

  const exportAll = useCallback(() => {
    if (!result) return;
    const files: Record<string, Uint8Array> = {};
    for (const tray of result.trays) {
      const mesh = meshes.get(tray.id);
      if (!mesh) continue;
      const name = tray.name.replace(/\s+/g, '');
      files[`petg-trays/3mf/${name}.3mf`] = meshTo3mf(mesh, tray.name);
      files[`petg-trays/stl/${name}.stl`] = meshToStl(mesh);

      const set = inserts.get(tray.id);
      if (set?.length) {
        files[`tpu-liners/3mf/${name}-liners.3mf`] = meshesTo3mf(set, `${tray.name} liners`);
        for (const liner of set) {
          files[`tpu-liners/stl/${name}-${liner.name}.stl`] = meshToStl(liner.mesh);
        }
      }
    }
    files['print-notes.txt'] = new TextEncoder().encode(printNotes(project, result));
    files['project.traygen.json'] = new TextEncoder().encode(JSON.stringify(project, null, 2));
    download(zipFiles(files), `${fileBase}.zip`, 'application/zip');
  }, [result, meshes, inserts, project, fileBase]);

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
