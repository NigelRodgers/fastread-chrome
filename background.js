// FastRead service worker: opens the side panel and routes commands to it.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'fastread-selection',
      title: 'Read selection with FastRead',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'fastread-page',
      title: 'Read page with FastRead',
      contexts: ['page'],
    });
  });
});

// Open panels, keyed by window id. Panels connect a port named "panel:<windowId>".
const panels = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('panel:')) return;
  const windowId = Number(port.name.slice(6));
  panels.set(windowId, port);
  port.onDisconnect.addListener(() => {
    if (panels.get(windowId) === port) panels.delete(windowId);
  });
});

// Deliver a message to the panel in `windowId`, opening the panel first if needed.
// sidePanel.open must run synchronously inside the user gesture, so call it before any await.
function deliver(windowId, msg) {
  const port = panels.get(windowId);
  if (port) {
    port.postMessage(msg);
    return;
  }
  chrome.sidePanel.open({ windowId }).catch(() => {});
  chrome.storage.session.set({ [`pending:${windowId}`]: { ...msg, at: Date.now() } });
}

async function selectionText(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => String(getSelection() || ''),
    });
    return (res && res.result) || '';
  } catch {
    return '';
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'fastread-selection') {
    deliver(tab.windowId, { type: 'selection', tabId: tab.id, text: info.selectionText || '' });
  } else if (info.menuItemId === 'fastread-page') {
    deliver(tab.windowId, { type: 'page', tabId: tab.id, autoplay: true });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) return;
  const windowId = tab.windowId;
  if (command === 'read-selection') {
    const port = panels.get(windowId);
    if (!port) chrome.sidePanel.open({ windowId }).catch(() => {});
    // The panel prefers the rich (block-structured) selection it extracts itself;
    // the plain text is a fallback for pages where that fails.
    const text = await selectionText(tab.id);
    const msg = { type: 'selection', tabId: tab.id, text };
    if (port) port.postMessage(msg);
    else chrome.storage.session.set({ [`pending:${windowId}`]: { ...msg, at: Date.now() } });
  } else if (command === 'toggle-play') {
    deliver(windowId, panels.has(windowId) ? { type: 'toggle' } : { type: 'page', tabId: tab.id, autoplay: true });
  } else if (command === 'faster' || command === 'slower') {
    const port = panels.get(windowId);
    if (port) port.postMessage({ type: command });
  }
});
