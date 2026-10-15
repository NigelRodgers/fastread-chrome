// Injected after content/extract.js. Lets the user click a paragraph on the page;
// sends { type: 'fastread-picked', blocks, sample } to the side panel.

(() => {
  if (window.__fastreadPicker) return;
  window.__fastreadPicker = true;

  const box = document.createElement('div');
  const hint = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #3b6cf6;' +
    'background:rgba(59,108,246,.10);border-radius:4px;transition:all .05s;display:none';
  hint.style.cssText =
    'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);' +
    'background:#1d2433;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;' +
    'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none';
  hint.textContent = 'FastRead: click where to start reading  ·  ↑ widen  ·  ↓ narrow  ·  Esc cancel';
  document.documentElement.append(box, hint);

  let target = null;
  const trail = []; // elements we widened from, for ↓

  function show(el) {
    target = el;
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`,
    });
  }

  function onMove(e) {
    if (e.target === box || e.target === hint) return;
    trail.length = 0;
    show(e.target);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      done(null);
    } else if (e.key === 'ArrowUp' && target && target.parentElement && target !== document.body) {
      trail.push(target);
      show(target.parentElement);
    } else if (e.key === 'ArrowDown' && trail.length) {
      show(trail.pop());
    } else if (e.key === 'Enter' && target) {
      done(target);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    done(target || e.target);
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function done(el) {
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('mousedown', swallow, true);
    removeEventListener('mouseup', swallow, true);
    removeEventListener('keydown', onKey, true);
    box.remove();
    hint.remove();
    window.__fastreadPicker = false;
    if (!el) {
      chrome.runtime.sendMessage({ type: 'fastread-picked', cancelled: true });
      return;
    }
    const blocks = window.__fastread.blocksFrom(el, { live: false });
    const sample = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    chrome.runtime.sendMessage({
      type: 'fastread-picked',
      url: location.href,
      title: document.title,
      blocks,
      sample,
    });
  }

  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('mousedown', swallow, true);
  addEventListener('mouseup', swallow, true);
  addEventListener('keydown', onKey, true);
})();
