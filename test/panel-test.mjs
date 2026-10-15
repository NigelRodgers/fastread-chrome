// Loads the unpacked extension in Chromium, opens the panel page, and measures how long the
// same text takes to speak at several rates (plays audio on the speakers).
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fastread-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe,
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--autoplay-policy=no-user-gesture-required'],
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host;
console.log('extension id', id);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`chrome-extension://${id}/sidepanel.html`);
await page.waitForTimeout(1500);
console.log('status text:', await page.textContent('#status'));

const voices = await page.evaluate(() => speechSynthesis.getVoices().map((v) => `${v.name}${v.localService ? '' : ' (online)'}`));
console.log('voices:', voices);

const rates = (process.env.RATES || '1,2,3,3.5').split(',').map(Number);
const voiceName = process.env.VOICE || 'Microsoft David';
const result = await page.evaluate(async ({ rates, voiceName }) => {
  const text = 'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly across the yard.';
  const v = speechSynthesis.getVoices().find((x) => x.name.startsWith(voiceName));
  const out = { voice: v && v.name };
  for (const r of rates) {
    out[r] = await new Promise((res) => {
      const u = new SpeechSynthesisUtterance(text);
      if (v) u.voice = v;
      u.rate = r;
      let t0;
      u.onstart = () => { t0 = performance.now(); };
      u.onend = () => res(Math.round(performance.now() - t0));
      u.onerror = (e) => res(`error ${e.error}`);
      speechSynthesis.speak(u);
    });
  }
  return out;
}, { rates, voiceName });
console.log('ms per utterance by rate:', result);
console.log('page errors:', errors.length ? errors : 'none');
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
