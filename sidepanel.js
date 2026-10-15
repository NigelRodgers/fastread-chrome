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

const settings = { speed: DEFAULT_SPEED, voiceName: '', fontSize: 17, theme: 'auto' };

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
  $('rate').max = SPEEDS.length - 1;
  $('rate').value = settings.speed;
  $('rateLabel').textContent = SPEEDS[settings.speed].label;
  $('fontSize').value = settings.fontSize;
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  $('theme').value = settings.theme;
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

function clampSpeed(i) {
  i = Math.round(Number(i));
  if (!Number.isFinite(i)) i = DEFAULT_SPEED;
  return Math.min(SPEEDS.length - 1, Math.max(0, i));
}

let rateRestart = null;
function setSpeed(i) {
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

// ---------- voices ----------

function loadVoices() {
  state.voices = speechSynthesis.getVoices();
  const sel = $('voice');
  sel.textContent = '';
  const sorted = state.voices.slice().sort((a, b) =>
    (b.localService - a.localService) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  for (const v of sorted) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name}${v.localService ? '' : ' (online)'}`;
    sel.append(o);
  }
  const v = currentVoice();
  if (v) sel.value = v.name;
}

function currentVoice() {
  const vs = state.voices;
  if (!vs.length) return null;
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
  setPlaying(false);
}

function play(from = state.cur) {
  if (!state.sentences.length) return;
  stop();
  state.cur = Math.max(0, Math.min(from, state.sentences.length - 1));
  setPlaying(true);
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
  else if (msg.type === 'faster') setSpeed(settings.speed + 1);
  else if (msg.type === 'slower') setSpeed(settings.speed - 1);
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
  $('slower').onclick = () => setSpeed(settings.speed - 1);
  $('faster').onclick = () => setSpeed(settings.speed + 1);
  $('rate').oninput = (e) => setSpeed(e.target.value);
  $('reload').onclick = () => loadPage();
  $('pick').onclick = startPicker;
  $('staleLoad').onclick = () => loadPage();
  $('settingsBtn').onclick = () => {
    const s = $('settings');
    s.hidden = !s.hidden;
    $('settingsBtn').setAttribute('aria-expanded', String(!s.hidden));
  };
  $('voice').onchange = (e) => {
    settings.voiceName = e.target.value;
    saveSettings();
    if (state.playing) play(state.cur);
  };
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
    else if (e.key === '-' || e.key === '_') setSpeed(settings.speed - 1);
    else if (e.key === '=' || e.key === '+') setSpeed(settings.speed + 1);
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
  await loadSettings();
  loadVoices();
  wire();
  connect();
  if (!(await takePending())) loadPage();
}

init();
