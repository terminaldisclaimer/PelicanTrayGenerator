// Parts library API, backed by Workers KV (binding PARTS). Everything on this
// hostname sits behind Cloudflare Access; as defence in depth we also require
// the Access JWT header that Access adds to every authenticated request.
//
//   GET    /api/parts            -> [{ name, size, uploaded, version }]
//   GET    /api/parts/<name>     -> file bytes
//   PUT    /api/parts/<name>     -> store (body = file, optional X-Part-Version)
//   DELETE /api/parts/<name>
//   POST   /api/parts/<name>     -> move: JSON body { "folder": "<name or empty>" }
//
// Parts sit in library folders (a label on each part; names stay unique across
// the whole library). PUT takes an optional X-Part-Folder; re-uploading a part
// without it leaves the part in the folder it is in.
//
//   GET    /api/folders          -> ["AVS", ...] (created folders plus any in use)
//   PUT    /api/folders/<name>   -> create
//   DELETE /api/folders/<name>   -> remove (only when no part is in it)
//
// Saved projects use the same four calls under /api/projects/<name> (no file
// extension; optional X-Project-Saved-At and X-Project-Parts headers).
const MAX_BYTES = 25 * 1024 * 1024; // KV value limit
const NAME_RE = /^[\w .()+,\-]{1,120}\.(3mf|stl)$/i;
const PROJECT_RE = /^[\w .()+,\-]{1,60}$/;
const FOLDER_RE = /^[\w .()+,\-]{1,40}$/;
const FOLDERS_KEY = 'meta/folders';
const KINDS = {
  parts: { re: NAME_RE, hint: 'Name must be letters, digits, spaces or _.()+,- and end in .3mf or .stl' },
  projects: { re: PROJECT_RE, hint: 'Project name must be letters, digits, spaces or _.()+,-' },
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.PARTS.list({ prefix, cursor });
    for (const k of page.keys) out.push({ name: k.name.slice(prefix.length), ...(k.metadata || {}) });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
async function createdFolders(env) {
  try { const v = JSON.parse((await env.PARTS.get(FOLDERS_KEY, 'text')) || '[]'); return Array.isArray(v) ? v.filter((f) => typeof f === 'string' && FOLDER_RE.test(f)) : []; } catch { return []; }
}
const saveFolders = (env, list) => env.PARTS.put(FOLDERS_KEY, JSON.stringify([...new Set(list)].sort((a, b) => a.localeCompare(b))), { metadata: {} });

async function handleFolders(request, env, raw) {
  if (raw === undefined) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const used = (await listAll(env, 'parts/')).map((p) => p.folder).filter(Boolean);
    return json([...new Set([...(await createdFolders(env)), ...used])].sort((a, b) => a.localeCompare(b)));
  }
  let name;
  try { name = decodeURIComponent(raw).trim(); } catch { return json({ error: 'Bad name' }, 400); }
  if (!FOLDER_RE.test(name)) return json({ error: 'Folder name must be 1-40 letters, digits, spaces or _.()+,-' }, 400);
  if (request.method === 'PUT') {
    await saveFolders(env, [...(await createdFolders(env)), name]);
    return json({ folder: name });
  }
  if (request.method === 'DELETE') {
    if ((await listAll(env, 'parts/')).some((p) => p.folder === name)) return json({ error: 'Move or delete the parts in this folder first' }, 409);
    await saveFolders(env, (await createdFolders(env)).filter((f) => f !== name));
    return json({ deleted: name });
  }
  return json({ error: 'Method not allowed' }, 405);
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (!request.headers.get('Cf-Access-Jwt-Assertion')) return json({ error: 'Not authenticated' }, 401);
  // Browsers send Origin on cross-site writes; refuse anything not from us.
  const origin = request.headers.get('Origin');
  if (request.method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Bad origin' }, 403);

  const m = /^\/api\/(parts|projects|folders)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  if (m[1] === 'folders') return handleFolders(request, env, m[2]);
  const kind = m[1], prefix = kind + '/';

  if (m[2] === undefined) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return json(await listAll(env, prefix));
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
    if (kind === 'parts') {
      metadata.version = (request.headers.get('X-Part-Version') || '').slice(0, 40);
      // A named folder files the part there; without one a part that is already in the library stays where it is.
      const asked = request.headers.get('X-Part-Folder');
      let folder;
      if (asked !== null) {
        try { folder = decodeURIComponent(asked).trim(); } catch { return json({ error: 'Bad folder name' }, 400); }
        if (folder && !FOLDER_RE.test(folder)) return json({ error: 'Folder name must be 1-40 letters, digits, spaces or _.()+,-' }, 400);
      } else folder = (await listAll(env, key)).find((p) => p.name === '')?.folder;
      if (folder) metadata.folder = folder;
    } else {
      metadata.savedAt = (request.headers.get('X-Project-Saved-At') || metadata.uploaded).slice(0, 40);
      metadata.parts = Number(request.headers.get('X-Project-Parts')) || 0;
    }
    await env.PARTS.put(key, body, { metadata });
    return json({ name, ...metadata });
  }
  if (request.method === 'POST' && kind === 'parts') {
    let folder;
    try { folder = (await request.json()).folder; } catch { return json({ error: 'Bad request' }, 400); }
    if (typeof folder !== 'string' || (folder !== '' && !FOLDER_RE.test(folder))) return json({ error: 'Folder name must be 1-40 letters, digits, spaces or _.()+,-' }, 400);
    const old = (await listAll(env, key)).find((p) => p.name === '');
    const body = old && (await env.PARTS.get(key, 'arrayBuffer'));
    if (!body) return json({ error: 'Not found' }, 404);
    // KV keeps the label with the value, so moving rewrites the part under the same name.
    const { name: _n, folder: _f, ...rest } = old;
    const metadata = folder ? { ...rest, folder } : rest;
    await env.PARTS.put(key, body, { metadata });
    return json({ name, ...metadata });
  }
  if (request.method === 'DELETE') {
    await env.PARTS.delete(key);
    return json({ deleted: name });
  }
  return json({ error: 'Method not allowed' }, 405);
}
