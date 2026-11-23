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
  await page.tap('#sheet-handle');
  await page.waitForTimeout(400);
  // Visual pose picker: thumbnails for every automatic pose, pick one, then hand back to Auto.
  await page.tap('.pose-row button:has-text("Choose pose")');
  await page.waitForSelector('.pose-option img');
  const options = await page.$$eval('.pose-option img', (els) => els.filter((e) => e.naturalWidth > 0).length);
  await page.screenshot({ path: 'test-results/mobile-picker.png' });
  // Third picture = the box standing on its 60×25 side: 60 × 25 footprint, 40 tall.
  await page.tap('.pose-option:nth-child(3)');
  await page.waitForFunction(() => document.querySelector('.part .meta')?.textContent.includes('pose locked'));
  const tipped = await page.textContent('.part .meta');
  // Picking a pose ticks "Lock pose"; unticking lets the layout turn the part again.
  const lockedBox = await page.isChecked('.check input');
  await page.tap('.check');
  await page.waitForFunction(() => document.querySelector('.part .meta')?.textContent.includes('may be turned'));
  const unlockedBox = await page.isChecked('.check input');
  const picked = options >= 2;
  // Finger cutouts: auto gives this 25 mm tall box a pinch pair; tap one circle off, then add an end.
  await page.tap('.pose-row button:has-text("Finger cutouts")');
  await page.waitForSelector('.fp-spot');
  // Both main buttons must be fully on screen without scrolling sideways.
  const mainVisible = await page.$$eval('.main-row .btn', (els) => els.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  const fingersAuto = await page.$$eval('.fp-spot[aria-pressed="true"]', (e) => e.length);
  // "None" clears them all; "Pinch pair" puts two back.
  await page.tap('.finger-picker button:has-text("None")');
  await page.waitForFunction(() => document.querySelectorAll('.fp-spot[aria-pressed="true"]').length === 0);
  const noneHint = await page.textContent('.finger-picker p');
  const noneDrawn = await page.$$eval('.fp-hole', (e) => e.length); // nothing that looks like a cutout
  await page.tap('.finger-picker button:has-text("Pinch pair")');
  await page.waitForFunction(() => document.querySelectorAll('.fp-spot[aria-pressed="true"]').length === 2);
  await page.tap('.fp-spot[aria-label*="near long side"]');
  await page.waitForFunction(() => document.querySelectorAll('.fp-spot[aria-pressed="true"]').length === 1);
  await page.tap('.fp-spot[aria-label*="right end"]');
  await page.waitForFunction(() => document.querySelectorAll('.fp-spot[aria-pressed="true"]').length === 2);
  const holesDrawn = await page.$$eval('.fp-hole', (e) => e.length);
  await page.screenshot({ path: 'test-results/mobile-fingers.png' });
  await page.tap('.finger-picker button:has-text("Done")');
  // The bin asks before removing a part; declining keeps it.
  page.once('dialog', (d) => d.dismiss());
  await page.tap('.part .icon-btn');
  await page.waitForTimeout(200);
  const kept = await page.$$eval('#parts .part', (e) => e.length);
  const fingersText = await page.textContent('.pose-row button:has-text("Finger cutouts")');
  // Per-part stacking gap: empty by default (uses the tray setting), accepts a value, and can be cleared.
  const gapEmpty = await page.inputValue('.gap-row input');
  await page.fill('.gap-row input', '2.5');
  await page.dispatchEvent('.gap-row input', 'change');
  await page.waitForFunction(() => document.querySelector('.gap-row input')?.value === '2.5');
  const gapSet = await page.inputValue('.gap-row input');
  // Generate a tray and download it as STL.
  await page.tap('.tab[data-tab="trays"]');
  await page.fill('#tray-length', '120');
  await page.fill('#tray-width', '90');
  await page.tap('#tray-build');
  await page.waitForFunction(() => document.querySelector('#tray-status')?.textContent.startsWith('1 tray'), null, { timeout: 30000 });
  const trayStatus = await page.textContent('#tray-status');
  await page.screenshot({ path: 'test-results/mobile-tray.png' });
  await page.tap('.tab[data-tab="export"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.tap('#export-list button')]);
  await download.saveAs('test-results/smoke-tray.stl');
  const stl = readFileSync('test-results/smoke-tray.stl');
  const stlOk = stl.length > 84 && stl.length === 84 + stl.readUInt32LE(80) * 50;
  await page.tap('.tab[data-tab="parts"]');
  // The Save button is on screen and confirms; the header shows the saved state.
  const saveVisible = await page.$eval('#save-now', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height >= 44; });
  await page.tap('#save-now');
  await page.waitForFunction(() => document.querySelector('#save-now').textContent.includes('Saved'));
  const saveState = await page.textContent('#save-state');
  // Saved automatically: after a reload the part, its cutouts and the case size are back.
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.part .name');
  // The generated layout was saved with the project and comes back without searching again.
  await page.waitForFunction(() => document.querySelector('#tray-status')?.textContent.includes('Saved layout'), null, { timeout: 30000 });
  const layoutBack = await page.textContent('#tray-status');
  const restored = { gap: await page.inputValue('.gap-row input'), name: await page.textContent('.part .name'), fingers: await page.textContent('.pose-row button:nth-child(2)'), length: await page.inputValue('#tray-length') };

  // Tap targets ≥ 44px for visible buttons
  const small = await page.$$eval('button:not(.sheet-handle), label.btn', (els) =>
    els.filter((e) => e.offsetParent).map((e) => [e.textContent.trim(), e.getBoundingClientRect().height]).filter(([, h]) => h < 44));
  await page.screenshot({ path: 'test-results/mobile-peek.png' });
  await page.tap('#sheet-handle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/mobile-half.png' });
  const sw = await page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration()));
  console.log({ width, overflow, meta, tipped, options, restored, fingersAuto, fingersText, trayStatus, stl: download.suggestedFilename(), stlOk, small, serviceWorker: sw, errors });
  if (width !== 390 || overflow || !meta?.includes('60.0 × 40.0 × 25.0 mm · pose may be turned') || !tipped?.includes('60.0 × 25.0 × 40.0 mm · pose locked') || !lockedBox || unlockedBox || !picked || gapEmpty !== '' || gapSet !== '2.5' || !saveVisible || !/saved \d/.test(saveState) || restored.name !== 'box' || !layoutBack.startsWith('1 tray') || restored.gap !== '2.5' || !restored.fingers.includes('Finger cutouts: 2') || restored.fingers.includes('auto') || restored.length !== '120' || fingersAuto !== 2 || kept !== 1 || !noneHint.startsWith('No finger cutouts') || noneDrawn !== 0 || holesDrawn !== 2 || !mainVisible || !fingersText.includes('Finger cutouts: 2') || fingersText.includes('auto') || !stlOk || !trayStatus.includes('118.0 × 88.0 mm') || !trayStatus.includes('27.2 mm deep') || small.length || errors.length) failed = true;
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(failed ? 1 : 0);
