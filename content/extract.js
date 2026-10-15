// Injected into the page (isolated world) after lib/Readability.js and lib/defuddle.js.
// Exposes window.__fastread with extract(), selection() and blocksFrom().
// A block is { tag: 'P' | 'H' | 'LI' | 'Q' | 'PRE', text }.

(() => {
  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'IMG', 'VIDEO', 'AUDIO', 'PICTURE', 'SOURCE', 'OBJECT', 'EMBED', 'MATH',
    'DIALOG',
  ]);
  // Structural chrome we drop when walking the live page (extractor output is already clean).
  const LIVE_SKIP = new Set(['NAV', 'ASIDE', 'FOOTER', 'FORM']);

  const MIN_CHARS = 500;
  const MAX_LINK_DENSITY = 0.5;

  function isHidden(el) {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function blockTag(name, inherited) {
    if (/^H[1-6]$/.test(name)) return 'H';
    if (name === 'LI' || name === 'DT' || name === 'DD') return 'LI';
    if (name === 'BLOCKQUOTE') return 'Q';
    if (name === 'PRE') return 'PRE';
    return inherited;
  }

  // Flatten a DOM subtree into text blocks. `live` = walking the real page (check visibility,
  // skip nav/aside/footer) rather than extractor output.
  function blocksFrom(root, { live = false } = {}) {
    const blocks = [];
    let buf = '';
    let bufTag = 'P';
    let afterBr = false; // two <br>s in a row = paragraph break (common on hand-written sites)
    const flush = () => {
      const text = buf.replace(/\s+/g, ' ').replace(/\s*↩\s*/g, ' ').trim();
      if (text) blocks.push({ tag: bufTag, text });
      buf = '';
      afterBr = false;
    };
    const walk = (node, tag) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (!buf.trim()) bufTag = tag;
          buf += child.nodeValue;
          if (child.nodeValue.trim()) afterBr = false;
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const name = child.tagName.toUpperCase();
        if (SKIP.has(name)) continue;
        if (child.getAttribute('aria-hidden') === 'true' || child.hidden) continue;
        if (live && (LIVE_SKIP.has(name) || isHidden(child))) continue;
        if (name === 'BR') {
          if (afterBr) flush();
          else {
            buf += ' ';
            afterBr = true;
          }
          continue;
        }
        if (BLOCK.has(name)) {
          flush();
          walk(child, blockTag(name, tag));
          flush();
        } else {
          walk(child, tag);
        }
      }
    };
    walk(root, 'P');
    flush();
    return blocks;
  }

  function linkDensity(root) {
    const total = (root.textContent || '').replace(/\s+/g, '').length;
    if (!total) return 1;
    let links = 0;
    for (const a of root.querySelectorAll('a')) links += (a.textContent || '').replace(/\s+/g, '').length;
    return links / total;
  }

  function fromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let blocks = blocksFrom(doc.body);
    // Some extractor results come back as plain text with one paragraph per line.
    const text = doc.body.textContent || '';
    if (blocks.length < 3 && (text.match(/\n/g) || []).length >= 3) {
      blocks = text.split(/\n+/)
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter((t) => t && !/^\[(Image|Video|Embed)[^\]]*\]$/i.test(t))
        .map((t) => ({ tag: 'P', text: t }));
    }
    return { blocks, linkDensity: linkDensity(doc.body) };
  }

  const charCount = (blocks) => blocks.reduce((n, b) => n + b.text.length, 0);

  function tryDefuddle() {
    const D = window.Defuddle && (window.Defuddle.default || window.Defuddle);
    if (!D) throw new Error('Defuddle not loaded');
    const res = new D(document, { url: location.href }).parse();
    return { title: res.title, ...fromHtml(res.content || '') };
  }

  function tryReadability() {
    if (!window.Readability) throw new Error('Readability not loaded');
    const res = new window.Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
    if (!res) throw new Error('no result');
    return { title: res.title, ...fromHtml(res.content || '') };
  }

  // Last resort: score containers by the paragraph text they hold (Readability-lite on the live page).
  function tryDensest() {
    const scores = new Map();
    for (const p of document.querySelectorAll('p, pre, blockquote, li')) {
      const len = (p.textContent || '').trim().length;
      if (len < 40 || isHidden(p)) continue;
      const parent = p.parentElement;
      if (!parent) continue;
      scores.set(parent, (scores.get(parent) || 0) + len);
      const grand = parent.parentElement;
      if (grand) scores.set(grand, (scores.get(grand) || 0) + len / 2);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    const root = best || document.querySelector('article, main, [role="main"]') || document.body;
    return { title: document.title, blocks: blocksFrom(root, { live: true }), linkDensity: linkDensity(root) };
  }

  function extract() {
    const attempts = [];
    for (const [method, fn] of [['defuddle', tryDefuddle], ['readability', tryReadability]]) {
      try {
        const r = fn();
        r.method = method;
        r.chars = charCount(r.blocks);
        attempts.push(r);
        if (r.chars >= MIN_CHARS && r.linkDensity < MAX_LINK_DENSITY) return finish(r, attempts);
      } catch (e) {
        attempts.push({ method, error: String(e && e.message || e), chars: 0, blocks: [] });
      }
    }
    // Neither extractor produced a convincing article. Short pages are legit, so prefer the
    // longest clean extractor result if it has some substance; otherwise use the density scan.
    const clean = attempts.filter((a) => !a.error && a.chars >= 150 && a.linkDensity < MAX_LINK_DENSITY);
    clean.sort((a, b) => b.chars - a.chars);
    if (clean.length) return finish(clean[0], attempts);
    const d = tryDensest();
    d.method = 'density';
    d.chars = charCount(d.blocks);
    attempts.push(d);
    return finish(d, attempts);
  }

  function finish(r, attempts) {
    const title = (r.title || document.title || '').trim();
    // Drop repeats (e.g. an image caption rendered twice).
    const blocks = r.blocks.filter((b, i, all) => !(i && b.text === all[i - 1].text));
    if (title && !(blocks[0] && blocks[0].tag === 'H' && blocks[0].text === title)) {
      // Extractors often keep the title inside the content too; don't read it twice.
      const dup = blocks.findIndex((b, i) => i < 3 && b.text === title);
      if (dup !== -1) blocks.splice(dup, 1);
      blocks.unshift({ tag: 'H', text: title, title: true });
    }
    return {
      url: location.href,
      title,
      method: r.method,
      blocks,
      attempts: attempts.map((a) => ({ method: a.method, chars: a.chars, error: a.error })),
    };
  }

  function selection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const blocks = [];
    for (let i = 0; i < sel.rangeCount; i++) blocks.push(...blocksFrom(sel.getRangeAt(i).cloneContents()));
    if (!blocks.length) {
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ tag: 'P', text });
    }
    return blocks.length ? { url: location.href, title: document.title, method: 'selection', blocks } : null;
  }

  window.__fastread = { extract, selection, blocksFrom };
})();
