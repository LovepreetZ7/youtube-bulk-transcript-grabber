/*
 * Fast method: no video tab needed.
 * Asks YouTube's player API for the video the same way the YouTube VR / Android / iPhone
 * apps do. Those apps get caption-file links that don't need the web player's security
 * token, so we can download the captions directly with just the video ID.
 *
 * This file is injected into the YouTube page (MAIN world) and also loaded by the
 * background service worker with importScripts, so it must be fully self-contained.
 */
(function () {
  if (globalThis.__btgFast) return;

  // No API key is stored in this file. When the script runs inside a YouTube tab it reuses
  // the public player key that the YouTube page itself provides (see readPageConfig);
  // otherwise the request is sent without a key.

  const CLIENTS = [
    {
      name: 'ANDROID_VR',
      client: {
        clientName: 'ANDROID_VR', clientVersion: '1.62.27',
        deviceMake: 'Oculus', deviceModel: 'Quest 3',
        androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en', gl: 'US'
      }
    },
    {
      name: 'ANDROID',
      client: {
        clientName: 'ANDROID', clientVersion: '20.10.38',
        androidSdkVersion: 35, osName: 'Android', osVersion: '15',
        deviceMake: 'Google', deviceModel: 'Pixel 9 Pro', hl: 'en', gl: 'US'
      }
    },
    {
      name: 'IOS',
      client: {
        clientName: 'IOS', clientVersion: '20.10.4',
        deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iOS', osVersion: '18.3.2', hl: 'en', gl: 'US'
      }
    }
  ];

  async function fetchWithTimeout(url, init, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  function textOf(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (v.simpleText) return v.simpleText;
    if (Array.isArray(v.runs)) return v.runs.map(r => r.text || '').join('');
    return '';
  }

  function isAutoTrack(t) {
    return t && (t.kind === 'asr' || String(t.vssId || '').startsWith('a.'));
  }

  function pickTrack(tracks, pref) {
    const norm = s => String(s || '').trim().toLowerCase().replace('_', '-');
    const p = norm(pref);
    const base = p.split('-')[0];
    const rank = t => {
      const lc = norm(t.languageCode);
      let r;
      if (p && lc === p) r = 0;
      else if (base && lc.split('-')[0] === base) r = 10;
      else r = 50;
      return r + (isAutoTrack(t) ? 15 : 0); // human-made captions beat auto-generated ones in the same language
    };
    return tracks
      .filter(t => t && t.baseUrl)
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
      .map(x => x.t)[0] || null;
  }

  function decodeEntities(s) {
    const once = x => x.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      if (k === 'nbsp') return ' ';
      try {
        const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return String.fromCodePoint(code);
      } catch (_) {
        return m;
      }
    });
    // YouTube's XML is sometimes double-escaped (&amp;#39;)
    return once(once(s));
  }

  function parseJson3(body) {
    const data = JSON.parse(body);
    const out = [];
    for (const ev of data.events || []) {
      if (!Array.isArray(ev.segs)) continue;
      const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push([Math.max(0, Math.round(ev.tStartMs || 0)), text]);
    }
    return out;
  }

  function parseXml(body) {
    const out = [];
    let m;
    const textRe = /<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    while ((m = textRe.exec(body))) {
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (text) out.push([Math.round(parseFloat(m[1]) * 1000), text]);
    }
    if (out.length) return out;
    const pRe = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = pRe.exec(body))) {
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (text) out.push([parseInt(m[1], 10), text]);
    }
    return out;
  }

  async function downloadTrack(baseUrl) {
    const clean = String(baseUrl).replace(/\\u0026/g, '&');
    // 1) json3
    try {
      const u = new URL(clean);
      u.searchParams.set('fmt', 'json3');
      const r = await fetchWithTimeout(u.toString(), { credentials: 'omit' }, 15000);
      if (r.status === 429) return { rateLimited: true, segments: [] };
      if (r.ok) {
        const body = await r.text();
        if (body.trim()) {
          const segs = parseJson3(body);
          if (segs.length) return { segments: segs };
        }
      }
    } catch (_) { /* try XML */ }
    // 2) plain XML
    try {
      const u = new URL(clean);
      u.searchParams.delete('fmt');
      const r = await fetchWithTimeout(u.toString(), { credentials: 'omit' }, 15000);
      if (r.status === 429) return { rateLimited: true, segments: [] };
      if (r.ok) {
        const body = await r.text();
        if (body.trim()) return { segments: parseXml(body) };
      }
    } catch (_) { /* nothing */ }
    return { segments: [] };
  }

  function readPageConfig() {
    try {
      const cfg = globalThis.ytcfg;
      if (!cfg) return {};
      const get = k => (typeof cfg.get === 'function' ? cfg.get(k) : cfg.data_ && cfg.data_[k]);
      return { key: get('INNERTUBE_API_KEY'), visitorData: get('VISITOR_DATA') };
    } catch (_) {
      return {};
    }
  }

  globalThis.__btgFast = async function (videoId, prefLang) {
    const page = readPageConfig();
    const keyParam = page.key ? `key=${encodeURIComponent(page.key)}&` : '';
    const notes = [];
    let meta = null;
    let noCaptionAnswers = 0;

    for (const c of CLIENTS) {
      try {
        const client = { ...c.client };
        if (page.visitorData) client.visitorData = page.visitorData;
        const r = await fetchWithTimeout(
          `https://www.youtube.com/youtubei/v1/player?${keyParam}prettyPrint=false`,
          {
            method: 'POST',
            credentials: 'omit', // these app clients don't accept logged-in web cookies
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client }, videoId, contentCheckOk: true, racyCheckOk: true })
          },
          15000
        );
        if (r.status === 429) {
          notes.push(`${c.name}: YouTube rate limit (429)`);
          return { ok: false, rateLimited: true, notes, meta };
        }
        if (!r.ok) {
          notes.push(`${c.name}: player HTTP ${r.status}`);
          continue;
        }
        const pr = await r.json();
        const vd = pr && pr.videoDetails;
        if (vd && vd.videoId && vd.videoId !== videoId) {
          notes.push(`${c.name}: answered for a different video`);
          continue;
        }
        if (vd && !meta) {
          meta = {
            title: vd.title || '',
            author: vd.author || '',
            lengthSeconds: parseInt(vd.lengthSeconds || '0', 10) || 0
          };
        }
        const ps = pr && pr.playabilityStatus;
        if (ps && ps.status && ps.status !== 'OK') {
          notes.push(`${c.name}: ${ps.status}${ps.reason ? ' – ' + ps.reason : ''}`);
          continue;
        }
        const tracks = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
          pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
        if (!tracks.length) {
          noCaptionAnswers++;
          notes.push(`${c.name}: no caption tracks`);
          continue;
        }
        const track = pickTrack(tracks, prefLang);
        if (!track) {
          notes.push(`${c.name}: caption tracks had no download link`);
          continue;
        }
        const dl = await downloadTrack(track.baseUrl);
        if (dl.rateLimited) {
          notes.push(`${c.name}: caption download rate limited (429)`);
          return { ok: false, rateLimited: true, notes, meta };
        }
        if (!dl.segments.length) {
          notes.push(`${c.name}: caption file came back empty`);
          continue;
        }
        const label = textOf(track.name) || String(track.languageCode || '').toUpperCase();
        const auto = isAutoTrack(track);
        return {
          ok: true,
          method: 'fast',
          client: c.name,
          segments: dl.segments,
          title: (meta && meta.title) || '',
          author: (meta && meta.author) || '',
          lengthSeconds: (meta && meta.lengthSeconds) || 0,
          lang: track.languageCode || '',
          langLabel: auto && !/auto-generated/i.test(label) ? `${label} (auto-generated)` : label,
          notes
        };
      } catch (e) {
        notes.push(`${c.name}: ${e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || e}`);
      }
    }
    // every client loaded the video fine and none of them saw a caption track
    return { ok: false, noCaptions: noCaptionAnswers === CLIENTS.length, notes, meta };
  };

  // exposed for tests
  globalThis.__btgFastInternals = { parseJson3, parseXml, pickTrack, decodeEntities };
})();
