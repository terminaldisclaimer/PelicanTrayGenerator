// Parts library API, backed by Workers KV (binding PARTS). Everything on this
// hostname sits behind Cloudflare Access; as defence in depth we also require
// the Access JWT header that Access adds to every authenticated request.
//
//   GET    /api/parts            -> [{ name, size, uploaded, version }]
//   GET    /api/parts/<name>     -> file bytes
//   PUT    /api/parts/<name>     -> store (body = file, optional X-Part-Version)
//   DELETE /api/parts/<name>
const MAX_BYTES = 25 * 1024 * 1024; // KV value limit
const NAME_RE = /^[\w .()+,\-]{1,120}\.(3mf|stl)$/i;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (!request.headers.get('Cf-Access-Jwt-Assertion')) return json({ error: 'Not authenticated' }, 401);
  // Browsers send Origin on cross-site writes; refuse anything not from us.
  const origin = request.headers.get('Origin');
  if (request.method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Bad origin' }, 403);

  if (url.pathname === '/api/parts' && request.method === 'GET') {
    const out = [];
    let cursor;
    do {
      const page = await env.PARTS.list({ prefix: 'parts/', cursor });
      for (const k of page.keys) out.push({ name: k.name.slice(6), ...(k.metadata || {}) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json(out);
  }

  const m = /^\/api\/parts\/([^/]+)$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  let name;
  try { name = decodeURIComponent(m[1]); } catch { return json({ error: 'Bad name' }, 400); }
  if (!NAME_RE.test(name)) return json({ error: 'Name must be letters, digits, spaces or _.()+,- and end in .3mf or .stl' }, 400);
  const key = 'parts/' + name;

  if (request.method === 'GET') {
    const body = await env.PARTS.get(key, 'arrayBuffer');
    if (!body) return json({ error: 'Not found' }, 404);
    return new Response(body, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }
  if (request.method === 'PUT') {
    if (Number(request.headers.get('content-length') || 0) > MAX_BYTES) return json({ error: 'File larger than 25 MB' }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return json({ error: 'Empty file' }, 400);
    if (body.byteLength > MAX_BYTES) return json({ error: 'File larger than 25 MB' }, 413);
    const version = (request.headers.get('X-Part-Version') || '').slice(0, 40);
    const metadata = { size: body.byteLength, uploaded: new Date().toISOString(), version };
    await env.PARTS.put(key, body, { metadata });
    return json({ name, ...metadata });
  }
  if (request.method === 'DELETE') {
    await env.PARTS.delete(key);
    return json({ deleted: name });
  }
  return json({ error: 'Method not allowed' }, 405);
}
