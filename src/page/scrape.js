/*
 * Tab method (fallback): runs inside a video tab.
 * Clicks YouTube's own "Show transcript" button and reads the lines from the panel.
 * YouTube currently ships two versions of the panel, both are handled.
 */
(function () {
  const ns = (globalThis.__btg = globalThis.__btg || {});
  if (ns.scrape) return;

  const NEW_SEG = 'transcript-segment-view-model';
  const OLD_SEG = 'ytd-transcript-segment-renderer';
  const SEG = `${NEW_SEG}, ${OLD_SEG}`;
  const PANEL = 'ytd-engagement-panel-section-list-renderer';
  const BUTTONS = [
    'ytd-video-description-transcript-section-renderer button',
    'button[aria-label="Show transcript"]',
    'button[aria-label="Transcript"]'
  ];
  const EXPANDERS = [
    'ytd-watch-metadata #description-inline-expander #expand',
    'ytd-text-inline-expander #expand',
    '#description #expand',
    'tp-yt-paper-button#expand'
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function until(fn, ms, step = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return fn();
  }

  function clean(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  function stampToMs(stamp) {
    const parts = clean(stamp).split(':').map(n => parseInt(n, 10));
    if (parts.some(isNaN)) return 0;
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s * 1000;
  }

  function findButton() {
    for (const sel of BUTTONS) {
      const b = document.querySelector(sel);
      if (b) return b;
    }
    return null;
  }

  function readSegments(root) {
    const out = [];
    const fresh = root.querySelectorAll(NEW_SEG);
    if (fresh.length) {
      fresh.forEach(seg => {
        const stamp = seg.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
        const text = seg.querySelector('span[role="text"]');
        const t = clean(text && text.textContent);
        if (t) out.push([stampToMs(stamp && stamp.textContent), t]);
      });
      return out;
    }
    root.querySelectorAll(OLD_SEG).forEach(seg => {
      const stamp = seg.querySelector('.segment-timestamp');
      const text = seg.querySelector('.segment-text');
      const t = clean(text && text.textContent);
      if (t) out.push([stampToMs(stamp && stamp.textContent), t]);
    });
    return out;
  }

  function durationFromPage() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const m = /"duration"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/.exec(s.textContent || '');
        if (m) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
      } catch (_) { /* ignore */ }
    }
    const meta = document.querySelector('meta[itemprop="duration"]');
    if (meta) {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(meta.getAttribute('content') || '');
      if (m) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
    }
    return 0;
  }

  function pageTitle() {
    const h1 = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, h1.ytd-watch-metadata');
    const t = clean(h1 && h1.textContent);
    return t || clean(document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, ''));
  }

  function pageAuthor() {
    const el = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a');
    return clean(el && el.textContent);
  }

  function langLabel(panel) {
    const el = panel && panel.querySelector(
      'ytd-transcript-footer-renderer yt-dropdown-menu #label-text, ytd-transcript-footer-renderer #label-text, ' +
      'ytd-transcript-footer-renderer tp-yt-paper-button'
    );
    return clean(el && el.textContent);
  }

  function pauseVideo() {
    try {
      const v = document.querySelector('video');
      if (v && !v.paused) v.pause();
    } catch (_) { /* ignore */ }
  }

  ns.scrape = async function (videoId, knownLengthSeconds) {
    const pauser = setInterval(pauseVideo, 1000);
    try {
      const flexy = await until(() => document.querySelector(`ytd-watch-flexy[video-id="${videoId}"]`), 25000, 300);
      if (!flexy) {
        return { ok: false, reason: 'page_not_ready', note: 'Video page did not finish loading' };
      }
      await until(() => pageTitle(), 6000);
      const title = pageTitle();
      const author = pageAuthor();

      // Panel may already be open (e.g. on a retry)
      let first = document.querySelector(SEG);

      if (!first) {
        let button = await until(findButton, 5000, 300);
        if (!button) {
          for (const sel of EXPANDERS) {
            const ex = document.querySelector(sel);
            if (ex) {
              ex.click();
              break;
            }
          }
          await sleep(800);
          button = await until(findButton, 4000, 300);
        }
        if (!button) {
          return { ok: false, reason: 'no_button', title, author, note: 'No "Show transcript" button on this video' };
        }
        button.click();
        first = await until(() => document.querySelector(SEG), 15000, 300);
      }

      if (!first) {
        return { ok: false, reason: 'panel_empty', title, author, note: 'Transcript panel opened but no lines appeared' };
      }

      const panel = first.closest(PANEL) || document;
      // wait until the number of lines stops growing
      let prev = -1;
      for (let i = 0; i < 25; i++) {
        const n = panel.querySelectorAll(SEG).length;
        if (n === prev) break;
        prev = n;
        await sleep(450);
      }

      const segments = readSegments(panel);
      if (!segments.length) {
        return { ok: false, reason: 'panel_empty', title, author, note: 'Transcript panel had no readable lines' };
      }

      const length = knownLengthSeconds || durationFromPage();
      const lastSec = segments[segments.length - 1][0] / 1000;
      const partial = length > 120 && lastSec < length * 0.5;

      return {
        ok: true,
        method: 'tab',
        segments,
        title,
        author,
        lang: '',
        langLabel: langLabel(panel),
        lengthSeconds: length,
        partial,
        hidden: document.visibilityState === 'hidden'
      };
    } catch (e) {
      return { ok: false, reason: 'error', note: (e && e.message) || String(e) };
    } finally {
      clearInterval(pauser);
    }
  };

  // exposed for tests
  ns.__scrapeInternals = { readSegments, stampToMs };
})();
