/* Bulk Transcript Grabber – popup */
const $ = id => document.getElementById(id);

const state = {
  tab: null,
  page: null,
  videos: [],
  selected: new Set(),
  settings: { lang: 'en', tabFallback: true, visibleTab: false }
};

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.ok) return reject(new Error((res && res.error) || 'Something went wrong'));
      resolve(res);
    });
  });
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

/* ---------------- settings ---------------- */

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  Object.assign(state.settings, settings || {});
  $('optLang').value = state.settings.lang;
  $('optFallback').checked = state.settings.tabFallback;
  $('optVisible').checked = state.settings.visibleTab;
}

function saveSettings() {
  state.settings = {
    lang: $('optLang').value.trim() || 'en',
    tabFallback: $('optFallback').checked,
    visibleTab: $('optVisible').checked
  };
  $('optVisible').disabled = !state.settings.tabFallback;
  chrome.storage.sync.set({ settings: state.settings });
}

/* ---------------- views ---------------- */

function show(view) {
  for (const id of ['emptyView', 'pickView', 'runView']) $(id).hidden = id !== view;
}

/* ---------------- scanning the page ---------------- */

function isYouTube(url) {
  return /^https:\/\/www\.youtube\.com\//.test(url || '');
}

async function inject(tabId, fn, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page/scan.js'] });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  return res && res.result;
}

async function scanPage() {
  const data = await inject(state.tab.id, () => globalThis.__btg.scan());
  state.page = data.page;
  const knownIds = new Set(state.videos.map(v => v.id));
  state.videos = data.videos;
  // first scan: preselect the first N
  if (!knownIds.size) selectFirst(parseInt($('firstN').value, 10) || 10);
  renderPick();
}

function selectFirst(n) {
  state.selected = new Set(state.videos.slice(0, Math.max(0, n)).map(v => v.id));
}

function renderPick() {
  const { page, videos } = state;
  $('pageKind').textContent = page.kind ? `YouTube ${page.kind}` : 'YouTube';
  $('pageName').textContent = page.name || 'This page';
  $('foundCount').textContent = plural(videos.length, 'video', 'videos');
  $('foundNote').textContent = videos.length ? 'loaded on this page' : 'found yet';
  if (page.channelCount) {
    $('channelCount').textContent = `The channel header says ${page.channelCount} videos. YouTube only loads more as you scroll.`;
    $('channelCount').hidden = false;
  } else {
    $('channelCount').hidden = true;
  }

  const list = $('videoList');
  list.textContent = '';
  if (!videos.length) {
    list.append(el('li', { class: 'muted' }, [el('span'), el('span'), el('span', { text: 'No video links here yet. Try scrolling the page or opening the Videos tab.' })]));
  }
  videos.forEach((v, i) => {
    const box = el('input', { type: 'checkbox', 'data-id': v.id });
    box.checked = state.selected.has(v.id);
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(v.id);
      else state.selected.delete(v.id);
      updateStart();
    });
    const label = el('label', {}, [
      box,
      el('span', { class: 'num', text: String(i + 1) }),
      el('span', { class: 'vt', text: v.title || `Video ${v.id}`, title: v.title || v.id })
    ]);
    list.append(el('li', {}, [label, v.isShort ? el('span', { class: 'tag', text: 'Short' }) : el('span')]));
  });
  updateStart();
}

function updateStart() {
  const n = state.videos.filter(v => state.selected.has(v.id)).length;
  const btn = $('startBtn');
  btn.disabled = n === 0;
  btn.textContent = n ? `Get ${plural(n, 'transcript', 'transcripts')} as TXT` : 'Select videos first';
}

/* ---------------- progress ---------------- */

const STATUS_ICON = { pending: '○', working: '◐', ok: '✓', failed: '✕' };

function renderRun(job, alive) {
  show('runView');
  const done = job.items.filter(it => it.state === 'ok' || it.state === 'failed').length;
  const ok = job.items.filter(it => it.state === 'ok').length;
  const failed = job.items.filter(it => it.state === 'failed').length;
  const total = job.items.length;

  $('runSource').textContent = job.source.name;
  $('runCount').textContent = `${done} of ${total}`;
  $('runBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;

  const running = alive && (job.status === 'running' || job.status === 'stopping');
  let stateText;
  if (job.status === 'stopping') stateText = 'stopping after this video';
  else if (running) stateText = 'processed';
  else if (job.status === 'done') stateText = `done: ${ok} saved, ${failed} without transcript`;
  else if (job.status === 'stopped') stateText = `stopped: ${ok} saved`;
  else stateText = `interrupted: ${ok} saved`;
  $('runState').textContent = stateText;

  const current = job.current >= 0 ? job.items[job.current] : null;
  $('runNow').hidden = !(running && current);
  if (running && current) {
    $('runNowTitle').textContent = current.title || current.id;
    $('runStep').textContent = current.step || '';
  } else {
    $('runStep').textContent = job.status === 'interrupted'
      ? 'Chrome paused the extension in the background. Resume to continue where it stopped.'
      : '';
  }

  $('stopBtn').hidden = !running;
  $('stopBtn').disabled = job.status === 'stopping';
  $('resultsBtn').hidden = running || ok === 0;
  $('newBtn').hidden = running;
  const hasPending = job.items.some(it => it.state === 'pending' || it.state === 'working');
  const canResume = !running && hasPending && job.status !== 'done';
  $('newBtn').textContent = canResume ? 'Resume' : 'New batch';
  $('newBtn').dataset.action = canResume ? 'resume' : 'new';

  const list = $('runList');
  list.textContent = '';
  for (const it of job.items) {
    const sub = [];
    if (it.state === 'ok') {
      sub.push(it.method === 'tab' ? 'Read from video tab' : 'Fast method');
      if (it.langLabel) sub.push(it.langLabel);
      sub.push(plural(it.lines, 'line', 'lines'));
    }
    const note = it.state === 'failed' ? it.note : (it.note || '');
    list.append(el('li', {}, [
      el('span', { class: `status ${it.state}`, text: STATUS_ICON[it.state] || '○', 'aria-label': it.state }),
      el('span', { class: 'num', text: String(it.n) }),
      el('span', {}, [
        el('span', { class: 'vt', text: it.title || it.id, title: it.details || it.title || '' }),
        sub.length ? el('span', { class: 'sub', text: sub.join(', ') }) : null,
        note ? el('span', { class: `sub ${it.state === 'failed' ? 'bad' : ''}`, text: note }) : null
      ])
    ]));
  }
  if (running && current) {
    const row = list.children[job.current];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------- boot ---------------- */

async function init() {
  await loadSettings();

  let status = { job: null, alive: false };
  try {
    status = await send('status');
  } catch (e) {
    showError(e.message);
  }
  const job = status.job;

  if (job && (status.alive || job.status === 'running' || job.status === 'stopping')) {
    renderRun(job, status.alive);
    watchJob();
    return;
  }

  if (job) {
    const ok = job.items.filter(it => it.state === 'ok').length;
    const pending = job.items.filter(it => it.state === 'pending').length;
    $('lastJobText').textContent = pending && job.status !== 'done'
      ? `Last batch (${job.source.name}) stopped with ${ok} of ${job.items.length} saved.`
      : `Last batch (${job.source.name}): ${ok} of ${job.items.length} transcripts saved.`;
    $('lastOpen').hidden = ok === 0;
    $('lastResume').hidden = !(pending && job.status !== 'done');
    $('lastJob').hidden = false;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  if (!tab || !isYouTube(tab.url)) {
    show('emptyView');
    return;
  }

  show('pickView');
  $('pageName').textContent = 'Looking for videos…';
  try {
    await scanPage();
  } catch (e) {
    show('emptyView');
    $('emptyText').textContent = `Couldn't read this page (${e.message}). Refresh the YouTube tab and try again.`;
  }
}

let watching = false;
function watchJob() {
  if (watching) return;
  watching = true;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.job) return;
    const job = changes.job.newValue;
    if (!job) return;
    let alive = false;
    try {
      alive = (await send('status')).alive;
    } catch (_) { /* ignore */ }
    renderRun(job, alive);
  });
}

/* ---------------- events ---------------- */

$('applyFirstN').addEventListener('click', () => {
  const n = parseInt($('firstN').value, 10) || 0;
  selectFirst(n);
  renderPick();
  if (n > state.videos.length) {
    $('loadMoreNote').textContent = `Only ${state.videos.length} loaded. Scroll to load more.`;
  }
});

$('firstN').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('applyFirstN').click();
});

$('selAll').addEventListener('click', () => {
  state.selected = new Set(state.videos.map(v => v.id));
  renderPick();
});

$('selNone').addEventListener('click', () => {
  state.selected.clear();
  renderPick();
});

$('loadMore').addEventListener('click', async () => {
  const btn = $('loadMore');
  const want = Math.max(parseInt($('firstN').value, 10) || 0, state.videos.length + 30);
  btn.disabled = true;
  $('loadMoreNote').textContent = 'Scrolling…';
  try {
    const res = await inject(state.tab.id, t => globalThis.__btg.loadMore(t), [want]);
    const before = state.videos.length;
    await scanPage();
    const added = state.videos.length - before;
    $('loadMoreNote').textContent = res && res.reachedEnd
      ? `Reached the end (${state.videos.length} total).`
      : `Loaded ${plural(added, 'more video', 'more videos')}.`;
  } catch (e) {
    $('loadMoreNote').textContent = `Couldn't scroll: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

for (const id of ['optLang', 'optFallback', 'optVisible']) {
  $(id).addEventListener('change', saveSettings);
}

$('startBtn').addEventListener('click', async () => {
  saveSettings();
  const videos = state.videos.filter(v => state.selected.has(v.id));
  if (!videos.length) return;
  $('startBtn').disabled = true;
  showError('');
  try {
    const res = await send('start', {
      payload: { tabId: state.tab.id, page: state.page, videos, settings: state.settings }
    });
    $('lastJob').hidden = true;
    renderRun(res.job, true);
    watchJob();
  } catch (e) {
    showError(e.message);
    $('startBtn').disabled = false;
  }
});

$('stopBtn').addEventListener('click', async () => {
  $('stopBtn').disabled = true;
  try {
    await send('stop');
  } catch (e) {
    showError(e.message);
  }
});

$('resultsBtn').addEventListener('click', () => send('openResults').catch(e => showError(e.message)));
$('lastOpen').addEventListener('click', () => send('openResults').catch(e => showError(e.message)));

$('lastResume').addEventListener('click', async () => {
  try {
    const res = await send('resume');
    $('lastJob').hidden = true;
    renderRun(res.job, true);
    watchJob();
  } catch (e) {
    showError(e.message);
  }
});

$('lastDismiss').addEventListener('click', () => {
  $('lastJob').hidden = true;
});

$('newBtn').addEventListener('click', async () => {
  if ($('newBtn').dataset.action === 'resume') {
    try {
      const res = await send('resume');
      renderRun(res.job, true);
      watchJob();
    } catch (e) {
      showError(e.message);
    }
    return;
  }
  window.location.reload();
});

init();
