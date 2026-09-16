/* Bulk Transcript Grabber – results page */
const $ = id => document.getElementById(id);
const RULE = '='.repeat(64);

let job = null;
let transcripts = {}; // videoId -> stored transcript

/* ---------------- text building ---------------- */

function stamp(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function cleanText(text, removeTags) {
  let t = String(text || '');
  if (removeTags) t = t.replace(/\[[^\]\n]{1,30}\]/g, ' ').replace(/[♪♫]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function toParagraphs(segments, removeTags) {
  const paras = [];
  let cur = '';
  let lastStart = null;
  for (const [ms, raw] of segments) {
    const text = cleanText(raw, removeTags);
    if (!text) continue;
    const gap = lastStart == null ? 0 : ms - lastStart;
    const endsSentence = /[.!?…]["'”’)\]]?$/.test(cur);
    if (cur && (cur.length > 900 || (cur.length > 320 && endsSentence) || (gap > 6000 && cur.length > 120))) {
      paras.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${text}` : text;
    lastStart = ms;
  }
  if (cur) paras.push(cur);
  return paras.join('\n\n');
}

function body(segments, prefs) {
  if (prefs.format === 'paragraphs') return toParagraphs(segments, prefs.removeTags);
  const lines = [];
  for (const [ms, raw] of segments) {
    const text = cleanText(raw, prefs.removeTags);
    if (!text) continue;
    lines.push(prefs.format === 'timestamps' ? `[${stamp(ms)}] ${text}` : text);
  }
  return lines.join('\n');
}

function videoBlock(it, tx, prefs) {
  const head = [
    RULE,
    `${it.n}. ${tx.title || it.title || it.id}`,
    `https://www.youtube.com/watch?v=${it.id}`
  ];
  if (tx.author) head.push(`Channel: ${tx.author}`);
  if (tx.langLabel) head.push(`Captions: ${tx.langLabel}`);
  head.push(RULE);
  return `${head.join('\n')}\n\n${body(tx.segments, prefs) || '(transcript is empty after cleanup)'}\n`;
}

function niceDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function fileStamp(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function safeName(s, max = 80) {
  const t = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return (t.slice(0, max).trim() || 'untitled');
}

function okItems() {
  return job.items.filter(it => it.state === 'ok' && transcripts[it.id]);
}

function failedItems() {
  return job.items.filter(it => it.state !== 'ok' || !transcripts[it.id]);
}

function combinedText(prefs) {
  const ok = okItems();
  const failed = failedItems();
  const top = [
    `YouTube transcripts: ${job.source.name}`,
    job.source.url ? `Page: ${job.source.url}` : '',
    `Saved: ${niceDate(job.finishedAt || Date.now())}`,
    `Transcripts: ${ok.length} of ${job.items.length} videos`
  ].filter(Boolean).join('\n');

  const parts = [top, ''];
  for (const it of ok) parts.push(videoBlock(it, transcripts[it.id], prefs), '');

  if (failed.length) {
    parts.push(RULE, 'Videos without a transcript', RULE);
    for (const it of failed) {
      parts.push(`${it.n}. ${it.title || it.id}`, `   https://www.youtube.com/watch?v=${it.id}`, `   ${it.state === 'pending' ? 'Not processed (batch stopped)' : it.note || 'No transcript'}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

/* ---------------- prefs ---------------- */

function readPrefs() {
  return {
    format: document.querySelector('input[name="format"]:checked').value,
    output: document.querySelector('input[name="output"]:checked').value,
    removeTags: $('removeTags').checked
  };
}

async function loadPrefs() {
  const { exportPrefs } = await chrome.storage.sync.get('exportPrefs');
  const p = { format: 'paragraphs', output: 'combined', removeTags: false, ...(exportPrefs || {}) };
  const f = document.querySelector(`input[name="format"][value="${p.format}"]`);
  const o = document.querySelector(`input[name="output"][value="${p.output}"]`);
  if (f) f.checked = true;
  if (o) o.checked = true;
  $('removeTags').checked = !!p.removeTags;
}

function savePrefs() {
  const p = readPrefs();
  chrome.storage.sync.set({ exportPrefs: p });
  renderPreview();
}

/* ---------------- download / copy ---------------- */

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  return chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 120000));
}

async function download() {
  const prefs = readPrefs();
  const ok = okItems();
  if (!ok.length) return;
  const base = safeName(job.source.name, 60);
  const when = fileStamp(job.finishedAt || Date.now());
  $('download').disabled = true;
  try {
    if (prefs.output === 'separate') {
      const folder = `YouTube Transcripts/${base} ${when}`;
      for (const it of ok) {
        const tx = transcripts[it.id];
        const num = String(it.n).padStart(String(job.items.length).length, '0');
        await downloadText(videoBlock(it, tx, prefs), `${folder}/${num} - ${safeName(tx.title || it.title)}.txt`);
      }
      $('actionNote').textContent = `Saved ${ok.length} files to Downloads/${folder}`;
    } else {
      const name = `YouTube Transcripts/${base} - ${ok.length} transcripts - ${when}.txt`;
      await downloadText(combinedText(prefs), name);
      $('actionNote').textContent = `Saved to Downloads/${name}`;
    }
  } catch (e) {
    $('actionNote').textContent = `Download failed: ${e.message}`;
  } finally {
    $('download').disabled = false;
  }
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(combinedText(readPrefs()));
    $('actionNote').textContent = 'Copied every transcript to the clipboard';
  } catch (e) {
    $('actionNote').textContent = `Copy failed: ${e.message}`;
  }
}

/* ---------------- render ---------------- */

function renderPreview() {
  const text = combinedText(readPrefs());
  const limit = 60000;
  $('preview').textContent = text.length > limit
    ? `${text.slice(0, limit)}\n\n… preview cut here. The downloaded file has everything.`
    : text;
  $('previewBox').hidden = false;
}

function renderFailed() {
  const failed = failedItems();
  $('failedBox').hidden = !failed.length;
  $('failedTitle').textContent = failed.length === 1 ? '1 video without a transcript' : `${failed.length} videos without a transcript`;
  const list = $('failedList');
  list.textContent = '';
  for (const it of failed) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://www.youtube.com/watch?v=${it.id}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${it.n}. ${it.title || it.id}`;
    const why = document.createElement('span');
    why.className = 'muted';
    why.textContent = it.state === 'pending' ? 'Not processed: the batch was stopped' : (it.note || 'No transcript');
    li.append(a, why);
    if (it.details) {
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = 'What was tried';
      const p = document.createElement('p');
      p.textContent = it.details;
      d.append(s, p);
      li.append(d);
    }
    list.append(li);
  }
}

async function init() {
  const wanted = new URLSearchParams(location.search).get('job');
  const store = await chrome.storage.local.get(null);
  job = store.job;
  if (!job || (wanted && job.id !== wanted)) {
    $('source').textContent = 'Nothing to show';
    $('name').textContent = 'These results were replaced by a newer batch';
    return;
  }
  const prefix = `tx:${job.id}:`;
  for (const [k, v] of Object.entries(store)) {
    if (k.startsWith(prefix)) transcripts[k.slice(prefix.length)] = v;
  }

  await loadPrefs();
  const ok = okItems();
  document.title = `${ok.length} transcripts: ${job.source.name}`;
  $('source').textContent = `${job.source.kind ? `YouTube ${job.source.kind}` : 'YouTube'}, ${niceDate(job.finishedAt || job.createdAt)}`;
  $('name').textContent = job.source.name;
  $('count').textContent = ok.length === 1 ? '1 transcript' : `${ok.length} transcripts`;
  $('countNote').textContent = `from ${job.items.length} selected ${job.items.length === 1 ? 'video' : 'videos'}`;

  renderFailed();
  if (!ok.length) return;

  $('controls').hidden = false;
  renderPreview();

  document.querySelectorAll('input[name="format"], input[name="output"], #removeTags')
    .forEach(inp => inp.addEventListener('change', savePrefs));
  $('download').addEventListener('click', download);
  $('copy').addEventListener('click', copyAll);

  const finished = job.status === 'done' || job.status === 'stopped' || job.status === 'interrupted';
  if (finished && !job.downloaded) {
    job.downloaded = true;
    const { job: latest } = await chrome.storage.local.get('job');
    if (latest && latest.id === job.id) {
      latest.downloaded = true;
      await chrome.storage.local.set({ job: latest });
    }
    await download();
  }
}

init().catch(e => {
  $('source').textContent = 'Something went wrong';
  $('name').textContent = e.message;
});
