// Parts library API, backed by Workers KV (binding PARTS). Everything on this
// hostname sits behind Cloudflare Access; as defence in depth we also require
// the Access JWT header that Access adds to every authenticated request.
//
//   GET    /api/parts            -> [{ name, size, uploaded, version }]
//   GET    /api/parts/<name>     -> file bytes
//   PUT    /api/parts/<name>     -> store (body = file, optional X-Part-Version)
//   DELETE /api/parts/<name>
//
// Saved projects use the same four calls under /api/projects/<name> (no file
// extension; optional X-Project-Saved-At and X-Project-Parts headers).
const MAX_BYTES = 25 * 1024 * 1024; // KV value limit
const NAME_RE = /^[\w .()+,\-]{1,120}\.(3mf|stl)$/i;
const PROJECT_RE = /^[\w .()+,\-]{1,60}$/;
const KINDS = {
  parts: { re: NAME_RE, hint: 'Name must be letters, digits, spaces or _.()+,- and end in .3mf or .stl' },
  projects: { re: PROJECT_RE, hint: 'Project name must be letters, digits, spaces or _.()+,-' },
};
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

  const m = /^\/api\/(parts|projects)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  const kind = m[1], prefix = kind + '/';

  if (m[2] === undefined) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const out = [];
    let cursor;
    do {
      const page = await env.PARTS.list({ prefix, cursor });
      for (const k of page.keys) out.push({ name: k.name.slice(prefix.length), ...(k.metadata || {}) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json(out);
  }

  let name;
  try { name = decodeURIComponent(m[2]); } catch { return json({ error: 'Bad name' }, 400); }
  if (!KINDS[kind].re.test(name)) return json({ error: KINDS[kind].hint }, 400);
  const key = prefix + name;

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
    const metadata = { size: body.byteLength, uploaded: new Date().toISOString() };
    if (kind === 'parts') metadata.version = (request.headers.get('X-Part-Version') || '').slice(0, 40);
    else {
      metadata.savedAt = (request.headers.get('X-Project-Saved-At') || metadata.uploaded).slice(0, 40);
      metadata.parts = Number(request.headers.get('X-Project-Parts')) || 0;
    }
    await env.PARTS.put(key, body, { metadata });
    return json({ name, ...metadata });
  }
  if (request.method === 'DELETE') {
    await env.PARTS.delete(key);
    return json({ deleted: name });
  }
  return json({ error: 'Method not allowed' }, 405);
}
