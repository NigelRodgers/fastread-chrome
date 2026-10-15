// End-to-end: loads the extension, opens an article, points the panel at it, plays a few seconds
// at the top speed and checks the reading position advances. Plays audio on the speakers.
// Usage: node test/e2e-test.mjs [url]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(root, '.vendor-src/node_modules/playwright-core'));
const exe = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const url = process.argv[2] || 'https://paulgraham.com/greatwork.html';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fastread-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe,
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;

const article = await ctx.newPage();
await article.goto(url, { waitUntil: 'domcontentloaded' });
await article.waitForTimeout(2000);
const winId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith(u)).windowId, url);

// The panel lives in its own popup window here; make it think it belongs to the article's window.
await ctx.addInitScript(`if (location.protocol === 'chrome-extension:') chrome.windows.getCurrent = async () => ({ id: ${winId} });`);
const [panel] = await Promise.all([
  ctx.waitForEvent('page'),
  sw.evaluate((id) => chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html`, type: 'popup' }), id),
]);
const errors = [];
panel.on('pageerror', (e) => errors.push(String(e)));
panel.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await panel.waitForSelector('.s', { timeout: 20000 });

const info = await panel.evaluate(() => ({
  status: document.getElementById('status').textContent,
  method: document.getElementById('method').textContent,
  sentences: document.querySelectorAll('.s').length,
  first: document.querySelector('.s').textContent.slice(0, 80),
  speed: document.getElementById('rateLabel').textContent,
}));
console.log(info);

// Top speed, then play.
await panel.evaluate(() => { const r = document.getElementById('rate'); r.value = r.max; r.dispatchEvent(new Event('input')); });
console.log('speed now', await panel.textContent('#rateLabel'));
await panel.click('#play');
const samples = [];
for (let i = 0; i < 6; i++) {
  await panel.waitForTimeout(1000);
  samples.push(await panel.evaluate(() => ({
    progress: document.getElementById('progress').textContent,
    playing: document.body.classList.contains('playing'),
    word: CSS.highlights.has('fr-word'),
  })));
}
console.log(samples);

// Skip, pause, click-to-start.
await panel.click('#next');
await panel.waitForTimeout(500);
console.log('after next:', await panel.textContent('#progress'));
await panel.click('#play');
console.log('paused:', !(await panel.evaluate(() => document.body.classList.contains('playing'))));
await panel.click('.s >> nth=40');
await panel.waitForTimeout(800);
console.log('after clicking sentence 41:', await panel.textContent('#progress'));
await panel.keyboard.press('Space');

console.log('errors:', errors.length ? errors : 'none');
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
