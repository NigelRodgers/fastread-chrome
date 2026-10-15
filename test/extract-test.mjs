// Runs content/extract.js against live pages in headless Chromium and prints what it grabbed.
// Usage: node test/extract-test.mjs [url ...]   (default: built-in list)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(root, '.vendor-src/node_modules/playwright-core'));

const exe = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe');

const src = (f) => readFileSync(path.join(root, f), 'utf8');
// Shadow define/module/exports so the UMD bundles attach to window, like in the extension's isolated world.
const LIB_CODE = `(function(){ var define, module, exports;
${src('lib/Readability.js')}
window.Readability = Readability; }).call(window);
(function(){ var define, module, exports;
${src('lib/defuddle.js')}
}).call(window);
${src('content/extract.js')}`;

const DEFAULT_URLS = [
  'https://en.wikipedia.org/wiki/Speech_synthesis',
  'https://www.theguardian.com/technology',
  'https://www.bbc.com/news',
  'https://arstechnica.com/',
  'https://www.theverge.com/',
  'https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis',
  'https://paulgraham.com/greatwork.html',
  'https://medium.com/',
  'https://dev.to/',
  'https://www.nytimes.com/',
  'https://substack.com/',
  'https://simonwillison.net/',
  'https://news.ycombinator.com/',
  'https://www.reuters.com/',
  'https://www.cnn.com/',
];

const urls = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});

// Index pages are not articles; follow the first article-looking link so we test real articles.
async function firstArticle(page) {
  return page.evaluate(() => {
    const here = location.hostname;
    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => ({ href: a.href, text: (a.textContent || '').trim() }))
      .filter((l) => {
        try {
          const u = new URL(l.href);
          return u.hostname.endsWith(here.replace(/^www\./, '')) && u.pathname.split('/').filter(Boolean).length >= 2 &&
            l.text.length > 30 && !/login|signin|subscribe|account|video|live|podcast/i.test(u.pathname);
        } catch { return false; }
      });
    return links[0] && links[0].href;
  });
}

async function run(url, follow) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    if (follow) {
      const art = await firstArticle(page);
      if (art && art !== url) {
        await page.goto(art, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
      }
    }
    await page.evaluate(LIB_CODE);
    const r = await page.evaluate(() => window.__fastread.extract());
    const words = r.blocks.reduce((n, b) => n + b.text.split(/\s+/).length, 0);
    const blocks = r.blocks.filter((b) => !b.title);
    console.log(`\n=== ${page.url()}`);
    console.log(`method=${r.method} words=${words} blocks=${r.blocks.length} attempts=${JSON.stringify(r.attempts)}`);
    console.log(`title: ${r.title}`);
    for (const b of blocks.slice(0, 3)) console.log(`  [${b.tag}] ${b.text.slice(0, 140)}`);
    console.log('  ...');
    for (const b of blocks.slice(-2)) console.log(`  [${b.tag}] ${b.text.slice(0, 140)}`);
  } catch (e) {
    console.log(`\n=== ${url}\nERROR ${String(e.message).split('\n')[0]}`);
  } finally {
    await page.close();
  }
}

for (const u of urls.length ? urls : DEFAULT_URLS) {
  const isIndex = !urls.length && new URL(u).pathname.split('/').filter(Boolean).length < 2 && !/paulgraham|wikipedia/.test(u);
  await run(u, isIndex);
}
await browser.close();
