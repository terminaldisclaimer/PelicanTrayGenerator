// Fallback deploy for environments where wrangler's asset upload cannot
// authenticate (e.g. a sandbox proxy that overwrites the Authorization header,
// breaking the per-upload JWT). Embeds web/dist in a tiny Worker script and
// deploys that with the normal API token. Same Worker name, domain and
// workers_dev/preview settings as wrangler.jsonc. Prefer `npm run deploy`.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const dist = 'web/dist';
const out = '.wrangler/inline';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = {};
// Security headers come from the same _headers file the assets-only deploy uses.
const headers = {};
for (const line of readFileSync(join(dist, '_headers'), 'utf8').split('\n')) {
  const m = /^\s+([\w-]+):\s*(.+)$/.exec(line);
  if (m) headers[m[1].toLowerCase()] = m[2].trim();
}
for (const p of walk(dist)) {
  if (p.endsWith('_headers')) continue;
  files['/' + relative(dist, p).split('\\').join('/')] = [TYPES[extname(p)] || 'application/octet-stream', readFileSync(p).toString('base64')];
}

const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
delete cfg.assets;
delete cfg.$schema;
cfg.main = 'worker.js';

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'wrangler.json'), JSON.stringify(cfg, null, 2));
writeFileSync(join(out, 'worker.js'), `const FILES = ${JSON.stringify(files)};
const SECURITY = ${JSON.stringify(headers)};
const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export default {
  fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const hit = FILES[path] || FILES['/index.html']; // SPA fallback
    const immutable = FILES[path] && path.startsWith('/assets/');
    return new Response(req.method === 'HEAD' ? null : decode(hit[1]), {
      headers: {
        ...SECURITY,
        'content-type': hit[0],
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  },
};
`);
console.log(`Embedded ${Object.keys(files).length} files`);
const r = spawnSync('node_modules/.bin/wrangler', ['deploy', '--config', join(out, 'wrangler.json')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
