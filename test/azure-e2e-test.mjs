// End-to-end test of the Azure voice path against a mock Azure. No real key, no Azure traffic:
// the TTS host is answered by Playwright routes, its WebSocket is refused, and the Speech SDK is
// either a fake (for word timings) or the real bundled one (to check it loads under MV3's CSP and
// falls back to REST when its WebSocket is refused).
// The fallback step plays a Windows voice on the speakers for a moment.
// Usage: node test/azure-e2e-test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(root, '.vendor-src/node_modules/playwright-core'));
const exe = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe');
vm.runInThisContext(fs.readFileSync(path.join(root, 'azure.js'), 'utf8'));
const AZ = globalThis.FastReadAzure;

const FAKE_KEY = 'fakeKeyForTests0123456789abcdef'; // not a real key
const ARTICLE = 'https://fastread.test/article';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// ---------- mock Azure ----------

function wav(seconds) {
  const rate = 8000;
  const n = Math.max(1, Math.round(seconds * rate));
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const mock = { mode: 'ok', synth: [], lists: 0, keys: new Set() };
const VOICES = [
  { ShortName: 'en-US-AvaNeural', DisplayName: 'Ava', LocalName: 'Ava', Locale: 'en-US', LocaleName: 'English (United States)', Gender: 'Female', VoiceType: 'Neural' },
  { ShortName: 'en-US-AndrewNeural', DisplayName: 'Andrew', LocalName: 'Andrew', Locale: 'en-US', LocaleName: 'English (United States)', Gender: 'Male', VoiceType: 'Neural' },
  { ShortName: 'en-US-Ava:DragonHDLatestNeural', DisplayName: 'Ava HD', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural' },
  { ShortName: 'fr-FR-DeniseNeural', DisplayName: 'Denise', LocalName: 'Denise', Locale: 'fr-FR', LocaleName: 'French (France)', Gender: 'Female', VoiceType: 'Neural' },
];

const paragraphs = Array.from({ length: 14 }, (_, p) =>
  Array.from({ length: 5 }, (_, s) => `Paragraph ${p + 1} sentence ${s + 1} talks about reading quickly with a neural voice.`).join(' '));
const articleHtml = `<!doctype html><html><head><title>Mock article</title></head><body><article><h1>Mock article</h1>${paragraphs.map((t) => `<p>${t}</p>`).join('')}</article></body></html>`;

// ---------- fake Speech SDK (runs in the panel page) ----------

const fakeSdk = `(() => {
  if (location.protocol !== 'chrome-extension:' || location.search.includes('realsdk')) return;
  const wav = (sec) => { const rate = 8000, n = Math.max(1, Math.round(sec * rate)); const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true); return buf; };
  const st = window.__fakeSdk = { opened: 0, requests: [], fail: false };
  class SpeechSynthesizer {
    constructor(cfg, audio) { st.opened++; st.cfgOk = !!cfg && audio === null; }
    speakSsmlAsync(ssml, ok) {
      st.requests.push({ ssml, at: performance.now() });
      setTimeout(() => {
        if (st.fail) return ok({ reason: 'canceled', details: 'Connection failed: 1006' });
        const rate = Number((/rate="([\\d.]+)"/.exec(ssml) || [])[1] || 1);
        const text = ssml.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const words = text.match(/[\\w']+/g) || [];
        const per = 0.16 / rate;
        words.forEach((w, i) => this.wordBoundary && this.wordBoundary(this, { audioOffset: Math.round(i * per * 1e7), text: w, boundaryType: 'WordBoundary' }));
        ok({ reason: 'done', audioData: wav(words.length * per + 0.05) });
      }, 80);
    }
    close() {}
  }
  window.SpeechSDK = {
    SpeechConfig: { fromSubscription: (key, region) => ({ key, region }) },
    SpeechSynthesizer,
    ResultReason: { SynthesizingAudioCompleted: 'done' },
    SpeechSynthesisBoundaryType: { Word: 'WordBoundary' },
    SpeechSynthesisOutputFormat: { Audio24Khz48KBitRateMonoMp3: 'mp3' },
    CancellationDetails: { fromResult: (r) => ({ reason: 'Error', errorDetails: r.details }) },
  };
})();`;

// Record every <audio> play() and ended event so the test can measure gaps between chunks.
const audioSpy = `(() => {
  if (location.protocol !== 'chrome-extension:') return;
  const log = window.__audioLog = [];
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__audio = this;
    if (!this.__spied) {
      this.__spied = true;
      this.addEventListener('ended', () => log.push({ e: 'ended', at: performance.now() }));
      this.addEventListener('playing', () => log.push({ e: 'playing', at: performance.now(), rate: this.playbackRate }));
    }
    return orig.call(this);
  };
})();`;

// ---------- run ----------

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fastread-azure-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe,
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--autoplay-policy=no-user-gesture-required'],
});

await ctx.route('https://fastread.test/**', (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }));
await ctx.route('https://*.tts.speech.microsoft.com/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  mock.keys.add(req.headers()['ocp-apim-subscription-key']);
  if (url.pathname.endsWith('/voices/list')) {
    mock.lists++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VOICES) });
  }
  const ssml = req.postData() || '';
  if (mock.mode !== 'ok') return route.fulfill({ status: mock.mode, body: mock.mode === 403 ? 'Quota exceeded' : '' });
  mock.synth.push(ssml);
  const rate = Number((/rate="([\d.]+)"/.exec(ssml) || [])[1] || 1);
  const words = ssml.replace(/<[^>]+>/g, '').split(/\s+/).length;
  return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav((words * 0.16) / rate + 0.05) });
});
let wsAttempts = 0;
await ctx.routeWebSocket(/tts\.speech\.microsoft\.com/, (ws) => {
  wsAttempts++;
  ws.close({ code: 1006, reason: 'refused by test' });
});
await ctx.addInitScript(fakeSdk);
await ctx.addInitScript(audioSpy);

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;

const article = await ctx.newPage();
await article.goto(ARTICLE);
const winId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(u)).windowId, ARTICLE);
await ctx.addInitScript(`if (location.protocol === 'chrome-extension:') chrome.windows.getCurrent = async () => ({ id: ${winId} });`);

async function openPanel(query = '') {
  const [p] = await Promise.all([
    ctx.waitForEvent('page', (pg) => pg.url().includes('sidepanel.html')),
    sw.evaluate(({ id, query }) => chrome.windows.create({ url: `chrome-extension://${id}/sidepanel.html${query}`, type: 'popup' }), { id, query }),
  ]);
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && p.errors.push(m.text()));
  await p.waitForSelector('.s', { timeout: 20000 });
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const progress = (p) => p.evaluate(() => Number(document.getElementById('progress').textContent.split('/')[0]));
const speeds = AZ.SPEEDS;

let panel = await openPanel();

// 1. Settings: key + region, voice list.
await panel.click('#settingsBtn');
await panel.fill('#azureKey', FAKE_KEY);
await panel.fill('#azureRegion', 'eastus');
await panel.click('#azureSave');
await panel.waitForFunction(() => /voices loaded/.test(document.getElementById('azureStatus').textContent), null, { timeout: 5000 });
const ui = await panel.evaluate(() => ({
  options: [...document.querySelectorAll('#voice optgroup:first-child option')].map((o) => o.value),
  keyField: document.getElementById('azureKey').value,
  bodyHasKey: document.documentElement.outerHTML.includes('fakeKeyForTests'),
}));
const stored = await panel.evaluate(() => chrome.storage.local.get(null));
check('voice list fetched with the key header', mock.lists === 1 && mock.keys.has(FAKE_KEY));
check('Azure voices listed, HD voice filtered out, English first', JSON.stringify(ui.options) ===
  JSON.stringify(['azure:en-US-AndrewNeural', 'azure:en-US-AvaNeural', 'azure:fr-FR-DeniseNeural']), ui.options.join(', '));
check('key field cleared, key not in the DOM', ui.keyField === '' && !ui.bodyHasKey);
check('key and region in chrome.storage.local', stored.azureKey === FAKE_KEY && stored.azureRegion === 'eastus');
check('voice list cached', stored.azureVoices && stored.azureVoices.voices.length === 3);

// 2. Pick Ava at 2x, seed usage near 80%, play.
await panel.evaluate((u) => chrome.storage.local.set({ azureUsage: u }), { month: AZ.monthKey(), chars: 399000, warned: false });
await panel.selectOption('#voice', 'azure:en-US-AvaNeural');
await panel.evaluate((i) => { const r = document.getElementById('rate'); r.value = i; r.dispatchEvent(new Event('input')); }, speeds.indexOf(2));
check('slider shows Azure scale', (await panel.textContent('#rateLabel')) === '2×' &&
  Number(await panel.getAttribute('#rate', 'max')) === speeds.length - 1);
await panel.click('#play');
await sleep(1500);
let fake = await panel.evaluate(() => ({ n: window.__fakeSdk.requests.length, opened: window.__fakeSdk.opened, ssml: window.__fakeSdk.requests.map((r) => r.ssml) }));
check('first request plus two chunks ahead within 1.5 s', fake.n >= 3, `${fake.n} requests`);
check('one SDK synthesizer reused', fake.opened === 1);
check('first chunk is a single sentence (quick start)', fake.ssml[0].replace(/<[^>]+>/g, '') === 'Mock article', fake.ssml[0].replace(/<[^>]+>/g, '').slice(0, 60));
check('2x is all prosody', fake.ssml.every((s) => s.includes('<prosody rate="2">')));
const p1 = await progress(panel);
await sleep(2500);
const p2 = await progress(panel);
const word = await panel.evaluate(() => CSS.highlights.has('fr-word'));
check('reading position advances', p2 > p1, `${p1} -> ${p2}`);
check('word highlight from SDK word timings', word);

// 3. Speed past 2x: no new synthesis, playbackRate only.
const before = await panel.evaluate(() => window.__fakeSdk.requests.length);
await panel.evaluate((i) => { const r = document.getElementById('rate'); r.value = i; r.dispatchEvent(new Event('input')); }, speeds.length - 1);
await sleep(300);
const fast = await panel.evaluate(() => ({ rate: window.__audio.playbackRate, pitch: window.__audio.preservesPitch, label: document.getElementById('rateLabel').textContent, n: window.__fakeSdk.requests.length }));
check('6x = prosody 2 x playbackRate 3, pitch preserved', fast.rate === 3 && fast.pitch && fast.label === '6×', JSON.stringify(fast));
check('speed change above 2x reuses audio (no new characters)', fast.n === before, `${before} -> ${fast.n}`);
await sleep(3500);
const log = await panel.evaluate(() => window.__audioLog);
const gaps = [];
for (let i = 0; i < log.length; i++) {
  if (log[i].e === 'ended') {
    const next = log.slice(i + 1).find((x) => x.e === 'playing');
    if (next) gaps.push(Math.round(next.at - log[i].at));
  }
}
check('no gaps between chunks (next chunk already synthesized)', gaps.length >= 1 && Math.max(...gaps) < 150, `gaps ms: ${gaps.join(', ')}`);

// 4. Usage meter and 80% warning.
const usage = await panel.evaluate(() => chrome.storage.local.get('azureUsage'));
const fakeAll = await panel.evaluate(() => window.__fakeSdk.requests.map((r) => r.ssml));
const expected = 399000 + fakeAll.reduce((n, s) => n + AZ_billable(s), 0);
function AZ_billable(s) { return AZ.billableChars(s); }
check('usage counts billable SSML characters', usage.azureUsage.chars === expected, `${usage.azureUsage.chars} vs ${expected}`);
const notice = await panel.evaluate(() => ({ hidden: document.getElementById('azureNotice').hidden, text: document.getElementById('azureNoticeText').textContent }));
check('80% warning shown', !notice.hidden && /of your 500k free characters/.test(notice.text), notice.text.slice(0, 70));
check('warning recorded for this month', usage.azureUsage.warned === true);
check('settings show "Used X of 500k"', /^Used \d+(\.\d)?k of 500k characters this month/.test(await panel.textContent('#azureUsage')));
await panel.click('#azureNoticeClose');
await sleep(2000);
check('warning not repeated in the same month', await panel.evaluate(() => document.getElementById('azureNotice').hidden));

// 5. Pause and resume within a chunk: no new request.
await panel.click('#play');
const nPaused = await panel.evaluate(() => window.__fakeSdk.requests.length);
await sleep(300);
await panel.click('#play');
await sleep(400);
const resumed = await panel.evaluate(() => ({ n: window.__fakeSdk.requests.length, playing: !window.__audio.paused }));
check('resume continues the same audio', resumed.playing && resumed.n - nPaused <= 1, `${nPaused} -> ${resumed.n}`);

// 6. Quota used up: SDK fails, REST answers 429, panel switches to Zira and keeps reading.
await panel.click('#play'); // pause
await panel.evaluate(() => { window.__fakeSdk.fail = true; });
mock.mode = 429;
await panel.evaluate((i) => { const r = document.getElementById('rate'); r.value = i; r.dispatchEvent(new Event('input')); }, speeds.indexOf(1.5));
const at = await progress(panel);
await panel.click('.s >> nth=50');
await sleep(2500);
const fb = await panel.evaluate(() => ({
  notice: document.getElementById('azureNoticeText').textContent,
  retry: !document.getElementById('azureRetry').hidden,
  speaking: speechSynthesis.speaking,
  playing: document.body.classList.contains('playing'),
  label: document.getElementById('rateLabel').textContent,
  progress: document.getElementById('progress').textContent,
}));
check('429 -> notice names Zira (Ava is female, en-US)', /HTTP 429/.test(fb.notice) && /Switched to Microsoft Zira/.test(fb.notice), fb.notice);
check('keeps reading with the Windows voice', fb.speaking && fb.playing, fb.progress);
check('slider back on the Windows scale', fb.label.endsWith('×') && Number(await panel.getAttribute('#rate', 'max')) === 13, fb.label);
check('started at the clicked sentence', Number(fb.progress.split('/')[0]) >= 51, `${at} -> ${fb.progress}`);
await panel.click('#play'); // pause the Windows voice

// 7. Bad key: 401 -> notice about the key, Andrew -> David.
mock.mode = 401;
await panel.selectOption('#voice', 'azure:en-US-AndrewNeural'); // selecting an Azure voice retries Azure
await panel.click('.s >> nth=10');
await sleep(2000);
const fb2 = await panel.evaluate(() => ({ notice: document.getElementById('azureNoticeText').textContent, speaking: speechSynthesis.speaking }));
check('401 -> key notice, falls back to David', /rejected the key \(HTTP 401\)/.test(fb2.notice) && /Microsoft David/.test(fb2.notice) && fb2.speaking, fb2.notice);
await panel.click('#play');

// 8. Windows voices untouched: pick Zira directly, Windows speed scale, plays via speechSynthesis.
await panel.selectOption('#voice', { label: 'Microsoft Zira - English (United States)' });
const winUi = await panel.evaluate(() => ({ max: document.getElementById('rate').max, label: document.getElementById('rateLabel').textContent }));
check('Windows voice uses the Windows scale', winUi.max === '13', JSON.stringify(winUi));
const realErrors = panel.errors.filter((e) => !/Failed to load resource: the server responded with a status of (429|401)/.test(e));
check('no page errors in the panel (besides the mocked 429/401 responses)', realErrors.length === 0, realErrors.join(' | '));
await panel.close();

// 9. Real SDK bundle: loads under the extension CSP, its refused WebSocket falls back to REST.
mock.mode = 'ok';
mock.synth.length = 0;
const real = await openPanel('?realsdk');
await real.evaluate(() => { chrome.storage.local.set({ voiceName: 'azure:en-US-AvaNeural' }); });
await real.reload();
await real.waitForSelector('.s', { timeout: 20000 });
await real.waitForFunction(() => !!window.SpeechSDK, null, { timeout: 10000 });
const sdkInfo = await real.evaluate(() => ({ synth: typeof SpeechSDK.SpeechSynthesizer, ver: SpeechSDK.SpeechSynthesisOutputFormat && 'ok' }));
check('real Speech SDK loads in the extension page', sdkInfo.synth === 'function', JSON.stringify(sdkInfo));
await real.click('#play');
await real.waitForFunction(() => window.__audio && !window.__audio.paused, null, { timeout: 15000 }).catch(() => {});
await sleep(1500);
const realInfo = await real.evaluate(() => ({ playing: !!window.__audio && !window.__audio.paused, progress: document.getElementById('progress').textContent }));
check('SDK WebSocket was attempted and refused by the mock', wsAttempts >= 1, `${wsAttempts} attempts`);
check('REST fallback served the audio and it plays', mock.synth.length >= 1 && realInfo.playing, `${mock.synth.length} REST requests, ${realInfo.progress}`);
check('no CSP or page errors with the real SDK', !real.errors.some((e) => /Content Security Policy|EvalError|Refused/i.test(e)), real.errors.join(' | '));
await real.click('#play');

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
