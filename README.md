# FastRead

A Chrome extension that reads web pages aloud in the side panel, like Chrome's Reading mode, but without Reading mode's 2× speed cap. It works with the voices already on your computer, and optionally with Azure neural voices (the same voices Microsoft Edge reads with) using your own free Azure key.

![FastRead icon](icons/icon128.png)

## Why

Chrome's Reading mode tops out at 2× on Windows, Mac and Linux. The cap is in Chrome's source: the speed menu ([`rate_menu.ts`](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/resources/side_panel/read_anything/menus/rate_menu.ts)) only offers 3× and 4× inside an `<if expr="is_chromeos">` block, with a comment that natural voices on other platforms don't support them. Raising the saved speed in the profile's `Preferences` file doesn't help either; Chrome keeps the value but still plays at 2×.

The speech API that extensions get (`speechSynthesis`) has no such cap. FastRead uses it in a side panel of its own, with article extraction, sentence and word highlighting, and click-to-start.

## Install (unpacked)

FastRead is distributed on GitHub only, not on the Chrome Web Store.

1. Download this repository (green **Code** button → **Download ZIP**, then unzip), or `git clone https://github.com/NigelRodgers/fastread-chrome.git`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder that holds `manifest.json`.
4. Pin FastRead from the puzzle-piece menu. Do this once in each Chrome profile you want it in.

To update, replace the folder's files (or `git pull`) and click the reload icon on FastRead's card in `chrome://extensions`.

## Use

- Click the toolbar icon (or **Alt+Shift+R**) to open the panel; it grabs the current page's article text.
- **Play/pause:** Space in the panel, or **Alt+Shift+P** anywhere.
- **Read a selection:** select text, then **Alt+Shift+S** or right-click → *Read selection with FastRead*.
- **Start somewhere else:** click any sentence in the panel, or use the target button and click a paragraph on the page (↑/↓ widen/narrow, Esc cancels). If the article grab missed that part of the page, it reads what you picked instead.
- **Wrong text grabbed?** Re-grab button (circular arrow), or use the target button.
- **Speed:** slider or −/+ (also `-` and `=` keys). Optional global speed shortcuts can be set at `chrome://extensions/shortcuts`.
- **Voice, text size, theme, Azure key:** gear button.

## Speed

### Windows voices (Microsoft David, Zira, Mark)

The slider uses Chrome's Reading mode scale, so 2× here sounds the same as 2× there.

For Windows (SAPI) voices, Chrome converts the speed to one of the voice engine's integer steps, `trunc(10 × log10(speed))`, from −10 to +10. Step +10 is about 3× normal talking speed. Speeds between two steps sound identical, so the slider offers exactly one value per step: 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6.3, 7.9, 10.

Measured with Microsoft David reading one sentence:

| Speed asked for | SAPI step | Time | vs. 1× |
|---|---|---|---|
| 1× | 0 | 6.40 s | 1.0 |
| 2× (Reading mode's cap) | +3 | 4.46 s | 1.4 |
| 3× | +4 | 3.98 s | 1.6 |
| 4× | +6 | 3.21 s | 2.0 |
| 5× | +6 | 3.21 s | 2.0 |
| 6× | +7 | 2.87 s | 2.2 |
| 8× | +9 | 2.34 s | 2.7 |
| 10× | +10 | 2.12 s | 3.0 |

So FastRead's 10× is about 2.1 times faster than Reading mode's 2×. Google's online voices may not speed up past 2×.

### Azure neural voices

Azure speeds are multiples of the voice's own normal pace, which is how Chrome's scale works for natural (non-Windows) voices. Azure's SSML `<prosody rate>` accepts 0.5 to 2, so FastRead uses prosody up to 2× and speeds the audio up beyond that with the audio element's `playbackRate`, pitch preserved.

| Slider | SSML prosody | playbackRate | Compared with Windows voices |
|---|---|---|---|
| 0.5× – 2× | same as slider | 1 | 2× ≈ Windows 4× |
| 2.5× | 2 | 1.25 | ≈ Windows 6.3× |
| 3× | 2 | 1.5 | ≈ Windows 10× (their maximum) |
| 3.5×, 4×, 5×, 6× | 2 | 1.75 – 3 | faster than any Windows voice |

Changing speed above 2× doesn't re-request audio, so it costs no extra characters. When you switch between a Windows voice and an Azure voice, FastRead keeps the perceived speed.

## Azure neural voices (optional)

Azure's free tier (F0) includes 500,000 neural-voice characters a month. A long book is about that much, so it suits articles more than whole books.

### Get a free key

1. Sign in to the [Azure portal](https://portal.azure.com) (a free Azure account works).
2. **Create a resource** → search for **Speech** → **Create**.
3. Pick a subscription, a resource group, a region (for example *East US*) and a name. Set **Pricing tier** to **Free F0**. **Review + create** → **Create**.
4. Open the resource → **Keys and Endpoint**. Copy **KEY 1** and note the **Location/Region** (for example `eastus`).
5. In FastRead: gear button → **Azure neural voices** → paste the key, enter the region, **Save and load voices**. Then pick an Azure voice in the **Voice** list.

If **Free F0** isn't offered, the subscription most likely already has a free Speech resource; use that one's key.

### How it works

- Uses the [Speech SDK for JavaScript](https://github.com/microsoft/cognitive-services-speech-sdk-js) (bundled, MIT) for audio plus word timings, so word highlighting works. If the SDK's connection fails, FastRead repeats the request over the REST API, which also reports why it failed.
- The next two chunks are synthesized while the current one plays, so there are no gaps.
- **Usage meter:** FastRead counts the characters it sends each calendar month (UTC) the way Azure bills them: all SSML except the `<speak>` and `<voice>` tags, Chinese characters counted twice. Settings shows "Used X of 500k". At 80% it shows a warning once a month. The meter only counts this browser; the Azure portal (resource → **Metrics** → *Synthesized Characters*) has the real total.
- **When Azure refuses** (HTTP 401/403 for a bad key, 429 or a quota error when the free characters are used up, or no connection), FastRead switches to the matching Windows voice (David, Zira or Mark, by gender and locale), shows a notice and keeps reading. **Try Azure again** in the notice, or picking an Azure voice again, switches back.

### Privacy

- The key is stored only in this browser, in `chrome.storage.local`. It isn't synced and is sent only to Azure's speech endpoint for the region you entered. **Remove key** deletes it.
- Page text goes to Microsoft Azure only while an Azure voice is selected. With a Windows voice, everything stays on your computer. (Chrome's own online voices, marked "online" in the list, are processed by Google.)
- FastRead has no server, analytics or tracking.

## How text is grabbed

1. [Defuddle](https://github.com/kepano/defuddle) (MIT), the extractor behind Obsidian Web Clipper.
2. If that result is short or mostly links: [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0), the engine behind Firefox Reader View.
3. If both fail: a density scan for the page element holding the most paragraph text.

Two blank-line conventions are handled: a double `<br>` counts as a paragraph break, and plain-text results are split per line. The panel footer shows which method was used.

## Tests

The scripts need `playwright-core` and a Playwright Chromium build in `.vendor-src` (git-ignored):

```bash
cd .vendor-src && npm i playwright-core && npx playwright-core install chromium
```

- `node test/azure-unit-test.mjs`: unit tests for the Azure logic (speed scale, SSML billing count, usage meter, error handling, fallback voice choice, client, queue). No network.
- `node test/azure-e2e-test.mjs`: loads the extension against a mock Azure (no key, no Azure traffic) and checks settings, queueing, gaps between chunks, speed, the usage warning, and the fallback on 429 and 401. Briefly plays a Windows voice.
- `node test/extract-test.mjs [url ...]`: prints what gets extracted from each page.
- `node test/panel-test.mjs`: times speech at several speeds (plays audio).
- `node test/e2e-test.mjs [url]`: plays an article at top speed and checks the highlight advances (plays audio).

The scripts look for Chromium at `%LOCALAPPDATA%\ms-playwright\chromium-1228`; set `CHROME_PATH` to use another build.

## Credits and licenses

FastRead is MIT licensed; see [LICENSE](LICENSE). It bundles:

- [Defuddle](https://github.com/kepano/defuddle) by Steph Ango, MIT ([lib/LICENSE-defuddle.txt](lib/LICENSE-defuddle.txt)).
- [Mozilla Readability](https://github.com/mozilla/readability), Apache-2.0 ([lib/LICENSE-readability.txt](lib/LICENSE-readability.txt)).
- [Microsoft Cognitive Services Speech SDK for JavaScript](https://github.com/microsoft/cognitive-services-speech-sdk-js) 1.52.0, MIT ([lib/LICENSE-speech-sdk.txt](lib/LICENSE-speech-sdk.txt)).

Azure is a trademark of Microsoft. FastRead is not affiliated with Google or Microsoft.
