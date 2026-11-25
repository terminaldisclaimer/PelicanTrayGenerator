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
// Saved projects belong to the signed-in user (the email Cloudflare Access
// passes on); each user sees only their own. The parts library is shared.
//
//   GET    /api/me                               -> { user }
//   GET    /api/projects                         -> [{ name, id, size, savedAt, parts }]
//   GET    /api/projects/<name>                  -> file bytes (the working copy)
//   PUT    /api/projects/<name>                  -> store the working copy. Headers: X-Project-Id
//                                                   (stays with the project through renames),
//                                                   X-Project-Saved-At, X-Project-Parts, and
//                                                   X-Project-Version: 1 to also keep this save
//                                                   as a version.
//   POST   /api/projects/<name>                  -> rename: JSON body { "rename": "<new name>" }
//   DELETE /api/projects/<name>                  -> remove it and its versions
//   GET    /api/projects/<name>/versions         -> [{ version, savedAt, size, parts }], newest first
//   GET    /api/projects/<name>/versions/<v>     -> that version's file bytes
//   DELETE /api/projects/<name>/versions/<v>
//
// Each version is a full copy. The newest MAX_VERSIONS are kept per project.
const MAX_BYTES = 25 * 1024 * 1024; // KV value limit
const NAME_RE = /^[\w .()+,\-]{1,120}\.(3mf|stl)$/i;
const PROJECT_RE = /^[\w .()+,\-]{1,60}$/;
const FOLDER_RE = /^[\w .()+,\-]{1,40}$/;
const FOLDERS_KEY = 'meta/folders';
const ID_RE = /^[\w-]{6,40}$/;
const VERSION_RE = /^[0-9TZ:.\-]{20,30}$/;
// Deleting a project removes its versions in the same request, and a request may make
// only about 50 storage calls, so this stays under that.
export const MAX_VERSIONS = 40;
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

/** Who is asking: the Access login's email, or "service" for a service token. Safe to use inside a key. */
function userOf(request) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return { name: email || 'service token', key: email ? encodeURIComponent(email) : 'service' };
}
const bytes = (body) => new Response(body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

async function handleProjects(request, env, rest) {
  const user = userOf(request).key, base = `projects/${user}/`;
  const parts = rest === undefined ? [] : rest.split('/');
  if (parts.length === 0) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    // Projects saved before they belonged to anyone sit directly under "projects/". There was
    // only one login then, so the first signed-in person to list projects takes them over.
    // Nothing writes such keys any more, so this runs once.
    if (user !== 'service') {
      const strays = (await listAll(env, 'projects/')).filter((p) => !p.name.includes('/')).slice(0, 10);
      for (const { name: stray, ...meta } of strays) {
        const body = await env.PARTS.get('projects/' + stray, 'arrayBuffer');
        if (body && !(await env.PARTS.get(base + stray, 'arrayBuffer'))) await env.PARTS.put(base + stray, body, { metadata: { ...meta, id: meta.id || newId() } });
        await env.PARTS.delete('projects/' + stray);
      }
      if (strays.length) {
        // The listing lags behind writes, so answer from what was just moved.
        const mine = await listAll(env, base);
        for (const st of strays) if (!mine.some((p) => p.name === st.name)) mine.push(st);
        return json(mine);
      }
    }
    return json(await listAll(env, base));
  }
  if (parts.length > 3 || (parts.length >= 2 && parts[1] !== 'versions')) return json({ error: 'Not found' }, 404);
  let name;
  try { name = decodeURIComponent(parts[0]); } catch { return json({ error: 'Bad name' }, 400); }
  if (!PROJECT_RE.test(name)) return json({ error: KINDS.projects.hint }, 400);
  const key = base + name;
  /** The working copy's details; read with the value because listings can lag behind a write. */
  const head = async () => {
    const r = await env.PARTS.getWithMetadata(key, 'arrayBuffer');
    return r && r.value ? { body: r.value, meta: r.metadata || {} } : null;
  };
  const versionsOf = async (id) => (await listAll(env, `versions/${user}/${id}/`)).sort((a, b) => b.name.localeCompare(a.name));

  if (parts.length >= 2) {
    const h = await head();
    if (!h) return json({ error: 'Not found' }, 404);
    if (!h.meta.id) return json(parts.length === 2 ? [] : { error: 'Not found' }, parts.length === 2 ? 200 : 404);
    if (parts.length === 2) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return json((await versionsOf(h.meta.id)).map((v) => ({ version: v.name, savedAt: v.savedAt, size: v.size, parts: v.parts })));
    }
    let v;
    try { v = decodeURIComponent(parts[2]); } catch { return json({ error: 'Bad version' }, 400); }
    if (!VERSION_RE.test(v)) return json({ error: 'Bad version' }, 400);
    const vkey = `versions/${user}/${h.meta.id}/${v}`;
    if (request.method === 'GET') {
      const body = await env.PARTS.get(vkey, 'arrayBuffer');
      return body ? bytes(body) : json({ error: 'Not found' }, 404);
    }
    if (request.method === 'DELETE') { await env.PARTS.delete(vkey); return json({ deleted: v }); }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (request.method === 'GET') {
    const body = await env.PARTS.get(key, 'arrayBuffer');
    return body ? bytes(body) : json({ error: 'Not found' }, 404);
  }
  if (request.method === 'PUT') {
    if (Number(request.headers.get('content-length') || 0) > MAX_BYTES) return json({ error: 'File larger than 25 MB' }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return json({ error: 'Empty file' }, 400);
    if (body.byteLength > MAX_BYTES) return json({ error: 'File larger than 25 MB' }, 413);
    const now = new Date().toISOString();
    // The id comes from the app (it is stored in the project); for older saves, from what is already here.
    let id = request.headers.get('X-Project-Id') || '';
    if (!ID_RE.test(id)) id = (await head())?.meta.id || newId();
    const metadata = {
      id, size: body.byteLength, uploaded: now,
      savedAt: (request.headers.get('X-Project-Saved-At') || now).slice(0, 40),
      parts: Number(request.headers.get('X-Project-Parts')) || 0,
    };
    await env.PARTS.put(key, body, { metadata });
    let version;
    if (request.headers.get('X-Project-Version') === '1') {
      version = now;
      await env.PARTS.put(`versions/${user}/${id}/${version}`, body, { metadata: { savedAt: metadata.savedAt, size: metadata.size, parts: metadata.parts } });
      // Keep the newest few; the listing may not show the one just written yet, so count it in.
      const old = (await versionsOf(id)).filter((v) => v.name !== version);
      for (const v of old.slice(MAX_VERSIONS - 1)) await env.PARTS.delete(`versions/${user}/${id}/${v.name}`);
    }
    return json({ name, ...metadata, version });
  }
  if (request.method === 'POST') {
    let to;
    try { to = (await request.json()).rename; } catch { return json({ error: 'Bad request' }, 400); }
    if (typeof to !== 'string' || !PROJECT_RE.test(to.trim())) return json({ error: KINDS.projects.hint }, 400);
    to = to.trim();
    if (to === name) return json({ name });
    if (await env.PARTS.get(base + to, 'arrayBuffer')) return json({ error: 'You already have a project with that name' }, 409);
    const h = await head();
    if (!h) return json({ error: 'Not found' }, 404);
    // Versions are filed under the project's id, so they follow it to the new name untouched.
    const metadata = { ...h.meta, id: h.meta.id || newId() };
    await env.PARTS.put(base + to, h.body, { metadata });
    await env.PARTS.delete(key);
    return json({ name: to, ...metadata });
  }
  if (request.method === 'DELETE') {
    const h = await head();
    await env.PARTS.delete(key);
    if (h?.meta.id) for (const v of await versionsOf(h.meta.id)) await env.PARTS.delete(`versions/${user}/${h.meta.id}/${v.name}`);
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

  if (url.pathname === '/api/me') return json({ user: userOf(request).name });
  const pm = /^\/api\/projects(?:\/(.+))?$/.exec(url.pathname);
  if (pm) return handleProjects(request, env, pm[1]);
  const m = /^\/api\/(parts|folders)(?:\/([^/]+))?$/.exec(url.pathname);
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
    {
      metadata.version = (request.headers.get('X-Part-Version') || '').slice(0, 40);
      // A named folder files the part there; without one a part that is already in the library stays where it is.
      const asked = request.headers.get('X-Part-Folder');
      let folder;
      if (asked !== null) {
        try { folder = decodeURIComponent(asked).trim(); } catch { return json({ error: 'Bad folder name' }, 400); }
        if (folder && !FOLDER_RE.test(folder)) return json({ error: 'Folder name must be 1-40 letters, digits, spaces or _.()+,-' }, 400);
      } else folder = (await listAll(env, key)).find((p) => p.name === '')?.folder;
      if (folder) metadata.folder = folder;
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
