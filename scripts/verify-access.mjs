// Verifies that an unauthenticated request to the custom domain is sent to the
// Cloudflare Access login page instead of receiving the app.
import { configuredDomain } from './cf.mjs';

const domain = process.env.ACCESS_DOMAIN || (await configuredDomain());
const url = `https://${domain}/`;
const res = await fetch(url, { redirect: 'manual' });
const loc = res.headers.get('location') || '';
let ok = res.status >= 300 && res.status < 400 && /cloudflareaccess\.com|\/cdn-cgi\/access\/login/.test(loc);
let detail = `HTTP ${res.status}${loc ? ` → ${loc.split('?')[0]}` : ''}`;
if (ok) {
  // Follow to the login page and make sure it is the Access sign-in.
  const login = await fetch(loc, { redirect: 'follow' });
  const html = await login.text();
  ok = /cloudflare access|Sign in|one-time pin|Get a login code/i.test(html);
  detail += ` → login page HTTP ${login.status}${ok ? ' (Access sign-in detected)' : ' (unexpected content)'}`;
} else {
  const body = await res.text();
  if (/<title>Pelican Cutouts<\/title>/.test(body)) detail += ' — APP IS PUBLICLY REACHABLE';
}
console.log(`${url}: ${detail}`);
console.log(ok ? 'ACCESS OK: unauthenticated requests get the Access login page.' : 'ACCESS CHECK FAILED');
process.exit(ok ? 0 : 1);
