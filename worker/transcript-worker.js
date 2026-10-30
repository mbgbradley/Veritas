// Veritas transcript service: a small Cloudflare Worker (free tier is plenty).
//
//   GET /transcript?v=VIDEO_ID  -> captions as timed segments
//   GET /article?url=https://…  -> readable text of a web article
//
// IMPORTANT
// - YouTube has no official API for reading captions of videos you do not own.
//   This reads the same public caption tracks the YouTube player uses. It is unofficial,
//   may stop working when YouTube changes things, and its use may conflict with YouTube's
//   Terms of Service. Review the terms before running it for the public.
// - Not tested against live YouTube from the build environment. Test it with your own video IDs.
//
// Set the optional variable ALLOWED_ORIGIN to your site, e.g. https://yourname.github.io

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = env.ALLOWED_ORIGIN || '*';
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed === '*' ? '*' : (origin === allowed ? origin : allowed),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (url.pathname === '/transcript') return json(await transcript(url.searchParams.get('v')), cors, 60);
      if (url.pathname === '/article') return json(await article(url.searchParams.get('url')), cors, 300);
      return json({ ok: true, routes: ['/transcript?v=', '/article?url='] }, cors, 0);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, cors, 0, 502);
    }
  }
};

function json(obj, cors, maxAge, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store', ...cors }
  });
}

async function transcript(id) {
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Bad video id');
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 13) gzip' },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 33, hl: 'en', gl: 'US' } }, videoId: id })
  });
  const d = await r.json();
  const tracks = (d.captions && d.captions.playerCaptionsTracklistRenderer && d.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  if (!tracks.length) throw new Error('No captions available for this video');
  const t = tracks.find(x => x.languageCode === 'en' && !x.kind) || tracks.find(x => (x.languageCode || '').startsWith('en')) || tracks[0];
  const res = await fetch(t.baseUrl + (t.baseUrl.includes('fmt=') ? '' : '&fmt=json3'));
  const j = await res.json();
  const segments = (j.events || []).filter(e => e.segs).map(e => ({
    start: (e.tStartMs || 0) / 1000,
    dur: (e.dDurationMs || 0) / 1000,
    text: e.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim()
  })).filter(s => s.text);
  const vd = d.videoDetails || {};
  return { videoId: id, language: t.languageCode, auto: t.kind === 'asr', title: vd.title || '', live: !!vd.isLive, segments };
}

async function article(target) {
  let u;
  try { u = new URL(target); } catch { throw new Error('Bad URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith('.internal')) throw new Error('Blocked address');
  const r = await fetch(u.toString(), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; VeritasBot/1.0)', accept: 'text/html' }, redirect: 'follow' });
  if (!r.ok) throw new Error('Page returned ' + r.status);
  let html = await r.text();
  html = html.slice(0, 1500000);
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  html = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(p => p.split(' ').length >= 8);
  if (!paras.length) throw new Error('Could not find article text');
  return { url: u.toString(), title: decode(title), paragraphs: paras.slice(0, 120) };
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
