import { describe, expect, it } from 'vitest';
import { parseSTL, writeSTL } from '../src/mesh/stl';
import { parse3MF } from '../src/mesh/threemf';
import { centerOnBed, looksLikeInches, meshBounds, scaleMesh, size } from '../src/mesh/bounds';
import { asciiSTL, box3MF, boxMesh } from './fixtures';
import { cloudName, decodeProject, encodeProject } from '../src/storage';

describe('STL', () => {
  it('round-trips binary STL', () => {
    const box = boxMesh(10, 20, 30);
    const back = parseSTL(writeSTL(box));
    expect(back.positions.length).toBe(12 * 9);
    expect(Array.from(back.positions)).toEqual(Array.from(box.positions));
  });

  it('parses ASCII STL', () => {
    const text = asciiSTL(boxMesh(4, 5, 6));
    const m = parseSTL(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(size(meshBounds(m))).toEqual([4, 5, 6]);
  });

  it('treats a binary file whose header starts with "solid" as binary', () => {
    const buf = writeSTL(boxMesh(1, 2, 3));
    new Uint8Array(buf).set(new TextEncoder().encode('solid exported-by-cad'), 0);
    expect(parseSTL(buf).positions.length).toBe(108);
  });

  it('rejects garbage', () => {
    expect(() => parseSTL(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow();
  });
});

describe('3MF', () => {
  it('parses a simple model with its name', () => {
    const [m] = parse3MF(box3MF());
    expect(m.name).toBe('widget');
    expect(size(meshBounds(m))).toEqual([10, 20, 5]);
  });

  it('converts units to mm', () => {
    const [m] = parse3MF(box3MF({ unit: 'inch' }));
    expect(size(meshBounds(m))[0]).toBeCloseTo(254);
  });

  it('applies build item transforms (90° about Z + translate)', () => {
    const [m] = parse3MF(box3MF({ transform: '0 1 0 -1 0 0 0 0 1 50 0 0' }));
    const b = meshBounds(m);
    expect(size(b)[0]).toBeCloseTo(20);
    expect(size(b)[1]).toBeCloseTo(10);
    expect(b.max[0]).toBeCloseTo(50);
  });

  it('flattens components', () => {
    const [m] = parse3MF(box3MF({ component: true }));
    expect(meshBounds(m).min[0]).toBeCloseTo(100);
    expect(m.name).toBe('assembly');
  });
});

describe('bounds & units', () => {
  it('centres on bed', () => {
    const b = meshBounds(centerOnBed(boxMesh(10, 20, 30)));
    expect(b.min).toEqual([-5, -10, 0]);
    expect(b.max).toEqual([5, 10, 30]);
  });

  it('flags inch-sized parts and scales them', () => {
    const tiny = boxMesh(2, 3, 1);
    expect(looksLikeInches(meshBounds(tiny))).toBe(true);
    const mm = scaleMesh(tiny, 25.4);
    expect(looksLikeInches(meshBounds(mm))).toBe(false);
    expect(size(meshBounds(mm))[0]).toBeCloseTo(50.8);
  });
});

describe('project file', () => {
  it('round-trips settings, choices and meshes', () => {
    const a = boxMesh(10, 20, 30).positions, b = boxMesh(1, 2, 3).positions;
    const project = {
      name: 'My tray', savedAt: '2026-11-22T10:00:00Z', settings: { length: 112.52, width: 238.76, stacking: true },
      parts: [
        { name: 'bubbler', positions: a, poseIndex: 2, locked: true, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], fingers: 'auto' as const, stackable: true },
        { name: 'pen', positions: b, poseIndex: 0, locked: false, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], fingers: ['top' as const], stackable: false },
      ],
    };
    const back = decodeProject(encodeProject(project));
    expect(back.settings).toEqual(project.settings);
    expect(back.parts.map((p) => [p.name, p.poseIndex, p.locked, p.fingers, p.stackable])).toEqual([['bubbler', 2, true, 'auto', true], ['pen', 0, false, ['top'], false]]);
    expect(Array.from(back.parts[0].positions)).toEqual(Array.from(a));
    expect(Array.from(back.parts[1].positions)).toEqual(Array.from(b));
    expect(() => decodeProject(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow();
  });
  it('makes cloud-safe names', () => {
    expect(cloudName('My tray #2 / "test"')).toBe('My tray _2 _ _test_');
    expect(cloudName('')).toBe('project');
  });
});

describe('notes and multi-body parts in saved files', () => {
  it('a 3MF carries a named note, readable back, special characters and all', async () => {
    const { write3MF, read3MFMetadata, parse3MF } = await import('../src/mesh/threemf');
    const note = JSON.stringify({ d: 6, name: 'a "quoted" <cable> & co' });
    const zip = write3MF([boxMesh(10, 10, 10, 'cable')], 'Cable', { CutoutsCable: note });
    const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
    expect(read3MFMetadata(buf, 'CutoutsCable')).toBe(note);
    expect(read3MFMetadata(buf, 'Missing')).toBeNull();
    expect(parse3MF(buf)).toHaveLength(1); // still an ordinary 3MF
    expect(read3MFMetadata(new ArrayBuffer(8), 'CutoutsCable')).toBeNull();
  });

  it('a saved project keeps a multi-body part\'s bodies and a cable\'s settings', async () => {
    const { encodeProject, decodeProject } = await import('../src/storage');
    const a = boxMesh(10, 10, 10, 'a').positions, b = boxMesh(4, 4, 20, 'b').positions;
    const both = new Float32Array([...a, ...b]);
    const p = {
      name: 'P', id: 'abc123456789', savedAt: '2026-11-25T10:00:00Z', settings: { length: 300 },
      parts: [
        { name: 'kit', positions: a, poseIndex: 0, locked: false, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], fingers: 'auto' as const,
          bodies: [{ name: 'a', on: true, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], move: [0, 0, 0] as [number, number, number], floats: a.length }, { name: 'b', on: false, rot: [0, -1, 0, 1, 0, 0, 0, 0, 1], move: [5, 0, -2] as [number, number, number], floats: b.length }],
          bodyPositions: both },
        { name: 'plain', positions: b, poseIndex: -1, locked: true, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], fingers: ['top' as const], cable: { d: 6, top: { at: 4.5 } } },
      ],
    };
    const back = decodeProject(encodeProject(p));
    expect(back.id).toBe('abc123456789');
    expect(back.parts[0].positions).toEqual(a);
    expect(back.parts[0].bodyPositions).toEqual(both);
    expect(back.parts[0].bodies).toEqual(p.parts[0].bodies);
    expect(back.parts[1].positions).toEqual(b); // the part after it starts in the right place
    expect(back.parts[1].bodyPositions).toBeUndefined();
    expect(back.parts[1].cable).toEqual({ d: 6, top: { at: 4.5 } });
  });
});
