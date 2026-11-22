// Mobile smoke test: serves web/dist, emulates an iPhone (390px wide, touch),
// uploads a generated STL, and checks the part shows up. Screenshots go to
// test-results/. Usage: npm run build && node scripts/smoke.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

function boxSTL(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((c, a) => buf.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + a * 4))));
  return buf;
}

mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/box.stl', boxSTL(60, 40, 25));
const port = 4317;
const server = spawn('node_modules/.bin/vite', ['preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes(String(port)) && r()));

const browser = await chromium.launch();
let failed = false;
try {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] }); // 390×844, touch, iOS UA
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The preview server has no /api (library is production-only), so ignore its 404.
  page.on('console', (m) => m.type() === 'error' && !m.location().url.includes('/api/') && errors.push(m.text()));
  // vite preview does not serve _headers, so apply the production CSP here to
  // prove the app runs under it.
  const csp = /Content-Security-Policy:\s*(.+)/.exec(readFileSync('web/dist/_headers', 'utf8'))[1].trim();
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp } });
  });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('canvas');
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.setInputFiles('#file-input', 'test-results/box.stl');
  await page.waitForSelector('.part .name');
  const meta = await page.textContent('.part .meta');
  // Manual re-pose: tipping the 60×40×25 box forwards makes it 60×25×40.
  await page.tap('#sheet-handle');
  await page.waitForTimeout(400);
  await page.tap('.pose-row button:has-text("Tip ↕")');
  await page.waitForFunction(() => document.querySelector('.part .meta')?.textContent.includes('custom'));
  const tipped = await page.textContent('.part .meta');
  // Visual pose picker: thumbnails for every automatic pose, pick one, then hand back to Auto.
  await page.tap('.pose-row button:has-text("Choose pose")');
  await page.waitForSelector('.pose-option img');
  const options = await page.$$eval('.pose-option img', (els) => els.filter((e) => e.naturalWidth > 0).length);
  await page.screenshot({ path: 'test-results/mobile-picker.png' });
  await page.tap('.pose-option:nth-child(3)');
  await page.waitForFunction(() => document.querySelector('.part .meta')?.textContent.includes('pose 2 (locked)'));
  await page.tap('.pose-row button:has-text("Choose pose")');
  await page.tap('.pose-option:first-child');
  await page.waitForFunction(() => document.querySelector('.part .meta')?.textContent.includes('auto pose'));
  const picked = options >= 2;
  await page.tap('#sheet-handle'); await page.waitForTimeout(300);
  await page.tap('#sheet-handle'); await page.waitForTimeout(400); // back to peek
  // Tap targets ≥ 44px for visible buttons
  const small = await page.$$eval('button:not(.sheet-handle), label.btn', (els) =>
    els.filter((e) => e.offsetParent).map((e) => [e.textContent.trim(), e.getBoundingClientRect().height]).filter(([, h]) => h < 44));
  await page.screenshot({ path: 'test-results/mobile-peek.png' });
  await page.tap('#sheet-handle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/mobile-half.png' });
  const sw = await page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration()));
  console.log({ width, overflow, meta, tipped, options, small, serviceWorker: sw, errors });
  if (width !== 390 || overflow || !meta?.includes('60.0 × 40.0 × 25.0 mm · auto pose') || !tipped?.includes('60.0 × 25.0 × 40.0') || !picked || small.length || errors.length) failed = true;
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(failed ? 1 : 0);
