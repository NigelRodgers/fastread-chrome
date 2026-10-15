// FastRead side panel: extracts the active tab's text and reads it with speechSynthesis.

const $ = (id) => document.getElementById(id);
const docEl = $('doc');
const statusEl = $('status');

// Speed steps. On Windows, Chrome hands local voices an integer SAPI rate of
// trunc(10 * log10(rate)), from -10 to 10 (+10 is about 3x normal talking speed). Values between
// steps sound identical, so offer exactly one value per SAPI step, nudged so truncation lands on it.
// The labels use Chrome's own scale, so "2x" matches 2x in Chrome's Reading mode.
const SPEEDS = [];
for (let n = -3; n <= 10; n++) {
  const exact = 10 ** (n / 10);
  // speechSynthesis rejects rates above 10.
  const rate = n === 10 ? 10 : n > 0 ? exact * 1.001 : n < 0 ? exact * 0.999 : 1;
  SPEEDS.push({ rate, label: `${Math.round(exact * 10) / 10}×` });
}
const DEFAULT_SPEED = 6; // 2x
const LIBS = ['lib/Readability.js', 'lib/defuddle.js', 'content/extract.js'];

const AZ = globalThis.FastReadAzure;
const AZURE_PREFIX = 'azure:';
const AZURE_CHUNK = 600;   // max characters per Azure request (one block at most)
const AZURE_AHEAD = 2;     // chunks synthesized ahead of the one playing
const VOICE_CACHE_MS = 7 * 24 * 3600 * 1000;

// voiceName is a local voice name, or "azure:<ShortName>" for an Azure neural voice.
// speed indexes SPEEDS (local voices); azureSpeed indexes AZ.SPEEDS (Azure voices).
const settings = { speed: DEFAULT_SPEED, azureSpeed: AZ.DEFAULT_SPEED, voiceName: '', fontSize: 17, theme: 'auto' };

// Azure state. The key lives in its own storage entry (azureKey), never in `settings`, the DOM or logs.
const azure = {
  key: '',
  region: '',
  voices: [],          // normalized Azure voice list (cached in storage as azureVoices)
  client: null,
  usage: null,         // { month, chars, warned }
  usageChain: Promise.resolve(),
  down: null,          // AzureError that switched this panel to a local voice
  fallbackVoice: null, // the local voice used while Azure is down
  queue: new AZ.Prefetcher(),
  audio: new Audio(),
  url: '',
  chunk: null,         // the chunk loaded in `audio`: { key, start, end, text, offsets, words }
  first: false,        // next chunk is the first after play(): keep it to one sentence for a quick start
  timer: 0,
  lastWord: '',
};
azure.audio.preservesPitch = true;

const state = {
  windowId: null,
  tabId: null,
  page: null,        // { url, title, method, blocks }
  sentences: [],     // { text, block, el }
  cur: 0,            // index of the sentence being read (or to read next)
  playing: false,
  gen: 0,            // bumps on every stop/restart so stale utterance events are ignored
  voices: [],
  userScrollAt: 0,
};

// ---------- settings ----------

async function loadSettings() {
  Object.assign(settings, await chrome.storage.local.get(settings));
  applySettings();
}

function saveSettings() {
  chrome.storage.local.set(settings);
}

function applySettings() {
  settings.speed = clampSpeed(settings.speed);
  settings.azureSpeed = clampSpeed(settings.azureSpeed, AZ.SPEEDS.length, AZ.DEFAULT_SPEED);
  if (usingAzure()) {
    $('rate').max = AZ.SPEEDS.length - 1;
    $('rate').value = settings.azureSpeed;
    $('rateLabel').textContent = AZ.speedLabel(settings.azureSpeed);
    $('rateLabel').title = AZ.speedTitle(settings.azureSpeed);
  } else {
    $('rate').max = SPEEDS.length - 1;
    $('rate').value = settings.speed;
    $('rateLabel').textContent = SPEEDS[settings.speed].label;
    $('rateLabel').title = "Same scale as Chrome's Reading mode";
  }
  $('fontSize').value = settings.fontSize;
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  $('theme').value = settings.theme;
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

function clampSpeed(i, count = SPEEDS.length, fallback = DEFAULT_SPEED) {
  i = Math.round(Number(i));
  if (!Number.isFinite(i)) i = fallback;
  return Math.min(count - 1, Math.max(0, i));
}

// Slider position for whichever voice type is active.
function speedIndex() {
  return usingAzure() ? settings.azureSpeed : settings.speed;
}

let rateRestart = null;
function setSpeed(i) {
  if (usingAzure()) {
    setAzureSpeed(i);
    return;
  }
  const next = clampSpeed(i);
  if (next === settings.speed) return;
  settings.speed = next;
  applySettings();
  saveSettings();
  if (state.playing) {
    // Restart the current sentence at the new speed, debounced so dragging the slider is smooth.
    clearTimeout(rateRestart);
    rateRestart = setTimeout(() => state.playing && play(state.cur), 250);
  }
}

// Azure: same audio (prosody unchanged) just plays faster or slower; otherwise restart the sentence.
function setAzureSpeed(i) {
  const next = clampSpeed(i, AZ.SPEEDS.length, AZ.DEFAULT_SPEED);
  if (next === settings.azureSpeed) return;
  const before = AZ.speedParts(AZ.SPEEDS[settings.azureSpeed]);
  settings.azureSpeed = next;
  applySettings();
  saveSettings();
  if (!state.playing) return;
  const after = AZ.speedParts(AZ.SPEEDS[next]);
  if (Math.abs(after.prosody - before.prosody) < 0.005) {
    azure.audio.defaultPlaybackRate = after.playback;
    azure.audio.playbackRate = after.playback;
    return;
  }
  clearTimeout(rateRestart);
  rateRestart = setTimeout(() => state.playing && play(state.cur), 250);
}

// ---------- voices ----------

const isAzureName = (name) => String(name || '').startsWith(AZURE_PREFIX);

// The selected Azure voice, or null when a local voice is selected or no key is set.
function azureVoice() {
  if (!isAzureName(settings.voiceName) || !azure.key || !azure.region) return null;
  const short = settings.voiceName.slice(AZURE_PREFIX.length);
  return azure.voices.find((v) => v.ShortName === short) ||
    { ShortName: short, Locale: short.split('-').slice(0, 2).join('-'), Gender: '' };
}

function usingAzure() {
  return !!azureVoice() && !azure.down;
}

function loadVoices() {
  state.voices = speechSynthesis.getVoices();
  const sel = $('voice');
  sel.textContent = '';
  const sorted = state.voices.slice().sort((a, b) =>
    (b.localService - a.localService) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  let localParent = sel;
  if (azure.key && azure.voices.length) {
    const g = document.createElement('optgroup');
    g.label = 'Azure neural voices (online, uses your key)';
    for (const v of azure.voices) {
      const o = document.createElement('option');
      o.value = AZURE_PREFIX + v.ShortName;
      o.textContent = `${v.DisplayName} · ${v.Locale}${v.Gender ? ` · ${v.Gender}` : ''}`;
      g.append(o);
    }
    sel.append(g);
    localParent = document.createElement('optgroup');
    localParent.label = 'Chrome and Windows voices';
    sel.append(localParent);
  }
  for (const v of sorted) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name}${v.localService ? '' : ' (online)'}`;
    localParent.append(o);
  }
  if (azureVoice() && [...sel.options].some((o) => o.value === settings.voiceName)) {
    sel.value = settings.voiceName;
    return;
  }
  const v = currentVoice();
  if (v) sel.value = v.name;
}

// Switching between local and Azure voices keeps the perceived speed (the two use different scales).
function selectVoice(name) {
  const wasAzure = usingAzure();
  const natural = wasAzure ? AZ.SPEEDS[settings.azureSpeed] : AZ.windowsNatural(settings.speed);
  settings.voiceName = name;
  if (isAzureName(name)) {
    azure.down = null; // picking an Azure voice again retries Azure
    azure.fallbackVoice = null;
    $('azureNotice').hidden = true;
  }
  const nowAzure = usingAzure();
  if (nowAzure && !wasAzure) settings.azureSpeed = AZ.azureIndexFor(natural);
  if (!nowAzure && wasAzure) settings.speed = AZ.windowsIndexFor(natural);
  if (nowAzure !== wasAzure) applySettings();
  saveSettings();
  if (nowAzure) ensureSdk();
  if (state.playing) play(state.cur);
}

// The voice for the speechSynthesis path. With an Azure voice selected, that's the local voice
// standing in for it while Azure is down (matched by locale and gender).
function currentVoice() {
  const vs = state.voices;
  if (!vs.length) return null;
  if (isAzureName(settings.voiceName)) {
    return azure.fallbackVoice ||
      AZ.pickFallbackVoice(azureVoice() || { Locale: settings.voiceName.slice(AZURE_PREFIX.length, AZURE_PREFIX.length + 5) }, vs);
  }
  return (
    vs.find((v) => v.name === settings.voiceName) ||
    vs.find((v) => v.default && v.localService) ||
    vs.find((v) => v.localService && /^en/i.test(v.lang)) ||
    vs[0]
  );
}

// ---------- page loading ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  return tab;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

function friendlyError(e, url) {
  const m = String((e && e.message) || e);
  if (/cannot access|cannot be scripted|chrome:\/\/|extensions gallery|webstore/i.test(m) || /^(chrome|edge|about|chrome-extension):/.test(url || '')) {
    return 'Chrome does not let extensions read this page (browser pages and the Chrome Web Store are off-limits).';
  }
  if (/^file:/.test(url || '')) {
    return 'To read local files, enable "Allow access to file URLs" for FastRead in chrome://extensions.';
  }
  return `Could not read this page: ${m}`;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: LIBS });
}

async function runInTab(tabId, func) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return res && res.result;
}

async function loadPage({ autoplay = false } = {}) {
  stop();
  $('stale').hidden = true;
  const tab = await activeTab();
  if (!tab) return;
  state.tabId = tab.id;
  setStatus('Reading page…');
  try {
    await inject(tab.id);
    const page = await runInTab(tab.id, () => window.__fastread.extract());
    if (!page || !page.blocks.length) throw new Error('no readable text found');
    setStatus('');
    render(page);
    if (autoplay) play(0);
  } catch (e) {
    render(null);
    setStatus(friendlyError(e, tab.url), true);
  }
}

async function loadSelection(tabId, fallbackText) {
  stop();
  $('stale').hidden = true;
  state.tabId = tabId;
  let page = null;
  try {
    await inject(tabId);
    page = await runInTab(tabId, () => window.__fastread.selection());
  } catch {
    // fall through to plain text
  }
  if (!page && fallbackText && fallbackText.trim()) {
    page = { title: '', method: 'selection', blocks: [{ tag: 'P', text: fallbackText.replace(/\s+/g, ' ').trim() }] };
  }
  if (!page) {
    setStatus('Select some text on the page first.', true);
    return;
  }
  setStatus('');
  render(page);
  play(0);
}

// ---------- rendering ----------

const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

// Split text into sentences; break up very long runs (lists, code, missing punctuation)
// so skipping and restarting stay fine-grained.
function sentencesOf(text) {
  const out = [];
  for (const { segment } of segmenter.segment(text)) {
    let s = segment.trim();
    while (s.length > 400) {
      let cut = s.lastIndexOf('; ', 300);
      if (cut < 150) cut = s.lastIndexOf(', ', 300);
      if (cut < 150) cut = s.lastIndexOf(' ', 300);
      if (cut < 150) cut = 300;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

function render(page) {
  state.page = page;
  state.sentences = [];
  state.cur = 0;
  azureRelease();
  azure.queue.clear(); // queued chunks are keyed by sentence index
  CSS.highlights.delete('fr-word');
  docEl.textContent = '';
  if (!page) {
    $('method').textContent = '';
    $('progress').textContent = '';
    return;
  }
  const frag = document.createDocumentFragment();
  page.blocks.forEach((b, bi) => {
    let el;
    if (b.tag === 'H') el = document.createElement(b.title ? 'h1' : 'h2');
    else if (b.tag === 'Q') el = document.createElement('blockquote');
    else if (b.tag === 'PRE') el = document.createElement('pre');
    else if (b.tag === 'LI') { el = document.createElement('div'); el.className = 'li'; }
    else el = document.createElement('p');
    const parts = b.tag === 'PRE' ? [b.text] : sentencesOf(b.text);
    parts.forEach((text, k) => {
      if (k) el.append(' ');
      const span = document.createElement('span');
      span.className = 's';
      span.textContent = text;
      span.dataset.i = state.sentences.length;
      state.sentences.push({ text, block: bi, el: span });
      el.append(span);
    });
    frag.append(el);
  });
  docEl.append(frag);
  docEl.scrollTop = 0;
  const words = page.blocks.reduce((n, b) => n + b.text.split(/\s+/).length, 0);
  $('method').textContent = `${words.toLocaleString()} words · ${page.method}`;
  updateProgress();
}

function updateProgress() {
  const n = state.sentences.length;
  $('progress').textContent = n ? `${Math.min(state.cur + 1, n)} / ${n}` : '';
}

function markSentence(i) {
  const prev = docEl.querySelector('.s.cur');
  if (prev) prev.classList.remove('cur');
  CSS.highlights.delete('fr-word');
  const s = state.sentences[i];
  if (!s) return;
  s.el.classList.add('cur');
  updateProgress();
  // Follow along, unless the user scrolled recently.
  if (Date.now() - state.userScrollAt > 3000) {
    const r = s.el.getBoundingClientRect();
    const v = docEl.getBoundingClientRect();
    if (r.top < v.top + 40 || r.bottom > v.bottom - 80) {
      s.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function markWord(i, offset, length) {
  const s = state.sentences[i];
  const node = s && s.el.firstChild;
  if (!node) return;
  const max = node.length;
  const start = Math.max(0, Math.min(offset, max));
  const end = Math.max(start, Math.min(start + length, max));
  if (end <= start) return;
  const range = new Range();
  range.setStart(node, start);
  range.setEnd(node, end);
  CSS.highlights.set('fr-word', new Highlight(range));
}

// ---------- speech ----------

function setPlaying(on) {
  state.playing = on;
  document.body.classList.toggle('playing', on);
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
}

function stop() {
  state.gen++;
  clearTimeout(rateRestart);
  speechSynthesis.cancel();
  azurePause();
  setPlaying(false);
}

function play(from = state.cur) {
  if (!state.sentences.length) return;
  stop();
  state.cur = Math.max(0, Math.min(from, state.sentences.length - 1));
  setPlaying(true);
  azure.first = true;
  if (usingAzure() && azureResume(state.gen)) return;
  speakChunk(state.gen);
}

function togglePlay() {
  if (state.playing) stop();
  else if (state.cur >= state.sentences.length - 1 && state.sentences.length && state.ended) play(0);
  else play(state.cur);
}

function skip(delta) {
  const i = Math.max(0, Math.min(state.cur + delta, state.sentences.length - 1));
  if (state.playing) play(i);
  else {
    state.cur = i;
    markSentence(i);
  }
}

// Speak several sentences of one block per utterance (fewer gaps at high speed). Online voices
// get one sentence at a time: Chrome cuts them off after ~15 s of continuous speech.
function speakChunk(gen) {
  if (gen !== state.gen) return;
  const all = state.sentences;
  if (state.cur >= all.length) {
    state.ended = true;
    state.cur = all.length - 1;
    setPlaying(false);
    return;
  }
  state.ended = false;
  if (usingAzure()) {
    speakAzure(gen);
    return;
  }
  const voice = currentVoice();
  const maxChars = voice && !voice.localService ? 0 : 1200;
  const start = state.cur;
  const offsets = [];
  let text = '';
  let i = start;
  while (i < all.length && all[i].block === all[start].block && (i === start || text.length + all[i].text.length < maxChars)) {
    offsets.push(text.length);
    text += `${all[i].text} `;
    i++;
  }
  const end = i;

  const u = new SpeechSynthesisUtterance(text);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = SPEEDS[settings.speed].rate;

  u.onstart = () => {
    if (gen === state.gen) markSentence(start);
  };
  u.onboundary = (e) => {
    if (gen !== state.gen || e.name !== 'word') return;
    let k = offsets.length - 1;
    while (k > 0 && offsets[k] > e.charIndex) k--;
    const si = start + k;
    if (si !== state.cur) {
      state.cur = si;
      markSentence(si);
    }
    const local = e.charIndex - offsets[k];
    const len = e.charLength || (/^\S+/.exec(text.slice(e.charIndex)) || [''])[0].length;
    markWord(si, local, len);
  };
  u.onend = () => {
    if (gen !== state.gen) return;
    state.cur = end;
    speakChunk(gen);
  };
  u.onerror = (e) => {
    if (gen !== state.gen || e.error === 'interrupted' || e.error === 'canceled') return;
    setStatus(`Speech error: ${e.error}`, true);
    setPlaying(false);
  };

  state.cur = start;
  speechSynthesis.speak(u);
}

// ---------- Azure playback ----------
// Each chunk (up to AZURE_CHUNK characters of one block) is synthesized to an MP3 and played in an
// <audio> element; the next AZURE_AHEAD chunks are synthesized while it plays. Speed is SSML
// <prosody rate> up to 2x, times audio.playbackRate (pitch preserved) for the rest.

let sdkLoading = null;
function ensureSdk() {
  if (window.SpeechSDK) return Promise.resolve();
  sdkLoading = sdkLoading || new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'lib/speech-sdk.min.js';
    s.onload = s.onerror = () => resolve(); // without the SDK the client uses REST
    document.head.append(s);
  });
  return sdkLoading;
}

function azureClient() {
  if (!azure.client) azure.client = AZ.createClient({ key: azure.key, region: azure.region });
  return azure.client;
}

function resetAzureClient() {
  if (azure.client) azure.client.close();
  azure.client = null;
  azure.queue.clear();
}

// End (exclusive) of the chunk starting at sentence `start`.
function azureChunkEnd(start, first) {
  const all = state.sentences;
  let i = start;
  let len = 0;
  while (i < all.length && all[i].block === all[start].block &&
    (i === start || (!first && len + all[i].text.length < AZURE_CHUNK))) {
    len += all[i].text.length + 1;
    i++;
  }
  return i;
}

function azureKey(start) {
  const voice = azureVoice();
  const { prosody } = AZ.speedParts(AZ.SPEEDS[settings.azureSpeed]);
  return `${voice.ShortName}|${prosody}|${start}`;
}

// The queued chunk starting at sentence `start`, requesting it if needed.
function azureChunk(start, first = false) {
  const key = azureKey(start);
  return azure.queue.get(key, () => {
    const end = azureChunkEnd(start, first);
    const offsets = [];
    let text = '';
    for (let i = start; i < end; i++) {
      if (i > start) text += ' ';
      offsets.push(text.length);
      text += state.sentences[i].text;
    }
    const { ssml, billable } = AZ.buildSsml(text, azureVoice(), AZ.speedParts(AZ.SPEEDS[settings.azureSpeed]).prosody);
    const job = ensureSdk()
      .then(() => azureClient().synthesize(ssml))
      .then((res) => {
        countUsage(billable);
        return res;
      });
    return { key, start, end, text, offsets, job };
  });
}

// Keep the chunk at `entry` and the next AZURE_AHEAD chunks queued; drop the rest.
function azurePrefetch(entry) {
  const keys = [entry.key];
  let s = entry.end;
  for (let k = 0; k < AZURE_AHEAD && s < state.sentences.length; k++) {
    const next = azureChunk(s);
    keys.push(next.key);
    s = next.end;
  }
  azure.queue.keepOnly(keys);
}

function speakAzure(gen) {
  const entry = azureChunk(state.cur, azure.first);
  azure.first = false;
  azurePrefetch(entry);
  markSentence(entry.start);
  entry.job.then(
    (res) => gen === state.gen && azurePlay(entry, res, gen),
    (err) => gen === state.gen && azureFailed(err, gen),
  );
}

function azurePlay(entry, res, gen) {
  azureRelease();
  const a = azure.audio;
  azure.url = URL.createObjectURL(new Blob([res.audio], { type: res.type }));
  azure.chunk = { ...entry, words: AZ.alignWords(res.words, entry.text) };
  a.src = azure.url;
  azureStart(gen, entry.start);
}

// (Re)attach handlers for this generation and play from the current position.
function azureStart(gen, sentence) {
  const a = azure.audio;
  const c = azure.chunk;
  const rate = AZ.speedParts(AZ.SPEEDS[settings.azureSpeed]).playback;
  a.defaultPlaybackRate = rate; // loading a new src resets playbackRate to this
  a.playbackRate = rate;
  a.preservesPitch = true;
  a.onended = () => {
    if (gen !== state.gen) return;
    azure.queue.drop(c.key);
    state.cur = c.end;
    speakChunk(gen);
  };
  a.onerror = () => {
    if (gen !== state.gen) return;
    setStatus('Could not play the Azure audio.', true);
    setPlaying(false);
  };
  state.cur = sentence;
  markSentence(sentence);
  azure.lastWord = '';
  a.play().catch((e) => {
    if (gen !== state.gen || e.name === 'AbortError') return;
    setStatus(`Playback blocked: ${e.message}`, true);
    setPlaying(false);
  });
  clearInterval(azure.timer);
  azure.timer = setInterval(() => azureTick(gen), 50);
}

// Resume the paused chunk if the reading position is inside it (no new request, no new
// characters billed). Seeks when the position moved to another sentence of the chunk.
function azureResume(gen) {
  const c = azure.chunk;
  if (!c || !azure.url || state.cur < c.start || state.cur >= c.end || c.key !== azureKey(c.start)) return false;
  const a = azure.audio;
  if (state.cur !== azure.pausedAt) {
    const k = state.cur - c.start;
    const w = c.words.find((x) => x.index >= c.offsets[k]);
    if (w) a.currentTime = Math.max(0, w.t - 0.05);
    else if (Number.isFinite(a.duration)) a.currentTime = (a.duration * c.offsets[k]) / c.text.length;
    else return false;
  }
  azurePrefetch(c);
  azureStart(gen, state.cur);
  return true;
}

// Move the sentence and word highlights along with the audio.
function azureTick(gen) {
  const c = azure.chunk;
  const a = azure.audio;
  if (gen !== state.gen || !c) return;
  const t = a.currentTime;
  let index;
  let length = 0;
  if (c.words.length) {
    let k = -1;
    while (k + 1 < c.words.length && c.words[k + 1].t <= t) k++;
    if (k === -1) return;
    ({ index, length } = c.words[k]);
  } else {
    // REST audio has no word timings: estimate the sentence from the time played.
    if (!Number.isFinite(a.duration) || !a.duration) return;
    index = Math.floor((c.text.length * t) / a.duration);
  }
  let k = c.offsets.length - 1;
  while (k > 0 && c.offsets[k] > index) k--;
  const si = c.start + k;
  if (si !== state.cur) {
    state.cur = si;
    markSentence(si);
  }
  const mark = `${si}:${index}`;
  if (length && mark !== azure.lastWord) {
    azure.lastWord = mark;
    markWord(si, index - c.offsets[k], length);
  }
}

function azurePause() {
  clearInterval(azure.timer);
  const a = azure.audio;
  a.onended = null;
  a.onerror = null;
  if (!a.paused) a.pause();
  azure.pausedAt = state.cur;
}

function azureRelease() {
  azurePause();
  const a = azure.audio;
  if (azure.url) {
    a.removeAttribute('src');
    a.load();
    URL.revokeObjectURL(azure.url);
  }
  azure.url = '';
  azure.chunk = null;
}

// Azure failed (key rejected, quota used up, unreachable): switch to the matching local voice and
// keep reading from the same sentence.
function azureFailed(err, gen) {
  const fallback = AZ.pickFallbackVoice(azureVoice(), state.voices);
  azure.down = err;
  azure.fallbackVoice = fallback;
  azureRelease();
  azure.queue.clear();
  settings.speed = AZ.windowsIndexFor(AZ.SPEEDS[settings.azureSpeed]); // same perceived speed
  applySettings();
  saveSettings();
  showAzureNotice(AZ.noticeFor(err, fallback && fallback.name), true);
  speakChunk(gen);
}

function retryAzure() {
  if (!azure.down) return;
  azure.down = null;
  azure.fallbackVoice = null;
  settings.azureSpeed = AZ.azureIndexFor(AZ.windowsNatural(settings.speed));
  applySettings();
  saveSettings();
  $('azureNotice').hidden = true;
  if (state.playing) play(state.cur);
}

function showAzureNotice(text, canRetry = false) {
  $('azureNoticeText').textContent = text;
  $('azureRetry').hidden = !canRetry;
  $('azureNotice').hidden = false;
}

// ---------- Azure settings and usage ----------

function setAzureStatus(msg, isError = false) {
  const el = $('azureStatus');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function showUsage() {
  $('azureUsage').textContent = azure.key || (azure.usage && azure.usage.chars) ? AZ.formatUsage(azure.usage) : '';
}

// Count billable characters per calendar month; warn once a month at 80% of the free tier.
function countUsage(chars) {
  azure.usageChain = azure.usageChain.then(async () => {
    const { azureUsage } = await chrome.storage.local.get('azureUsage');
    const { usage, warn } = AZ.addUsage(azureUsage, chars);
    azure.usage = usage;
    await chrome.storage.local.set({ azureUsage: usage });
    showUsage();
    if (warn) {
      showAzureNotice(`Azure usage: ${Math.round(usage.chars / 1000)}k of your 500k free characters this month. ` +
        'If Azure starts refusing requests, FastRead switches to a Windows voice.');
    }
  }).catch(() => {});
}

async function loadAzure() {
  const got = await chrome.storage.local.get(['azureKey', 'azureRegion', 'azureUsage', 'azureVoices']);
  azure.key = got.azureKey || '';
  azure.region = got.azureRegion || '';
  azure.usage = got.azureUsage || null;
  $('azureRegion').value = azure.region;
  $('azureKey').placeholder = azure.key ? 'Key saved (hidden). Paste a new one to replace it.' : 'Paste your Speech key';
  $('azureForget').hidden = !azure.key;
  const cache = got.azureVoices;
  if (cache && cache.region === azure.region && Date.now() - cache.at < VOICE_CACHE_MS) azure.voices = cache.voices;
  else if (azure.key && azure.region) refreshAzureVoices();
  showUsage();
}

async function refreshAzureVoices() {
  setAzureStatus('Loading Azure voices…');
  try {
    const voices = await azureClient().listVoices();
    azure.voices = voices;
    await chrome.storage.local.set({ azureVoices: { region: azure.region, at: Date.now(), voices } });
    setAzureStatus(`${voices.length} Azure voices loaded. Pick one in the Voice list.`);
    loadVoices();
    applySettings();
  } catch (e) {
    const msg = e.kind === 'auth' ? `Azure rejected the key for region "${azure.region}" (HTTP ${e.status}).`
      : e.kind === 'network' ? 'Could not reach Azure. Check the region name and your connection.'
        : `Could not load Azure voices (${e.message}).`;
    setAzureStatus(msg, true);
  }
}

async function saveAzure() {
  const key = $('azureKey').value.trim();
  const region = $('azureRegion').value.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(region)) {
    setAzureStatus('Enter the region shown next to your key, for example eastus or westeurope.', true);
    return;
  }
  if (key && !/^[A-Za-z0-9]{16,128}$/.test(key)) {
    setAzureStatus('That does not look like a Speech key (letters and digits only).', true);
    return;
  }
  if (!key && !azure.key) {
    setAzureStatus('Paste your key first.', true);
    return;
  }
  stop();
  if (key) azure.key = key;
  azure.region = region;
  $('azureKey').value = '';
  $('azureKey').placeholder = 'Key saved (hidden). Paste a new one to replace it.';
  $('azureForget').hidden = false;
  await chrome.storage.local.set({ azureKey: azure.key, azureRegion: azure.region });
  resetAzureClient();
  azure.down = null;
  azure.fallbackVoice = null;
  await refreshAzureVoices();
}

async function forgetAzure() {
  stop();
  const wasAzure = usingAzure();
  await chrome.storage.local.remove(['azureKey', 'azureVoices']);
  azure.key = '';
  azure.voices = [];
  resetAzureClient();
  if (wasAzure) settings.speed = AZ.windowsIndexFor(AZ.SPEEDS[settings.azureSpeed]);
  $('azureKey').placeholder = 'Paste your Speech key';
  $('azureForget').hidden = true;
  setAzureStatus('Key removed from this browser.');
  loadVoices();
  applySettings();
  showUsage();
}

// ---------- picker ----------

async function startPicker() {
  const tab = await activeTab();
  if (!tab) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [...LIBS, 'content/picker.js'] });
    $('pick').classList.add('active');
    setStatus('Click on the page where you want to start reading.');
  } catch (e) {
    setStatus(friendlyError(e, tab.url), true);
  }
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function onPicked(msg) {
  $('pick').classList.remove('active');
  setStatus('');
  if (msg.cancelled || !msg.blocks || !msg.blocks.length) return;
  // If the picked text is part of the article we already have, start there.
  if (state.page && state.page.url === msg.url && msg.sample) {
    const needle = norm(msg.sample).slice(0, 60);
    const firstPicked = norm(msg.blocks[0].text).slice(0, 60);
    const bi = state.page.blocks.findIndex((b) => {
      const t = norm(b.text);
      return t.startsWith(needle) || t.startsWith(firstPicked) || t.includes(firstPicked);
    });
    if (bi !== -1) {
      const si = state.sentences.findIndex((s) => s.block === bi);
      if (si !== -1) {
        play(si);
        return;
      }
    }
  }
  // Otherwise the article extraction missed it: read what was picked.
  render({ url: msg.url, title: msg.title, method: 'picked', blocks: msg.blocks });
  play(0);
}

// ---------- wiring ----------

function connect() {
  const port = chrome.runtime.connect({ name: `panel:${state.windowId}` });
  port.onMessage.addListener(handleCommand);
  // The service worker can restart; reconnect so commands keep arriving.
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}

function handleCommand(msg) {
  if (!msg) return;
  if (msg.type === 'toggle') togglePlay();
  else if (msg.type === 'faster') setSpeed(speedIndex() + 1);
  else if (msg.type === 'slower') setSpeed(speedIndex() - 1);
  else if (msg.type === 'selection') loadSelection(msg.tabId, msg.text);
  else if (msg.type === 'page') loadPage({ autoplay: !!msg.autoplay });
}

async function takePending() {
  const key = `pending:${state.windowId}`;
  const { [key]: msg } = await chrome.storage.session.get(key);
  if (!msg) return false;
  await chrome.storage.session.remove(key);
  if (Date.now() - msg.at > 15000) return false;
  handleCommand(msg);
  return true;
}

function wire() {
  $('play').onclick = togglePlay;
  $('prev').onclick = () => skip(-1);
  $('next').onclick = () => skip(1);
  $('slower').onclick = () => setSpeed(speedIndex() - 1);
  $('faster').onclick = () => setSpeed(speedIndex() + 1);
  $('rate').oninput = (e) => setSpeed(e.target.value);
  $('reload').onclick = () => loadPage();
  $('pick').onclick = startPicker;
  $('staleLoad').onclick = () => loadPage();
  $('settingsBtn').onclick = () => {
    const s = $('settings');
    s.hidden = !s.hidden;
    $('settingsBtn').setAttribute('aria-expanded', String(!s.hidden));
  };
  $('voice').onchange = (e) => selectVoice(e.target.value);
  $('azureSave').onclick = saveAzure;
  $('azureForget').onclick = forgetAzure;
  $('azureKey').addEventListener('keydown', (e) => e.key === 'Enter' && saveAzure());
  $('azureRetry').onclick = retryAzure;
  $('azureNoticeClose').onclick = () => { $('azureNotice').hidden = true; };
  $('fontSize').oninput = (e) => {
    settings.fontSize = Number(e.target.value);
    applySettings();
    saveSettings();
  };
  $('theme').onchange = (e) => {
    settings.theme = e.target.value;
    applySettings();
    saveSettings();
  };

  docEl.addEventListener('click', (e) => {
    const s = e.target.closest('.s');
    // Ignore clicks that end a text selection.
    if (s && !String(getSelection())) play(Number(s.dataset.i));
  });
  docEl.addEventListener('wheel', () => { state.userScrollAt = Date.now(); }, { passive: true });
  docEl.addEventListener('touchmove', () => { state.userScrollAt = Date.now(); }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ' || e.key === 'k') togglePlay();
    else if (e.key === 'ArrowLeft') skip(-1);
    else if (e.key === 'ArrowRight') skip(1);
    else if (e.key === '-' || e.key === '_') setSpeed(speedIndex() - 1);
    else if (e.key === '=' || e.key === '+') setSpeed(speedIndex() + 1);
    else return;
    e.preventDefault();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'fastread-picked') onPicked(msg);
  });

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId !== state.windowId) return;
    if (state.playing) $('stale').hidden = false;
    else loadPage();
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== state.tabId || info.status !== 'complete' || !tab.active) return;
    if (state.page && state.page.url === tab.url) return;
    if (state.playing) $('stale').hidden = false;
    else loadPage();
  });

  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes[`pending:${state.windowId}`]?.newValue) takePending();
  });

  speechSynthesis.onvoiceschanged = loadVoices;
}

async function init() {
  speechSynthesis.cancel();
  const win = await chrome.windows.getCurrent();
  state.windowId = win.id;
  await loadAzure();
  await loadSettings();
  if (usingAzure()) ensureSdk();
  loadVoices();
  wire();
  connect();
  if (!(await takePending())) loadPage();
}

init();
