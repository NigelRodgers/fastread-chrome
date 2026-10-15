// FastRead Azure neural voices: speed scale, SSML and billing count, monthly usage, fallback voice
// choice, a client (Speech SDK with a REST fallback) and a prefetch cache.
// Classic script: sets globalThis.FastReadAzure so the side panel and the Node tests share it.
// Nothing here touches the DOM or chrome.* APIs; the network and the SDK are passed in.

(() => {
  const FREE_CHARS = 500000; // F0 tier: 0.5 million neural characters a month
  const WARN_AT = 0.8;

  // Speeds are multiples of the voice's own normal rate, which is how Chrome's scale works for
  // natural (non-SAPI) voices. Azure's SSML <prosody rate> accepts 0.5 to 2; anything past 2 is
  // done by the audio element's playbackRate with preservesPitch on.
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6];
  const DEFAULT_SPEED = 6; // 2x
  const MAX_PROSODY = 2;
  const MIN_PROSODY = 0.5;

  function speedParts(speed) {
    const prosody = Math.min(MAX_PROSODY, Math.max(MIN_PROSODY, speed));
    return { prosody, playback: speed / prosody };
  }

  // ---------- Windows-voice equivalence ----------
  // Windows (SAPI) voices: slider index i is SAPI step n = i - 3, and SAPI step n speaks at about
  // 3^(n/10) times normal (+10 is about 3x). Used to keep the perceived speed when switching engines.

  const WIN_STEPS = 14; // n = -3..10

  function windowsNatural(index) {
    return 3 ** ((index - 3) / 10);
  }

  function windowsLabel(index) {
    return `${Math.round(10 ** ((index - 3) / 10) * 10) / 10}×`;
  }

  function windowsIndexFor(natural) {
    const i = Math.round((10 * Math.log(natural)) / Math.log(3)) + 3;
    return Math.min(WIN_STEPS - 1, Math.max(0, i));
  }

  function azureIndexFor(natural) {
    let best = 0;
    SPEEDS.forEach((s, i) => {
      if (Math.abs(Math.log(s / natural)) < Math.abs(Math.log(SPEEDS[best] / natural))) best = i;
    });
    return best;
  }

  function speedLabel(index) {
    return `${SPEEDS[index]}×`;
  }

  function speedTitle(index) {
    const s = SPEEDS[index];
    if (s > 3.05) return `${s} times this voice's normal speed (faster than any Windows voice)`;
    return `${s} times this voice's normal speed (about ${windowsLabel(windowsIndexFor(s))} with a Windows voice)`;
  }

  // ---------- SSML and billing ----------

  const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function rateAttr(prosody) {
    return String(Math.round(prosody * 100) / 100);
  }

  function buildSsml(text, voice, prosody = 1) {
    let inner = escapeXml(text);
    if (Math.abs(prosody - 1) > 0.005) inner = `<prosody rate="${rateAttr(prosody)}">${inner}</prosody>`;
    const lang = voice.Locale || 'en-US';
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
      `<voice name="${escapeXml(voice.ShortName)}">${inner}</voice></speak>`;
    return { ssml, billable: billableChars(ssml) };
  }

  // Azure bills every character of the SSML except the <speak> and <voice> tags, markup and
  // whitespace included, one per Unicode code point, and two for each Chinese character
  // (including Japanese kanji and Korean hanja).
  function billableChars(ssml) {
    const body = ssml.replace(/<\/?(speak|voice)\b[^>]*>/g, '');
    let n = 0;
    for (const ch of body) n += /\p{Script=Han}/u.test(ch) ? 2 : 1;
    return n;
  }

  // ---------- monthly usage ----------
  // Counted per UTC calendar month, in chrome.storage.local, as { month: 'YYYY-MM', chars, warned }.

  function monthKey(now = new Date()) {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function usageNow(usage, now = new Date()) {
    const month = monthKey(now);
    return usage && usage.month === month ? usage : { month, chars: 0, warned: false };
  }

  // Returns the new record and whether to show the 80% warning (once per month).
  function addUsage(usage, chars, now = new Date()) {
    const u = { ...usageNow(usage, now) };
    u.chars += chars;
    let warn = false;
    if (!u.warned && u.chars >= FREE_CHARS * WARN_AT) {
      u.warned = true;
      warn = true;
    }
    return { usage: u, warn };
  }

  function formatUsage(usage, now = new Date()) {
    const u = usageNow(usage, now);
    const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
    return `Used ${k(u.chars)} of 500k characters this month (${Math.round((u.chars / FREE_CHARS) * 100)}%).`;
  }

  // ---------- errors ----------

  class AzureError extends Error {
    // kind: 'auth' (key rejected), 'quota' (quota used up or throttled), 'network', 'other'
    constructor(kind, status, message) {
      super(message || `Azure ${kind} error${status ? ` (HTTP ${status})` : ''}`);
      this.kind = kind;
      this.status = status;
    }
  }

  function errorFromStatus(status, body = '') {
    if (status === 429) return new AzureError('quota', status);
    if (status === 403 && /quota|limit/i.test(body)) return new AzureError('quota', status);
    if (status === 401 || status === 403) return new AzureError('auth', status);
    return new AzureError('other', status);
  }

  function noticeFor(err, fallbackName) {
    const to = fallbackName ? `Switched to ${fallbackName}` : 'Switched to a local voice';
    if (err.kind === 'quota') {
      return `Azure refused the request (HTTP ${err.status}): the free monthly quota looks used up, or Azure is throttling. ${to}.`;
    }
    if (err.kind === 'auth') return `Azure rejected the key (HTTP ${err.status}). Check the key and region in settings. ${to}.`;
    if (err.kind === 'network') return `Could not reach Azure. ${to}.`;
    return `Azure error${err.status ? ` (HTTP ${err.status})` : ''}. ${to}.`;
  }

  // ---------- fallback voice ----------

  const MALE = /\b(David|Mark|George|Richard|James|Ravi|Sean|Guy|Paul|Pablo|Raul|Stefan|Ichiro|Kangkang|Danny|Andrei|Pavel|Claude|Bart)\b/i;
  const FEMALE = /\b(Zira|Hazel|Susan|Catherine|Linda|Heera|Helena|Laura|Sabina|Hortense|Julie|Katja|Hedda|Elsa|Ayumi|Haruka|Huihui|Yaoyao|Heami|Irina|Maria|Hanhan|Tracy|Elena|Paulina|Zuzana)\b/i;
  const PREFERRED = ['David', 'Zira', 'Mark'];

  // Pick the local voice that best matches an Azure voice by locale and gender.
  // `voices` are SpeechSynthesisVoice-like objects ({ name, lang, localService }).
  function pickFallbackVoice(azureVoice, voices) {
    const local = voices.filter((v) => v.localService);
    const pool = local.length ? local : voices;
    if (!pool.length) return null;
    const locale = String((azureVoice && azureVoice.Locale) || 'en-US').toLowerCase();
    const lang = locale.split('-')[0];
    const gender = String((azureVoice && azureVoice.Gender) || '').toLowerCase();
    const genderRe = gender === 'male' ? MALE : gender === 'female' ? FEMALE : null;
    const score = (v) => {
      const vl = String(v.lang || '').toLowerCase().replace('_', '-');
      let s = 0;
      if (vl === locale) s += 4;
      else if (vl.split('-')[0] === lang) s += 2;
      if (genderRe && genderRe.test(v.name)) s += 3;
      return s;
    };
    const pref = (v) => {
      const i = PREFERRED.findIndex((p) => v.name.includes(p));
      return i === -1 ? PREFERRED.length : i;
    };
    return pool.slice().sort((a, b) => score(b) - score(a) || pref(a) - pref(b))[0];
  }

  // ---------- voice list ----------

  // Standard neural voices only (HD voices, with ':' in the name, don't support every SSML tag).
  // English first, then by locale and name.
  function normalizeVoices(list) {
    return list
      .filter((v) => v && v.ShortName && (!v.VoiceType || v.VoiceType === 'Neural') && !v.ShortName.includes(':'))
      .map((v) => ({
        ShortName: v.ShortName,
        DisplayName: v.DisplayName || v.LocalName || v.ShortName,
        Locale: v.Locale,
        LocaleName: v.LocaleName || v.Locale,
        Gender: v.Gender,
      }))
      .sort((a, b) => {
        const ea = /^en-/i.test(a.Locale) ? 0 : 1;
        const eb = /^en-/i.test(b.Locale) ? 0 : 1;
        return ea - eb || a.Locale.localeCompare(b.Locale) || a.DisplayName.localeCompare(b.DisplayName);
      });
  }

  // ---------- client ----------
  // synthesize(ssml) resolves to { audio: ArrayBuffer, type, words, via } where words is
  // [{ t: seconds into the audio, text }] from the Speech SDK, or null from the REST endpoint.
  // It tries the SDK first (for word timings). If that fails for any reason, it sends the same
  // request over REST: a browser WebSocket can't see the HTTP status of a refused handshake, and
  // REST tells 401/403/429 apart. Nothing is billed for a request that failed, so the retry
  // doesn't double-count.

  const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
  const SDK_TIMEOUT_MS = 20000;

  function createClient({ key, region, fetch: fetchImpl, sdk } = {}) {
    const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    const getSdk = sdk || (() => globalThis.SpeechSDK);
    const base = `https://${region}.tts.speech.microsoft.com/cognitiveservices`;
    let synth = null;
    let current = null; // { words } of the SDK request in flight
    let chain = Promise.resolve();
    let sdkStrikes = 0; // consecutive SDK failures that REST then served; after 2, use REST only

    async function listVoices() {
      let res;
      try {
        res = await doFetch(`${base}/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': key } });
      } catch (e) {
        throw new AzureError('network', 0, String((e && e.message) || e));
      }
      if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
      return normalizeVoices(await res.json());
    }

    async function synthesizeRest(ssml) {
      let res;
      try {
        res = await doFetch(`${base}/v1`, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
          },
          body: ssml,
        });
      } catch (e) {
        throw new AzureError('network', 0, String((e && e.message) || e));
      }
      if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
      return { audio: await res.arrayBuffer(), type: res.headers.get('content-type') || 'audio/mpeg', words: null, via: 'rest' };
    }

    function closeSynth() {
      if (synth) {
        try { synth.close(); } catch { /* already closed */ }
      }
      synth = null;
    }

    function openSynth(S) {
      const cfg = S.SpeechConfig.fromSubscription(key, region);
      cfg.speechSynthesisOutputFormat = S.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
      const s = new S.SpeechSynthesizer(cfg, null); // null audio config: return the audio, don't play it
      s.wordBoundary = (_sender, e) => {
        if (!current) return;
        const type = e.boundaryType;
        if (type && S.SpeechSynthesisBoundaryType && type !== S.SpeechSynthesisBoundaryType.Word) return;
        current.words.push({ t: e.audioOffset / 1e7, text: e.text });
      };
      return s;
    }

    function synthesizeSdk(ssml) {
      const S = getSdk();
      if (!S) return Promise.reject(new AzureError('other', 0, 'Speech SDK not loaded'));
      return new Promise((resolve, reject) => {
        if (!synth) synth = openSynth(S);
        const job = { words: [] };
        current = job;
        const timer = setTimeout(() => {
          current = null;
          closeSynth();
          reject(new AzureError('network', 0, 'SDK: timed out'));
        }, SDK_TIMEOUT_MS);
        synth.speakSsmlAsync(
          ssml,
          (result) => {
            clearTimeout(timer);
            current = null;
            if (result.reason === S.ResultReason.SynthesizingAudioCompleted) {
              resolve({ audio: result.audioData, type: 'audio/mpeg', words: job.words, via: 'sdk' });
            } else {
              const c = S.CancellationDetails.fromResult(result);
              closeSynth();
              reject(new AzureError('other', 0, `SDK: ${c.errorDetails || c.reason}`));
            }
          },
          (err) => {
            clearTimeout(timer);
            current = null;
            closeSynth();
            reject(new AzureError('network', 0, `SDK: ${err}`));
          },
        );
      });
    }

    async function synthesizeOnce(ssml) {
      if (sdkStrikes < 2 && getSdk()) {
        try {
          const r = await synthesizeSdk(ssml);
          sdkStrikes = 0;
          return r;
        } catch {
          // fall through to REST, which gives a real HTTP status
        }
        const r = await synthesizeRest(ssml);
        sdkStrikes++;
        return r;
      }
      return synthesizeRest(ssml);
    }

    // One request at a time: the SDK serializes on one connection anyway, and word-boundary
    // events carry no request id, so they belong to whichever request is in flight.
    function synthesize(ssml) {
      const p = chain.then(() => synthesizeOnce(ssml));
      chain = p.catch(() => {});
      return p;
    }

    return { listVoices, synthesize, close: closeSynth, get usingSdk() { return sdkStrikes < 2 && !!getSdk(); } };
  }

  // ---------- prefetch cache ----------
  // Holds chunk entries by key so the next chunks are synthesized while the current one plays.
  // `make` returns a promise or an object with a `job` promise.

  class Prefetcher {
    constructor() {
      this.jobs = new Map();
    }

    get(key, make) {
      if (!this.jobs.has(key)) {
        const v = make();
        const p = v && typeof v.then === 'function' ? v : v && v.job;
        if (p) p.catch(() => {}); // the caller handles failures when it awaits this chunk
        this.jobs.set(key, v);
      }
      return this.jobs.get(key);
    }

    has(key) {
      return this.jobs.has(key);
    }

    drop(key) {
      this.jobs.delete(key);
    }

    keepOnly(keys) {
      for (const k of [...this.jobs.keys()]) if (!keys.includes(k)) this.jobs.delete(k);
    }

    clear() {
      this.jobs.clear();
    }

    get size() {
      return this.jobs.size;
    }
  }

  // Map SDK word boundaries to positions in the plain chunk text, scanning forward so repeated
  // words land on the right occurrence. Returns [{ t, index, length }].
  function alignWords(words, text) {
    const out = [];
    let pos = 0;
    for (const w of words || []) {
      const word = String(w.text || '').trim();
      if (!word) continue;
      const at = text.indexOf(word, pos);
      if (at === -1 || at - pos > 80) continue;
      out.push({ t: w.t, index: at, length: word.length });
      pos = at + word.length;
    }
    return out;
  }

  globalThis.FastReadAzure = {
    FREE_CHARS, WARN_AT, SPEEDS, DEFAULT_SPEED, MAX_PROSODY,
    speedParts, speedLabel, speedTitle, windowsNatural, windowsLabel, windowsIndexFor, azureIndexFor,
    escapeXml, buildSsml, billableChars,
    monthKey, usageNow, addUsage, formatUsage,
    AzureError, errorFromStatus, noticeFor,
    pickFallbackVoice, normalizeVoices, createClient, Prefetcher, alignWords,
  };
})();
