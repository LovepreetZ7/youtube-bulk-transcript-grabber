# Architecture notes

Technical reference for Bulk Transcript Grabber. For an overview, see the main [README](../README.md).

## Components

| Component | File(s) | Runs in | Responsibility |
|---|---|---|---|
| Popup | `popup.html`, `popup.js`, `popup.css` | Extension popup | Scans the current YouTube page, lets the user select videos and options, starts/stops/resumes batches, shows live progress |
| Page scanner | `page/scan.js` | YouTube tab (isolated world) | Finds video links, titles and page details; scrolls the page to load more videos |
| Job runner | `background.js` | Service worker | Owns the batch: queue, per-video retrieval, fallback, retries, delays, persistence, keep-alive, opening the results page |
| Fast method | `page/fast.js` | YouTube tab (main world) or service worker | Requests player data, chooses a caption track, downloads and parses captions |
| Tab method | `page/scrape.js` | Worker tab (isolated world) | Opens YouTube's transcript panel and reads its lines |
| Results page | `result.html`, `result.js`, `result.css` | Extension tab | Formats text, preview, download, copy, failed-video list |
| Shared styles | `ui.css` | Popup and results page | Colour tokens, light/dark theme, buttons |

Scripts in `page/` are injected only when needed with `chrome.scripting.executeScript`. None of them are declared as permanent content scripts, so nothing runs on YouTube pages unless the user opens the popup or starts a batch. Each injected script guards against being loaded twice (`if (ns.scan) return;`).

`fast.js` is written to be fully self-contained so the same file can be injected into the page **and** loaded into the service worker with `importScripts`.

## Messages (popup / results page → service worker)

Sent with `chrome.runtime.sendMessage({ type, ... })`. Every reply has the shape `{ ok: true, ... }` or `{ ok: false, error }`.

| `type` | Payload | Result |
|---|---|---|
| `status` | – | `{ job, alive }` – the stored job and whether it is actively running in this worker |
| `start` | `{ payload: { tabId, page, videos, settings } }` | Creates a new job, clears old transcripts, starts the runner |
| `stop` | – | Asks the runner to stop after the current video |
| `resume` | – | Resets any "working" items to "pending" and restarts the runner |
| `clear` | – | Deletes the job and stored transcripts (refused while running) |
| `openResults` | – | Opens `result.html?job=<id>` |

The popup does not poll. It listens to `chrome.storage.onChanged` and re-renders whenever the runner saves the job.

## Stored data

### `chrome.storage.local`

**`job`** – the current or most recent batch:

```js
{
  id, status,              // 'running' | 'stopping' | 'stopped' | 'done' | 'interrupted'
  createdAt, finishedAt, heartbeat,
  source:   { tabId, windowId, url, name, kind },
  settings: { lang, tabFallback, visibleTab },
  current,                 // index of the video being processed, or -1
  downloaded,              // true once the automatic download has happened
  items: [{
    n, id, title, isShort,
    state,                 // 'pending' | 'working' | 'ok' | 'failed'
    step,                  // e.g. 'Opening the video in a tab'
    method,                // 'fast' | 'tab'
    langLabel, lines,
    note,                  // failure reason or 'May be incomplete…'
    details                // log of what was tried, for failed videos
  }]
}
```

**`tx:<jobId>:<videoId>`** – one entry per transcript:

```js
{ title, author, lang, langLabel, method, segments: [[startMs, text], ...] }
```

Transcripts are stored separately from the job so that saving progress after each step stays small and fast. All `tx:` entries are removed when a new batch starts or the batch is cleared.

### `chrome.storage.sync`

- `settings` – `{ lang, tabFallback, visibleTab }` from the popup options.
- `exportPrefs` – `{ format, output, removeTags }` from the results page.

## Job states

```text
            start                     stop pressed
  (none) ─────────→ running ───────────────────────→ stopping ──→ stopped
                      │                                              │
                      │ all videos processed                         │ resume
                      ↓                                              ↓
                     done                                         running

  running / stopping + worker killed by Chrome + heartbeat older than 45 s
                      ──→ interrupted ──resume──→ running
```

## Per-video retrieval and failure handling

```text
fast method
  ├─ success ─────────────────────────────────────────────→ ok
  ├─ HTTP 429 → wait 20 s → fast method again
  ├─ all three clients: "no caption tracks" ──────────────→ failed ("This video has no captions")
  └─ other failure
        ├─ tab fallback off ──────────────────────────────→ failed
        └─ tab method
              ├─ success ────────────────────────────────→ ok (flagged if possibly incomplete)
              ├─ background tab did not draw the panel
              │     → bring tab to front → retry once → keep the better result
              ├─ no "Show transcript" button ────────────→ failed ("No transcript on this video")
              └─ other failure ──────────────────────────→ failed (reason + log)
```

Every failure keeps a `details` log (for example `ANDROID_VR: player HTTP 403 | ANDROID: no caption tracks | Tab: Video tab did not load`), shown on the results page under "What was tried".

### Timeouts and delays

| Operation | Limit |
|---|---|
| Player request / caption download | 15 s each |
| Worker tab navigation | 40 s |
| Waiting for the video page inside the tab | 25 s |
| Waiting for transcript lines after clicking the button | 15 s |
| Whole transcript read in the tab | 75 s (script injection retried once) |
| Pause between videos | 0.9–1.8 s after the fast method, 0.6–1.2 s after the tab method (random) |
| Heartbeat / keep-alive | every 10 s |

### Incomplete transcript check

For videos longer than two minutes, if the last transcript line starts before the halfway point of the video, the transcript is saved but marked "May be incomplete: transcript ends early". If this happens in a hidden background tab, the tab is brought to the front and the transcript is read again.

## Output formatting (`result.js`)

- **Readable paragraphs:** caption lines are joined; a new paragraph starts when the current one is over 900 characters, or over 320 characters and ends a sentence, or when there is a gap of more than 6 seconds and the paragraph is over 120 characters.
- **One line per caption** and **lines with timestamps** (`[m:ss]` or `[h:mm:ss]`).
- **Remove sound tags:** removes short bracketed tags such as `[Music]` or `[Applause]` and music note symbols.
- **File names:** `Downloads/YouTube Transcripts/<page name> - <N> transcripts - <date time>.txt`, or a folder `<page name> <date time>/` containing `<number> - <title>.txt` files. Invalid path characters are removed and names are length-limited.
- The on-page preview is limited to 60,000 characters; the downloaded file always contains everything.
