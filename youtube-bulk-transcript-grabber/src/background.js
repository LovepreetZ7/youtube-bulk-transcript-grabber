/* Bulk Transcript Grabber – background job runner */
importScripts('page/fast.js');

const JOB_KEY = 'job';
const TX_PREFIX = 'tx:';
const HEARTBEAT_STALE_MS = 45000;

let runner = null; // { job, stop }
let keepAliveTimer = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

/* ---------------- storage helpers ---------------- */

async function loadJob() {
  const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
  return job || null;
}

async function saveJob(job) {
  job.heartbeat = Date.now();
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function removeOldTranscripts() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(TX_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

function isAlive(job) {
  return !!(runner && job && runner.job.id === job.id);
}

// If the browser killed the background worker mid-job, mark the job as interrupted.
(async () => {
  const job = await loadJob();
  if (job && (job.status === 'running' || job.status === 'stopping') && !runner &&
      Date.now() - (job.heartbeat || 0) > HEARTBEAT_STALE_MS) {
    job.status = 'interrupted';
    await chrome.storage.local.set({ [JOB_KEY]: job });
  }
})();

/* ---------------- keep the worker awake during a job ---------------- */

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
    if (runner) saveJob(runner.job).catch(() => {});
  }, 10000);
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/* ---------------- messages from popup / results page ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'status': {
        const job = await loadJob();
        return { job, alive: isAlive(job) };
      }
      case 'start':
        return startJob(msg.payload);
      case 'stop':
        return stopJob();
      case 'resume':
        return resumeJob();
      case 'clear':
        if (runner) throw new Error('A batch is still running. Stop it first.');
        await removeOldTranscripts();
        await chrome.storage.local.remove(JOB_KEY);
        return {};
      case 'openResults': {
        const job = await loadJob();
        if (!job) throw new Error('No finished batch to show.');
        await chrome.tabs.create({ url: chrome.runtime.getURL(`result.html?job=${job.id}`) });
        return {};
      }
      default:
        throw new Error('Unknown request');
    }
  })()
    .then(r => sendResponse({ ok: true, ...(r || {}) }))
    .catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

async function startJob(payload) {
  if (runner) throw new Error('A batch is already running.');
  if (!payload || !Array.isArray(payload.videos) || !payload.videos.length) {
    throw new Error('Select at least one video.');
  }
  await removeOldTranscripts();

  let windowId;
  try {
    windowId = (await chrome.tabs.get(payload.tabId)).windowId;
  } catch (_) { /* tab gone */ }

  const job = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    heartbeat: Date.now(),
    source: {
      tabId: payload.tabId,
      windowId,
      url: payload.page && payload.page.url,
      name: (payload.page && payload.page.name) || 'YouTube',
      kind: payload.page && payload.page.kind
    },
    settings: {
      lang: (payload.settings && payload.settings.lang) || 'en',
      tabFallback: !(payload.settings && payload.settings.tabFallback === false),
      visibleTab: !!(payload.settings && payload.settings.visibleTab)
    },
    items: payload.videos.map((v, i) => ({
      n: i + 1,
      id: v.id,
      title: v.title || '',
      isShort: !!v.isShort,
      state: 'pending', // pending | working | ok | failed
      step: '',
      method: '',
      langLabel: '',
      lines: 0,
      note: ''
    })),
    current: -1,
    downloaded: false
  };
  await saveJob(job);
  run(job);
  return { job };
}

async function resumeJob() {
  if (runner) throw new Error('A batch is already running.');
  const job = await loadJob();
  if (!job) throw new Error('Nothing to resume.');
  for (const it of job.items) {
    if (it.state === 'working') it.state = 'pending';
  }
  job.status = 'running';
  job.finishedAt = null;
  await saveJob(job);
  run(job);
  return { job };
}

async function stopJob() {
  if (!runner) {
    const job = await loadJob();
    if (job && (job.status === 'running' || job.status === 'stopping')) {
      job.status = 'stopped';
      await saveJob(job);
    }
    return { job };
  }
  runner.stop = true;
  runner.job.status = 'stopping';
  await saveJob(runner.job);
  return { job: runner.job };
}

/* ---------------- the job loop ---------------- */

async function run(job) {
  runner = { job, stop: false, workerTabId: null };
  startKeepAlive();
  try {
    for (let i = 0; i < job.items.length; i++) {
      if (runner.stop) break;
      const it = job.items[i];
      if (it.state === 'ok' || it.state === 'failed') continue;

      job.current = i;
      it.state = 'working';
      it.step = 'Fast method';
      await saveJob(job);

      let result;
      try {
        result = await grabOne(job, it);
      } catch (e) {
        result = { ok: false, note: (e && e.message) || String(e) };
      }

      if (result.ok) {
        await chrome.storage.local.set({
          [`${TX_PREFIX}${job.id}:${it.id}`]: {
            title: result.title || it.title,
            author: result.author || '',
            langLabel: result.langLabel || '',
            lang: result.lang || '',
            method: result.method,
            segments: result.segments
          }
        });
        it.state = 'ok';
        it.title = result.title || it.title;
        it.method = result.method;
        it.langLabel = result.langLabel || '';
        it.lines = result.segments.length;
        it.note = result.partial ? 'May be incomplete: transcript ends early' : '';
      } else {
        it.state = 'failed';
        if (result.title) it.title = result.title;
        it.note = result.note || 'No transcript found';
        it.details = result.details || '';
      }
      it.step = '';
      await saveJob(job);

      if (!runner.stop && i < job.items.length - 1) {
        await sleep(result.method === 'tab' ? jitter(600, 600) : jitter(900, 900));
      }
    }
  } finally {
    stopKeepAlive();
    if (runner.workerTabId != null) {
      chrome.tabs.remove(runner.workerTabId).catch(() => {});
    }
    const stopped = runner.stop;
    job.current = -1;
    job.finishedAt = Date.now();
    job.status = stopped ? 'stopped' : 'done';
    for (const it of job.items) if (it.state === 'working') it.state = 'pending';
    await saveJob(job);
    runner = null;

    const okCount = job.items.filter(it => it.state === 'ok').length;
    if (okCount > 0) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`result.html?job=${job.id}`) }).catch(() => {});
    }
  }
}

async function setStep(job, it, step) {
  it.step = step;
  await saveJob(job);
}

async function grabOne(job, it) {
  const notes = [];

  // 1) Fast method
  let fast = await runFast(job, it.id);
  if (!fast.ok && fast.rateLimited) {
    await setStep(job, it, 'YouTube asked us to slow down, waiting 20s');
    await sleep(20000);
    fast = await runFast(job, it.id);
  }
  if (fast.ok) return fast;
  notes.push(...(fast.notes || []));
  const meta = fast.meta || {};

  // All three app clients opened the video and agree it has no captions: don't waste time on a tab.
  if (fast.noCaptions) {
    return { ok: false, title: meta.title, note: 'This video has no captions', details: notes.join(' | ') };
  }

  // 2) Tab method
  if (job.settings.tabFallback && !runner.stop) {
    await setStep(job, it, 'Opening the video in a tab');
    const tab = await runTab(job, it, meta.lengthSeconds || 0);
    if (tab.ok) return tab;
    if (tab.note) notes.push(`Tab: ${tab.note}`);
    if (tab.reason === 'no_button') {
      return {
        ok: false,
        title: tab.title || meta.title,
        note: 'No transcript on this video',
        details: notes.join(' | ')
      };
    }
    return { ok: false, title: tab.title || meta.title, note: tab.note || 'Could not read the transcript', details: notes.join(' | ') };
  }

  return {
    ok: false,
    title: meta.title,
    note: 'Fast method failed (tab fallback is off)',
    details: notes.join(' | ')
  };
}

/* ---------------- fast method ---------------- */

async function runFast(job, videoId) {
  const lang = job.settings.lang;
  const tabId = job.source.tabId;
  if (tabId != null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page/fast.js'] });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (id, l) => globalThis.__btgFast(id, l),
        args: [videoId, lang]
      });
      if (res && res.result) return res.result;
    } catch (_) {
      // source tab closed or left YouTube – use the background worker instead
      job.source.tabId = null;
    }
  }
  return globalThis.__btgFast(videoId, lang);
}

/* ---------------- tab method ---------------- */

function navigateAndWait(tabId, url, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.update(tabId, { url }).catch(() => finish(false));
  });
}

async function ensureWorkerTab(job) {
  if (runner.workerTabId != null) {
    try {
      await chrome.tabs.get(runner.workerTabId);
      return runner.workerTabId;
    } catch (_) {
      runner.workerTabId = null;
    }
  }
  const createProps = { url: 'about:blank', active: job.settings.visibleTab };
  if (job.source.windowId != null) createProps.windowId = job.source.windowId;
  let tab;
  try {
    tab = await chrome.tabs.create(createProps);
  } catch (_) {
    tab = await chrome.tabs.create({ url: 'about:blank', active: job.settings.visibleTab });
  }
  runner.workerTabId = tab.id;
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  return tab.id;
}

async function scrapeInTab(tabId, videoId, lengthSeconds) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['page/scrape.js'] });
      const run = chrome.scripting.executeScript({
        target: { tabId },
        func: (id, len) => globalThis.__btg.scrape(id, len),
        args: [videoId, lengthSeconds]
      });
      const timeout = sleep(75000).then(() => [{ result: { ok: false, reason: 'timeout', note: 'Took too long' } }]);
      const [res] = await Promise.race([run, timeout]);
      if (res && res.result) return res.result;
    } catch (e) {
      // page was still switching over – try once more
      await sleep(1500);
      if (attempt === 1) return { ok: false, reason: 'error', note: (e && e.message) || String(e) };
    }
  }
  return { ok: false, reason: 'error', note: 'Could not run inside the video tab' };
}

async function runTab(job, it, lengthSeconds) {
  const tabId = await ensureWorkerTab(job);
  const url = `https://www.youtube.com/watch?v=${it.id}`;
  const loaded = await navigateAndWait(tabId, url, 40000);
  if (!loaded) return { ok: false, reason: 'load', note: 'Video tab did not load' };

  await setStep(job, it, 'Reading the transcript panel');
  let r = await scrapeInTab(tabId, it.id, lengthSeconds);

  // Background tabs sometimes don't draw the panel. Bring the tab forward once and retry.
  const needsFront = !job.settings.visibleTab &&
    ((!r.ok && (r.reason === 'panel_empty' || r.reason === 'page_not_ready' || r.reason === 'timeout')) ||
     (r.ok && r.partial && r.hidden));
  if (needsFront && !runner.stop) {
    await setStep(job, it, 'Retrying with the video tab in front');
    let previous = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      await chrome.tabs.update(tabId, { active: true });
      await sleep(1500);
      const again = await scrapeInTab(tabId, it.id, lengthSeconds);
      if (again.ok && (!r.ok || again.segments.length > r.segments.length)) r = again;
      else if (!r.ok) r = again;
    } catch (_) { /* keep first result */ }
    if (previous && previous.id !== tabId) {
      chrome.tabs.update(previous.id, { active: true }).catch(() => {});
    }
  }
  return r;
}
