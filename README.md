# FastRead

Chrome extension that reads web pages aloud in the side panel, like Reading mode's read aloud, with speeds past Reading mode's 2× cap.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (`C:\dev\fastread`).
3. Pin FastRead from the puzzle-piece menu. Do this once in each Chrome profile you want it in.

After editing files, click the reload icon on FastRead's card in `chrome://extensions`.

## Use

- Click the toolbar icon (or **Alt+Shift+R**) to open the panel; it grabs the current page's article text.
- **Play/pause:** Space in the panel, or **Alt+Shift+P** anywhere.
- **Read a selection:** select text, then **Alt+Shift+S** or right-click → *Read selection with FastRead*.
- **Start somewhere else:** click any sentence in the panel, or use the target button and click a paragraph on the page (↑/↓ widen/narrow, Esc cancels). If the article grab missed that part of the page, it reads what you picked instead.
- **Wrong text grabbed?** Re-grab button (circular arrow), or use the target button.
- **Speed:** slider or −/+ (also `-` and `=` keys). Optional global speed shortcuts can be set at `chrome://extensions/shortcuts`.
- **Voice, text size, theme:** gear button.

## Speed

Speeds use Chrome's Reading mode scale, so 2× here sounds the same as 2× there.

With Windows voices (Microsoft David, Zira, Mark), Chrome converts the speed to one of the voice engine's integer steps, `trunc(10 × log10(speed))`, which tops out at +10, about 3× normal talking speed. Values between steps sound identical, so the slider offers exactly one value per step: 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6.3, 7.9, 10.

Measured with Microsoft David on one sentence: 2× took 4.46 s and 10× took 2.12 s. So 10× is about 2.1 times faster than Reading mode's 2×.

Google's online voices may not speed up past 2×.

## How text is grabbed

1. [Defuddle](https://github.com/kepano/defuddle) (MIT), the extractor behind Obsidian Web Clipper.
2. If that result is short or mostly links: [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0), the engine behind Firefox Reader View.
3. If both fail: a density scan for the page element holding the most paragraph text.

The panel footer shows which method was used.

## Tests

The test scripts need `playwright-core` in `.vendor-src` (`npm i playwright-core` there) and a Playwright Chromium build.

- `node test/extract-test.mjs [url ...]`: prints what gets extracted from each page.
- `node test/panel-test.mjs`: loads the extension and times speech at several speeds (plays audio).
- `node test/e2e-test.mjs [url]`: plays an article at top speed and checks the highlight advances (plays audio).
