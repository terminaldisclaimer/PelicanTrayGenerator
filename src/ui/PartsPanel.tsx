import { useRef, useState } from 'react';
import type { PartInput, Project } from '../types';
import { parseSvgSilhouette } from '../lib/svg/parseSvg';
import { partSize, UNIT_CHOICES } from '../lib/part';
import { Panel } from './Field';

let seq = 0;
const nextId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export function PartsPanel({ project, setProject }: {
  project: Project;
  setProject: (updater: (p: Project) => Project) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const added: PartInput[] = [];
    const errs: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const parsed = parseSvgSilhouette(await file.text());
        added.push({
          id: nextId(),
          name: file.name.replace(/\.svg$/i, ''),
          poly: parsed.poly,
          keepHoles: false,
          depth: 20,
          qty: 1,
          groupId: null,
          sourceFile: file.name,
          notes: parsed.notes,
          sourceUnitMm: parsed.unitMm,
          unitOverrideMm: null,
          unitsAmbiguous: parsed.unitsAmbiguous,
          fingerNotches: [],
          placements: [],
        });
      } catch (e) {
        errs.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    setErrors(errs);
    if (added.length) setProject((p) => ({ ...p, parts: [...p.parts, ...added] }));
    if (fileRef.current) fileRef.current.value = '';
  }

  const update = (id: string, patch: Partial<PartInput>) =>
    setProject((p) => ({ ...p, parts: p.parts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const remove = (id: string) =>
    setProject((p) => ({ ...p, parts: p.parts.filter((x) => x.id !== id) }));

  function setGroup(part: PartInput, value: string) {
    if (value === '__new') {
      const name = prompt('Name for the new group', `Group ${project.groups.length + 1}`);
      if (!name) return;
      const id = `g${Date.now().toString(36)}`;
      setProject((p) => ({
        ...p,
        groups: [...p.groups, { id, name }],
        parts: p.parts.map((x) => (x.id === part.id ? { ...x, groupId: id } : x)),
      }));
    } else {
      update(part.id, { groupId: value || null });
    }
  }

  return (
    <Panel
      title={`Parts (${project.parts.length})`}
      aside={
        <button className="primary small" onClick={() => fileRef.current?.click()}>
          Add SVG outlines
        </button>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        multiple
        hidden
        onChange={(e) => void addFiles(e.target.files)}
      />

      {errors.map((e) => <p className="error" key={e}>{e}</p>)}

      {project.parts.length === 0 && (
        <p className="muted">
          Upload the top-down outlines traced on the Shaper Origin, one SVG per part. Real-world
          units are read from the SVG; unitless files are assumed to be 96 dpi pixels.
        </p>
      )}

      {project.parts.length > 0 && (
        <table className="parts">
          <colgroup>
            <col />
            <col className="c-depth" />
            <col className="c-qty" />
            <col className="c-group" />
            <col className="c-holes" />
            <col className="c-del" />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Depth</th>
              <th>Qty</th>
              <th>Group</th>
              <th>Holes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {project.parts.map((part) => {
              const size = partSize(part);
              const unsure = part.unitsAmbiguous && part.unitOverrideMm === null;
              return (
                <tr key={part.id} className={unsure ? 'unsure' : undefined}>
                  <td>
                    <input
                      className="name"
                      value={part.name}
                      onChange={(e) => update(part.id, { name: e.target.value })}
                    />
                    <span className="mono sub">
                      {size.w.toFixed(1)} x {size.h.toFixed(1)} mm
                      <em className="inch"> ({(size.w / 25.4).toFixed(2)} x {(size.h / 25.4).toFixed(2)} in)</em>
                    </span>
                    {part.unitsAmbiguous && (
                      <select
                        className="units"
                        value={part.unitOverrideMm ?? ''}
                        title="This file carried no real-world size. If the dimensions above are wrong, say what the drawing's units are."
                        onChange={(e) =>
                          update(part.id, { unitOverrideMm: e.target.value ? Number(e.target.value) : null })
                        }
                      >
                        <option value="">units: guessed</option>
                        {UNIT_CHOICES.map((u) => (
                          <option key={u.label} value={u.mm}>units: {u.label}</option>
                        ))}
                      </select>
                    )}
                    {part.notes.length > 0 && (
                      <span className="note" title={part.notes.join('\n')}>{part.notes.length} note{part.notes.length > 1 ? 's' : ''}</span>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      className="num"
                      min={1}
                      max={500}
                      step={0.5}
                      value={part.depth}
                      onChange={(e) => update(part.id, { depth: Math.max(1, parseFloat(e.target.value) || 1) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      className="num tiny"
                      min={1}
                      max={99}
                      step={1}
                      value={part.qty}
                      onChange={(e) => update(part.id, { qty: Math.max(1, Math.round(parseFloat(e.target.value) || 1)) })}
                    />
                  </td>
                  <td>
                    <select value={part.groupId ?? ''} onChange={(e) => setGroup(part, e.target.value)}>
                      <option value="">none</option>
                      {project.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      <option value="__new">New group...</option>
                    </select>
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={part.keepHoles}
                      title="Keep interior outlines as islands standing in the pocket"
                      onChange={(e) => update(part.id, { keepHoles: e.target.checked })}
                    />
                  </td>
                  <td>
                    <button className="ghost small" onClick={() => remove(part.id)} title="Remove">x</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
