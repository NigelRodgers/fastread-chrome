// Unit tests for azure.js (speed scale, SSML billing, usage, errors, fallback voice, client, queue).
// No network: the client gets a mock fetch and a fake Speech SDK.
// Usage: node test/azure-unit-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'azure.js'), 'utf8'), { filename: 'azure.js' });
const AZ = globalThis.FastReadAzure;

// ---------- speed ----------

test('speed splits into prosody (max 2) and playbackRate', () => {
  assert.deepEqual(AZ.speedParts(0.5), { prosody: 0.5, playback: 1 });
  assert.deepEqual(AZ.speedParts(1.5), { prosody: 1.5, playback: 1 });
  assert.deepEqual(AZ.speedParts(2), { prosody: 2, playback: 1 });
  assert.deepEqual(AZ.speedParts(3), { prosody: 2, playback: 1.5 });
  assert.deepEqual(AZ.speedParts(6), { prosody: 2, playback: 3 });
  for (const s of AZ.SPEEDS) {
    const { prosody, playback } = AZ.speedParts(s);
    assert.ok(prosody >= 0.5 && prosody <= 2, `prosody in Azure's range for ${s}`);
    assert.ok(Math.abs(prosody * playback - s) < 1e-9);
  }
});

test('Azure scale goes past the Windows ceiling', () => {
  const windowsTop = AZ.windowsNatural(13); // 10x on Chrome's scale = SAPI +10
  assert.ok(Math.abs(windowsTop - 3) < 1e-9);
  assert.ok(AZ.SPEEDS.at(-1) > windowsTop * 1.5);
});

test('perceived-speed mapping between Windows and Azure scales', () => {
  assert.equal(AZ.windowsIndexFor(1), 3); // 1x
  assert.equal(AZ.windowsIndexFor(3), 13); // 10x, the Windows top
  assert.equal(AZ.windowsIndexFor(6), 13); // clamped
  assert.equal(AZ.windowsLabel(6), '2×');
  assert.equal(AZ.windowsLabel(13), '10×');
  assert.equal(AZ.SPEEDS[AZ.azureIndexFor(AZ.windowsNatural(13))], 3);
  assert.equal(AZ.SPEEDS[AZ.azureIndexFor(AZ.windowsNatural(3))], 1);
  assert.equal(AZ.speedLabel(AZ.DEFAULT_SPEED), '2×');
  assert.match(AZ.speedTitle(AZ.SPEEDS.indexOf(3)), /10×/);
  assert.match(AZ.speedTitle(AZ.SPEEDS.indexOf(6)), /faster than any Windows voice/);
});

// ---------- SSML and billing ----------

const ava = { ShortName: 'en-US-AvaNeural', Locale: 'en-US', Gender: 'Female' };

test('SSML escapes text and omits prosody at 1x', () => {
  const { ssml } = AZ.buildSsml('A < B & C', ava, 1);
  assert.equal(ssml, '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
    '<voice name="en-US-AvaNeural">A &lt; B &amp; C</voice></speak>');
});

test('billable characters exclude <speak> and <voice> but include other markup', () => {
  const text = 'Hello there.';
  const { ssml, billable } = AZ.buildSsml(text, ava, 2);
  assert.match(ssml, /<prosody rate="2">Hello there\.<\/prosody>/);
  assert.equal(billable, '<prosody rate="2">'.length + text.length + '</prosody>'.length);
  assert.equal(AZ.buildSsml(text, ava, 1).billable, text.length);
  assert.equal(AZ.buildSsml('a & b', ava, 1).billable, 'a &amp; b'.length); // entities are markup
});

test('Chinese characters count double, other code points once', () => {
  assert.equal(AZ.billableChars('<speak><voice name="x">中文ab</voice></speak>'), 6);
  assert.equal(AZ.billableChars('<speak><voice name="x">😀é</voice></speak>'), 2);
});

// ---------- usage ----------

test('usage counts per calendar month and warns once at 80%', () => {
  const oct = new Date(Date.UTC(2026, 9, 15));
  const nov = new Date(Date.UTC(2026, 10, 1));
  let r = AZ.addUsage(null, 1000, oct);
  assert.deepEqual(r, { usage: { month: '2026-10', chars: 1000, warned: false }, warn: false });
  r = AZ.addUsage(r.usage, 398999, oct);
  assert.equal(r.warn, false);
  assert.equal(r.usage.chars, 399999);
  r = AZ.addUsage(r.usage, 1, oct);
  assert.equal(r.warn, true, 'warns at exactly 400,000');
  r = AZ.addUsage(r.usage, 50000, oct);
  assert.equal(r.warn, false, 'only once a month');
  r = AZ.addUsage(r.usage, 10, nov);
  assert.deepEqual(r.usage, { month: '2026-11', chars: 10, warned: false }, 'new month starts at zero');
  r = AZ.addUsage({ month: '2026-11', chars: 399990, warned: false }, 20, nov);
  assert.equal(r.warn, true, 'warns again in the new month');
  assert.equal(AZ.formatUsage({ month: '2026-11', chars: 123456, warned: false }, nov),
    'Used 123.5k of 500k characters this month (25%).');
  assert.match(AZ.formatUsage({ month: '2026-10', chars: 999, warned: false }, nov), /Used 0 of 500k/);
});

// ---------- errors and fallback ----------

test('HTTP status maps to error kinds', () => {
  assert.equal(AZ.errorFromStatus(401).kind, 'auth');
  assert.equal(AZ.errorFromStatus(403).kind, 'auth');
  assert.equal(AZ.errorFromStatus(403, 'Quota exceeded').kind, 'quota');
  assert.equal(AZ.errorFromStatus(429).kind, 'quota');
  assert.equal(AZ.errorFromStatus(500).kind, 'other');
  assert.match(AZ.noticeFor(AZ.errorFromStatus(429), 'Microsoft Zira'), /HTTP 429.*Switched to Microsoft Zira/);
});

const local = [
  { name: 'Google US English', lang: 'en-US', localService: false },
  { name: 'Microsoft Mark - English (United States)', lang: 'en-US', localService: true },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true },
  { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
];

test('fallback voice matches gender and locale', () => {
  assert.match(AZ.pickFallbackVoice(ava, local).name, /Zira/);
  assert.match(AZ.pickFallbackVoice({ ShortName: 'en-US-AndrewNeural', Locale: 'en-US', Gender: 'Male' }, local).name, /David/);
  assert.match(AZ.pickFallbackVoice({ Locale: 'en-US' }, local).name, /David/, 'unknown gender: David first');
  const withHazel = [...local, { name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB', localService: true }];
  assert.match(AZ.pickFallbackVoice({ Locale: 'en-GB', Gender: 'Female' }, withHazel).name, /Hazel/);
  assert.match(AZ.pickFallbackVoice({ Locale: 'en-GB', Gender: 'Male' }, withHazel).name, /David/, 'no UK male: same language, same gender');
  assert.match(AZ.pickFallbackVoice({ Locale: 'fr-FR', Gender: 'Female' }, local).name, /Zira/);
  assert.equal(AZ.pickFallbackVoice(ava, []), null);
});

test('voice list keeps standard neural voices, English first', () => {
  const list = AZ.normalizeVoices([
    { ShortName: 'de-DE-KatjaNeural', DisplayName: 'Katja', Locale: 'de-DE', Gender: 'Female', VoiceType: 'Neural' },
    { ShortName: 'en-US-Ava:DragonHDLatestNeural', DisplayName: 'Ava HD', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural' },
    { ShortName: 'en-US-AvaNeural', DisplayName: 'Ava', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural' },
    { ShortName: 'en-GB-RyanNeural', DisplayName: 'Ryan', Locale: 'en-GB', Gender: 'Male', VoiceType: 'Neural' },
    { ShortName: 'en-US-OldStandard', DisplayName: 'Old', Locale: 'en-US', Gender: 'Male', VoiceType: 'Standard' },
  ]);
  assert.deepEqual(list.map((v) => v.ShortName), ['en-GB-RyanNeural', 'en-US-AvaNeural', 'de-DE-KatjaNeural']);
});

// ---------- client ----------

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body = '', json, type = 'audio/mpeg' } = await handler(url, init, calls.length);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => type },
      text: async () => (typeof body === 'string' ? body : ''),
      json: async () => json,
      arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
    };
  };
  f.calls = calls;
  return f;
}

// A fake of the Speech SDK surface the client uses.
function fakeSdk({ fail = false, delay = 5, track } = {}) {
  const S = {
    ResultReason: { SynthesizingAudioCompleted: 'done', Canceled: 'canceled' },
    SpeechSynthesisBoundaryType: { Word: 'WordBoundary', Punctuation: 'PunctuationBoundary' },
    SpeechSynthesisOutputFormat: { Audio24Khz48KBitRateMonoMp3: 'mp3' },
    SpeechConfig: { fromSubscription: (key, region) => ({ key, region }) },
    CancellationDetails: { fromResult: (r) => ({ reason: 'Error', errorDetails: r.details }) },
    opened: 0,
    SpeechSynthesizer: class {
      constructor(cfg, audioConfig) {
        assert.equal(audioConfig, null);
        S.opened++;
        this.closed = false;
      }
      speakSsmlAsync(ssml, ok, err) {
        if (track) track.start();
        setTimeout(() => {
          if (track) track.end();
          if (fail === 'throw') return err('WebSocket closed: 1006');
          if (fail) return ok({ reason: 'canceled', details: 'Connection failed (no connection to the remote host). Internal error: 1006.' });
          const text = ssml.replace(/<[^>]+>/g, '');
          text.split(/\s+/).forEach((w, i) => this.wordBoundary(this, { audioOffset: i * 3e6, text: w.replace(/[.,]$/, ''), boundaryType: 'WordBoundary' }));
          this.wordBoundary(this, { audioOffset: 9e7, text: '.', boundaryType: 'PunctuationBoundary' });
          ok({ reason: 'done', audioData: new ArrayBuffer(8) });
        }, delay);
      }
      close() { this.closed = true; }
    },
  };
  return S;
}

const ssml = AZ.buildSsml('One two three.', ava, 2).ssml;

test('voice list: sends the key header, maps 401 to auth', async () => {
  let f = mockFetch(() => ({ json: [{ ShortName: 'en-US-AvaNeural', DisplayName: 'Ava', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural' }] }));
  const c = AZ.createClient({ key: 'k-test', region: 'eastus', fetch: f, sdk: () => null });
  assert.equal((await c.listVoices()).length, 1);
  assert.equal(f.calls[0].url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
  assert.equal(f.calls[0].init.headers['Ocp-Apim-Subscription-Key'], 'k-test');
  f = mockFetch(() => ({ status: 401 }));
  await assert.rejects(AZ.createClient({ key: 'bad', region: 'eastus', fetch: f, sdk: () => null }).listVoices(), { kind: 'auth', status: 401 });
  f = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(AZ.createClient({ key: 'k', region: 'nowhere', fetch: f, sdk: () => null }).listVoices(), { kind: 'network' });
});

test('SDK path returns audio and word timings only', async () => {
  const f = mockFetch(() => ({ status: 500 }));
  const c = AZ.createClient({ key: 'k', region: 'eastus', fetch: f, sdk: () => sdk });
  const sdk = fakeSdk();
  const r = await c.synthesize(ssml);
  assert.equal(r.via, 'sdk');
  assert.deepEqual(r.words.map((w) => w.text), ['One', 'two', 'three']);
  assert.deepEqual(r.words.map((w) => w.t), [0, 0.3, 0.6]);
  assert.equal(f.calls.length, 0, 'no REST call when the SDK works');
  await c.synthesize(ssml);
  assert.equal(sdk.opened, 1, 'one synthesizer (one connection) reused across chunks');
});

test('SDK failure falls back to REST, which reports the real status', async () => {
  for (const status of [401, 403, 429]) {
    const f = mockFetch(() => ({ status }));
    const c = AZ.createClient({ key: 'k', region: 'eastus', fetch: f, sdk: () => fakeSdk({ fail: true }) });
    await assert.rejects(c.synthesize(ssml), { kind: status === 429 ? 'quota' : 'auth', status });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    assert.equal(f.calls[0].init.headers['Content-Type'], 'application/ssml+xml');
    assert.equal(f.calls[0].init.body, ssml);
  }
});

test('REST serves audio without word timings; after two SDK strikes the client stays on REST', async () => {
  const f = mockFetch(() => ({ body: 'mp3' }));
  const sdk = fakeSdk({ fail: 'throw' });
  const c = AZ.createClient({ key: 'k', region: 'eastus', fetch: f, sdk: () => sdk });
  const r = await c.synthesize(ssml);
  assert.equal(r.via, 'rest');
  assert.equal(r.words, null);
  await c.synthesize(ssml);
  assert.equal(c.usingSdk, false);
  const opened = sdk.opened;
  await c.synthesize(ssml);
  assert.equal(sdk.opened, opened, 'SDK not tried again');
  assert.equal(f.calls.length, 3);
});

test('requests run one at a time, in order', async () => {
  let inFlight = 0;
  let max = 0;
  const track = { start: () => { inFlight++; max = Math.max(max, inFlight); }, end: () => { inFlight--; } };
  const sdk = fakeSdk({ track, delay: 15 });
  const c = AZ.createClient({ key: 'k', region: 'eastus', fetch: mockFetch(() => ({})), sdk: () => sdk });
  const order = [];
  await Promise.all([1, 2, 3].map((n) => c.synthesize(ssml).then(() => order.push(n))));
  assert.equal(max, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('a failed request does not block the next one', async () => {
  let n = 0;
  const f = mockFetch(() => (++n === 1 ? { status: 429 } : { body: 'ok' }));
  const c = AZ.createClient({ key: 'k', region: 'eastus', fetch: f, sdk: () => null });
  const [a, b] = await Promise.allSettled([c.synthesize(ssml), c.synthesize(ssml)]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'fulfilled');
});

// ---------- queue and word alignment ----------

test('prefetcher reuses entries and keeps only the window asked for', async () => {
  const q = new AZ.Prefetcher();
  let made = 0;
  const make = () => ({ job: Promise.resolve(++made) });
  const a = q.get('a', make);
  assert.equal(q.get('a', make), a);
  q.get('b', make);
  q.get('c', () => ({ job: Promise.reject(new Error('x')) })); // must not be an unhandled rejection
  assert.equal(made, 2);
  q.keepOnly(['b', 'c']);
  assert.equal(q.size, 2);
  assert.equal(q.has('a'), false);
  q.drop('b');
  q.clear();
  assert.equal(q.size, 0);
});

test('word timings align to the chunk text, repeated words in order', () => {
  const text = 'The cat saw the cat. Then it left.';
  const words = ['The', 'cat', 'saw', 'the', 'cat', 'Then', 'it', 'left'].map((w, i) => ({ t: i / 10, text: w }));
  const out = AZ.alignWords(words, text);
  assert.deepEqual(out.map((w) => w.index), [0, 4, 8, 12, 16, 21, 26, 29]);
  assert.equal(out[4].length, 3);
  assert.deepEqual(AZ.alignWords(null, text), []);
  assert.deepEqual(AZ.alignWords([{ t: 0, text: 'missing' }], text), []);
});
