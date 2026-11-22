import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS worker module
import { handleApi } from '../../worker/api.js';

function fakeKV() {
  const store = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
  return {
    store,
    async get(k: string) { return store.get(k)?.value ?? null; },
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
});
