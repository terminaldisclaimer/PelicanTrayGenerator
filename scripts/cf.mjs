// Minimal Cloudflare API client. The token comes from CLOUDFLARE_API_TOKEN in
// the environment (never from a file); in proxied environments it may be
// injected by the proxy, in which case any placeholder value works.
const API = 'https://api.cloudflare.com/client/v4';

export async function cf(path, { method = 'GET', body } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN (or run `npx wrangler login` and export a token).');
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const msg = (json.errors || []).map((e) => `${e.code}: ${e.message ?? e.error}`).join('; ') || res.statusText;
    throw new Error(`${method} ${path} failed (${res.status}): ${msg}`);
  }
  return json.result;
}

export async function resolveZone(hostname) {
  const parts = hostname.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts.slice(i).join('.');
    const zones = await cf(`/zones?name=${encodeURIComponent(name)}`);
    if (zones.length) return zones[0];
  }
  throw new Error(`No Cloudflare zone found for ${hostname}`);
}

/** Read the custom domain from wrangler.jsonc (strip // comments first). */
export async function configuredDomain() {
  const { readFile } = await import('node:fs/promises');
  const text = (await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(text);
  const route = (cfg.routes || []).find((r) => r.custom_domain);
  if (!route) throw new Error('wrangler.jsonc has no custom_domain route');
  return route.pattern;
}
