/*
 * Runs in the YouTube tab (isolated world) when the popup opens.
 * Finds every video link on the page that's currently showing, in page order.
 */
(function () {
  const ns = (globalThis.__btg = globalThis.__btg || {});
  if (ns.scan) return;

  const DURATION = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}\s*$/;
  const JUNK = /^(now playing|shorts?|live|premiere|new|4k|hd|cc|upcoming|members only|watch later|add to queue)$/i;
  const VIEWS = /^[\d.,]+\s*[KMB]?\s*(views?|watching)\b/i;

  function clean(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  function isJunk(t) {
    return !t || t.length < 2 || DURATION.test(t) || JUNK.test(t) || VIEWS.test(t);
  }

  function videoIdFromHref(href) {
    if (!href) return null;
    let m = href.match(/[?&]v=([\w-]{11})/);
    if (m) return { id: m[1], isShort: false };
    m = href.match(/\/shorts\/([\w-]{11})/);
    if (m) return { id: m[1], isShort: true };
    return null;
  }

  // Only look inside the page YouTube is showing right now
  // (YouTube keeps earlier pages in the DOM, hidden).
  function visibleRoots() {
    const manager = document.querySelector('ytd-page-manager');
    if (!manager) return [document];
    const roots = [...manager.children].filter(el => {
      if (el.hidden || el.hasAttribute('hidden')) return false;
      try {
        return getComputedStyle(el).display !== 'none';
      } catch (_) {
        return true;
      }
    });
    return roots.length ? roots : [manager];
  }

  function titleCandidates(a) {
    const out = [];
    const push = (text, score) => {
      const t = clean(text);
      if (!isJunk(t)) out.push({ t, score });
    };
    push(a.getAttribute('title'), 5);
    if (a.id === 'video-title' || a.id === 'video-title-link') push(a.textContent, 5);
    const vt = a.querySelector('#video-title, [id="video-title"]');
    if (vt) push(vt.getAttribute('title') || vt.textContent, 5);
    const lockup = a.matches('[class*="lockup-metadata"][class*="title"]') ? a
      : a.querySelector('[class*="lockup-metadata"][class*="title"]');
    if (lockup) push(lockup.textContent, 4);
    const h3 = a.querySelector('h3');
    if (h3) push(h3.textContent, 4);
    const roleText = a.querySelector('span[role="text"]');
    if (roleText) push(roleText.textContent, 3);
    if (!a.querySelector('img, yt-image, ytd-thumbnail, yt-thumbnail-view-model')) push(a.textContent, 2);
    const aria = clean(a.getAttribute('aria-label'));
    if (aria) push(aria.replace(/\s+\d[\d.,]*\s*(views?|watching).*$/i, ''), 1);
    return out;
  }

  function collect() {
    const found = new Map();
    let order = 0;
    for (const root of visibleRoots()) {
      const anchors = root.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');
      for (const a of anchors) {
        if (a.closest('ytd-miniplayer, #masthead-container, tp-yt-app-drawer, ytd-guide-renderer, ytd-comments')) continue;
        const info = videoIdFromHref(a.getAttribute('href'));
        if (!info) continue;
        let item = found.get(info.id);
        if (!item) {
          item = { id: info.id, isShort: info.isShort, order: order++, best: null };
          found.set(info.id, item);
        }
        if (info.isShort) item.isShort = true;
        for (const c of titleCandidates(a)) {
          if (!item.best || c.score > item.best.score || (c.score === item.best.score && c.t.length > item.best.t.length)) {
            item.best = c;
          }
        }
      }
    }
    return [...found.values()]
      .sort((x, y) => x.order - y.order)
      .map(v => ({ id: v.id, isShort: v.isShort, title: v.best ? v.best.t : '' }));
  }

  function pageInfo() {
    const path = location.pathname;
    let kind = 'page';
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(path)) {
      if (/\/shorts\/?$/.test(path)) kind = 'Shorts tab';
      else if (/\/streams\/?$/.test(path)) kind = 'Live tab';
      else if (/\/videos\/?$/.test(path)) kind = 'Videos tab';
      else kind = 'channel page';
    } else if (path === '/playlist') kind = 'playlist';
    else if (path === '/results') kind = 'search results';
    else if (path === '/watch') kind = 'video page';
    else if (path === '/' || path.startsWith('/feed/')) kind = 'feed';

    let name = '';
    const nameEl = document.querySelector(
      'yt-page-header-renderer h1, yt-dynamic-text-view-model h1, #channel-header #channel-name #text, ' +
      'ytd-playlist-header-renderer .yt-dynamic-sizing-formatted-string, yt-page-header-view-model h1'
    );
    if (nameEl) name = clean(nameEl.textContent);
    if (!name) name = clean(document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, ''));

    let channelCount = '';
    const header = document.querySelector('yt-page-header-renderer, #channel-header, ytd-playlist-header-renderer, yt-page-header-view-model');
    if (header) {
      const m = clean(header.textContent).match(/([\d.,]+\s*[KMB]?)\s+videos?\b/i);
      if (m) channelCount = m[1].replace(/\s+/g, '');
    }
    return { kind, name, channelCount, url: location.href };
  }

  ns.scan = function () {
    return { page: pageInfo(), videos: collect() };
  };

  ns.loadMore = async function (target) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let last = collect().length;
    let stalls = 0;
    for (let round = 0; round < 80 && last < target; round++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const spinner = document.querySelector('ytd-continuation-item-renderer');
      if (spinner && spinner.scrollIntoView) spinner.scrollIntoView({ block: 'end' });
      await sleep(1300);
      const now = collect().length;
      if (now > last) {
        last = now;
        stalls = 0;
      } else if (++stalls >= 4) {
        break;
      }
    }
    return { count: last, reachedEnd: stalls >= 4 };
  };
})();
