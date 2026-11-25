import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS worker module
import { handleApi, MAX_VERSIONS } from '../../worker/api.js';

function fakeKV() {
  const store = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
  return {
    store,
    async get(k: string) { return store.get(k)?.value ?? null; },
    async getWithMetadata(k: string) { const e = store.get(k); return { value: e?.value ?? null, metadata: e?.metadata ?? null }; },
    async put(k: string, value: ArrayBuffer, o: { metadata: unknown }) { store.set(k, { value, metadata: o.metadata }); },
    async delete(k: string) { store.delete(k); },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true };
    },
  };
}
const auth = { 'Cf-Access-Jwt-Assertion': 'x' };
const req = (method: string, path: string, init: RequestInit = {}) =>
  new Request('https://pelican.example' + path, { method, ...init, headers: { ...auth, ...(init.headers as object) } });

describe('parts API', () => {
  it('ignores non-API paths', async () => {
    expect(await handleApi(req('GET', '/index.html'), { PARTS: fakeKV() })).toBeNull();
  });

  it('rejects requests without the Access header', async () => {
    const r = await handleApi(new Request('https://pelican.example/api/parts'), { PARTS: fakeKV() });
    expect(r.status).toBe(401);
  });

  it('stores, lists, returns and deletes a part', async () => {
    const env = { PARTS: fakeKV() };
    const put = await handleApi(req('PUT', '/api/parts/Bracket%20v2.3mf', { body: new Uint8Array([1, 2, 3]), headers: { 'X-Part-Version': '7' } }), env);
    expect(put.status).toBe(200);
    const list = await (await handleApi(req('GET', '/api/parts'), env)).json();
    expect(list).toMatchObject([{ name: 'Bracket v2.3mf', size: 3, version: '7' }]);
    const got = await handleApi(req('GET', '/api/parts/Bracket%20v2.3mf'), env);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await handleApi(req('DELETE', '/api/parts/Bracket%20v2.3mf'), env);
    expect(env.PARTS.store.size).toBe(0);
  });

  it('rejects bad names, empty bodies and foreign origins', async () => {
    const env = { PARTS: fakeKV() };
    expect((await handleApi(req('PUT', '/api/parts/evil.html', { body: 'x' }), env)).status).toBe(400);
    expect((await handleApi(req('PUT', '/api/parts/..%2Fx.3mf', { body: 'x' }), env)).status).toBe(400);
    expect((await handleApi(req('PUT', '/api/parts/a.3mf'), env)).status).toBe(400);
    expect((await handleApi(req('PUT', '/api/parts/a.3mf', { body: 'x', headers: { Origin: 'https://evil.example' } }), env)).status).toBe(403);
    expect(env.PARTS.store.size).toBe(0);
  });

  it('stores and lists saved projects separately from parts', async () => {
    const env = { PARTS: fakeKV() };
    await handleApi(req('PUT', '/api/parts/a.3mf', { body: new Uint8Array([1]) }), env);
    const put = await handleApi(req('PUT', '/api/projects/My%20tray', { body: new Uint8Array([9, 9]), headers: { 'X-Project-Saved-At': '2026-11-22T10:00:00Z', 'X-Project-Parts': '4' } }), env);
    expect(put.status).toBe(200);
    expect(await (await handleApi(req('GET', '/api/projects'), env)).json()).toMatchObject([{ name: 'My tray', size: 2, savedAt: '2026-11-22T10:00:00Z', parts: 4 }]);
    expect(await (await handleApi(req('GET', '/api/parts'), env)).json()).toHaveLength(1);
    const got = await handleApi(req('GET', '/api/projects/My%20tray'), env);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    expect((await handleApi(req('PUT', '/api/projects/bad%2Fname', { body: 'x' }), env)).status).toBe(400);
    await handleApi(req('DELETE', '/api/projects/My%20tray'), env);
    expect(await (await handleApi(req('GET', '/api/projects'), env)).json()).toEqual([]);
  });

  it('library folders: create, file parts, move them, and keep the folder on re-upload', async () => {
    const env = { PARTS: fakeKV() };
    const names = async () => (await (await handleApi(req('GET', '/api/folders'), env)).json()) as string[];
    const folderOf = async (n: string) => ((await (await handleApi(req('GET', '/api/parts'), env)).json()) as { name: string; folder?: string }[]).find((p) => p.name === n)?.folder;
    expect(await names()).toEqual([]);
    expect((await handleApi(req('PUT', '/api/folders/AVS'), env)).status).toBe(200);
    expect((await handleApi(req('PUT', '/api/folders/bad%2Fname'), env)).status).toBe(400);
    await handleApi(req('PUT', '/api/parts/a.3mf', { body: new Uint8Array([1]), headers: { 'X-Part-Version': '3' } }), env);
    expect(await folderOf('a.3mf')).toBeUndefined();
    // Move into a folder, even one not created first; the file and its details are kept.
    expect((await handleApi(req('POST', '/api/parts/a.3mf', { body: JSON.stringify({ folder: 'Camera kit' }) }), env)).status).toBe(200);
    expect(await folderOf('a.3mf')).toBe('Camera kit');
    expect(await names()).toEqual(['AVS', 'Camera kit']);
    expect(await (await handleApi(req('GET', '/api/parts'), env)).json()).toMatchObject([{ name: 'a.3mf', size: 1, version: '3', folder: 'Camera kit' }]);
    expect(new Uint8Array(await (await handleApi(req('GET', '/api/parts/a.3mf'), env)).arrayBuffer())).toEqual(new Uint8Array([1]));
    // Re-uploading (e.g. from Fusion) without naming a folder leaves it where it is; naming one files it there.
    await handleApi(req('PUT', '/api/parts/a.3mf', { body: new Uint8Array([1, 2]) }), env);
    expect(await folderOf('a.3mf')).toBe('Camera kit');
    await handleApi(req('PUT', '/api/parts/b.stl', { body: new Uint8Array([5]), headers: { 'X-Part-Folder': 'AVS' } }), env);
    expect(await folderOf('b.stl')).toBe('AVS');
    // A folder with parts in it cannot be removed; an empty one can.
    expect((await handleApi(req('DELETE', '/api/folders/AVS'), env)).status).toBe(409);
    await handleApi(req('POST', '/api/parts/b.stl', { body: JSON.stringify({ folder: '' }) }), env);
    expect(await folderOf('b.stl')).toBeUndefined();
    expect((await handleApi(req('DELETE', '/api/folders/AVS'), env)).status).toBe(200);
    expect(await names()).toEqual(['Camera kit']);
    expect((await handleApi(req('POST', '/api/parts/missing.stl', { body: JSON.stringify({ folder: 'AVS' }) }), env)).status).toBe(404);
    // The folder list is not a part or a project.
    expect(await (await handleApi(req('GET', '/api/projects'), env)).json()).toEqual([]);
  });

  it('projects belong to the signed-in user, keep a version on each real save, and can be renamed', async () => {
    const env = { PARTS: fakeKV() };
    const as = (email: string) => (method: string, path: string, init: RequestInit = {}) => handleApi(req(method, path, { ...init, headers: { 'Cf-Access-Authenticated-User-Email': email, ...(init.headers as object) } }), env);
    const ann = as('Ann@Example.com'), bob = as('bob@example.com');
    expect(await (await ann('GET', '/api/me')).json()).toEqual({ user: 'ann@example.com' });
    const save = (who: typeof ann, name: string, body: number[], version: boolean, id = 'proj-ann-0001') =>
      who('PUT', `/api/projects/${encodeURIComponent(name)}`, { body: new Uint8Array(body), headers: { 'X-Project-Id': id, 'X-Project-Parts': '2', ...(version ? { 'X-Project-Version': '1' } : {}) } });
    const versions = async (who: typeof ann, name: string) => (await (await who('GET', `/api/projects/${encodeURIComponent(name)}/versions`)).json()) as { version: string; size: number }[];
    const tick = () => new Promise((r) => setTimeout(r, 3)); // versions are named by time

    // An autosave only replaces the working copy; a real save also keeps a version.
    expect((await save(ann, 'Tray', [1], false)).status).toBe(200);
    expect(await versions(ann, 'Tray')).toEqual([]);
    await save(ann, 'Tray', [1, 2], true); await tick();
    await save(ann, 'Tray', [1, 2, 3], false);
    await save(ann, 'Tray', [1, 2, 3, 4], true);
    const v = await versions(ann, 'Tray');
    expect(v.map((x) => x.size)).toEqual([4, 2]); // newest first
    expect(new Uint8Array(await (await ann('GET', `/api/projects/Tray/versions/${encodeURIComponent(v[1].version)}`)).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(new Uint8Array(await (await ann('GET', '/api/projects/Tray')).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

    // Someone else sees none of it, and can use the same name for their own.
    expect(await (await bob('GET', '/api/projects')).json()).toEqual([]);
    expect((await bob('GET', '/api/projects/Tray')).status).toBe(404);
    expect((await bob('GET', '/api/projects/Tray/versions')).status).toBe(404);
    await save(bob, 'Tray', [9], true, 'proj-bob-0001');
    expect(await (await ann('GET', '/api/projects')).json()).toMatchObject([{ name: 'Tray', id: 'proj-ann-0001', size: 4, parts: 2 }]);
    expect((await versions(bob, 'Tray')).map((x) => x.size)).toEqual([1]);

    // Renaming keeps the contents and the versions, and will not overwrite another project.
    await save(ann, 'Other', [7], false, 'proj-ann-0002');
    expect((await ann('POST', '/api/projects/Tray', { body: JSON.stringify({ rename: 'Other' }) })).status).toBe(409);
    expect((await ann('POST', '/api/projects/Tray', { body: JSON.stringify({ rename: 'bad/name' }) })).status).toBe(400);
    expect((await ann('POST', '/api/projects/Tray', { body: JSON.stringify({ rename: 'AVS case' }) })).status).toBe(200);
    expect((await ann('GET', '/api/projects/Tray')).status).toBe(404);
    expect(new Uint8Array(await (await ann('GET', '/api/projects/AVS%20case')).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await versions(ann, 'AVS case')).map((x) => x.size)).toEqual([4, 2]);
    expect((await versions(bob, 'Tray')).map((x) => x.size)).toEqual([1]); // untouched

    // A single version can be removed; deleting the project removes the rest, and only that project's.
    const [newest] = await versions(ann, 'AVS case');
    await ann('DELETE', `/api/projects/AVS%20case/versions/${encodeURIComponent(newest.version)}`);
    expect((await versions(ann, 'AVS case')).map((x) => x.size)).toEqual([2]);
    await ann('DELETE', '/api/projects/AVS%20case');
    expect([...env.PARTS.store.keys()].filter((k) => k.includes('ann')).sort()).toEqual(['projects/ann%40example.com/Other']);
    expect([...env.PARTS.store.keys()].filter((k) => k.includes('bob'))).toHaveLength(2);
    expect((await ann('GET', '/api/projects/x/y/z/w')).status).toBe(404);
  });

  it('keeps only the newest versions of a project', async () => {
    const env = { PARTS: fakeKV() };
    for (let i = 0; i < MAX_VERSIONS + 3; i++) {
      await handleApi(req('PUT', '/api/projects/Tray', { body: new Uint8Array([i + 1]), headers: { 'X-Project-Id': 'proj-0001', 'X-Project-Version': '1' } }), env);
      await new Promise((r) => setTimeout(r, 2));
    }
    const list = (await (await handleApi(req('GET', '/api/projects/Tray/versions'), env)).json()) as { version: string }[];
    expect(list).toHaveLength(MAX_VERSIONS);
    // The oldest three are the ones that went.
    const oldest = list[list.length - 1].version;
    expect(new Uint8Array(await (await handleApi(req('GET', `/api/projects/Tray/versions/${encodeURIComponent(oldest)}`), env)).arrayBuffer())).toEqual(new Uint8Array([4]));
  });
});
