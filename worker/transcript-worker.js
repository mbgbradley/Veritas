// Veritas service: one small Cloudflare Worker (free tier is plenty).
//
//   GET /                        -> health check (shows what is configured)
//   GET /transcript?v=VIDEO_ID   -> YouTube captions as timed segments
//   GET /article?url=https://…   -> readable text of a web article
//   GET /deepgram-token          -> short-lived key so the browser can stream tab audio to Deepgram
//   POST /judge                  -> researches one claim on the web and returns a verdict (needs ANTHROPIC_API_KEY)
//   GET /social?url=https://tiktok.com/…  -> TikTok caption/author and short-link resolution (no key needed)
//   POST /transcribe             -> speech to text for one short audio chunk (WAV body). Free hosted Whisper:
//                                   Groq first (GROQ_API_KEY), then Cloudflare Workers AI (binding named AI)
//
// Settings (Worker > Settings > Variables and Secrets):
//   GROQ_API_KEY      (Secret)  free Whisper large-v3-turbo from console.groq.com (no card needed)
//   AI                (Binding) optional backup: Settings > Bindings > Add > Workers AI, variable name AI
//   SUPADATA_API_KEY  (Secret)  recommended: a hosted transcript provider. YouTube often blocks Cloudflare's
//                               servers, so reading captions directly can fail; this route avoids that.
//   ANTHROPIC_API_KEY (Secret)  lets Veritas research and judge claims no fact-checker has covered
//   JUDGE_MODEL       (Text)    optional model name for /judge (default claude-sonnet-5-5)
//   DEEPGRAM_API_KEY  (Secret)  needed only for live tab-audio capture
//   ALLOWED_ORIGIN    (Text)    your site, e.g. https://yourname.github.io  (recommended)
//
// IMPORTANT
// - YouTube has no official API for reading captions of videos you do not own. /transcript reads the same
//   public caption tracks the YouTube player uses. It is unofficial, may stop working when YouTube changes
//   things, and may conflict with YouTube's Terms of Service. Review them before running this publicly.
// - Not tested against live YouTube or Deepgram from the build environment. Use the Test button in Veritas
//   Settings (or open /transcript?v=… in a browser) to confirm it works for you.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = env.ALLOWED_ORIGIN || '*';
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed === '*' ? '*' : allowed,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    // When ALLOWED_ORIGIN is set, refuse browser calls from any other site.
    if (allowed !== '*' && origin && origin !== allowed) return json({ error: 'Origin not allowed' }, cors, 0, 403);
    try {
      if (url.pathname === '/transcript') return json(await transcript(url.searchParams.get('v'), env), cors, 60);
      if (url.pathname === '/article') return json(await article(url.searchParams.get('url')), cors, 300);
      if (url.pathname === '/deepgram-token') return json(await deepgramToken(env), cors, 0);
      if (url.pathname === '/judge' && req.method === 'POST') return json(await judge(await req.json(), env), cors, 0);
      if (url.pathname === '/social') return json(await social(url.searchParams.get('url')), cors, 300);
      if (url.pathname === '/transcribe' && req.method === 'POST') return json(await transcribe(req, url, env), cors, 0);
      return json({ ok: true, groq: !!env.GROQ_API_KEY, workersAi: !!(env.AI && env.AI.run), deepgram: !!env.DEEPGRAM_API_KEY, supadata: !!env.SUPADATA_API_KEY, anthropic: !!env.ANTHROPIC_API_KEY, judge: env.ANTHROPIC_API_KEY ? 'anthropic' : (env.GROQ_API_KEY ? 'groq' : ''), originLocked: allowed !== '*', routes: ['/transcript?v=', '/article?url=', '/deepgram-token', 'POST /judge', 'POST /transcribe', '/social?url='] }, cors, 0);
    } catch (e) {
      const status = (e && e.status) || 502;
      return json({ error: String((e && e.message) || e), retryAfter: (e && e.retryAfter) || 0 }, cors, 0, status);
    }
  }
};

function json(obj, cors, maxAge, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store', ...cors }
  });
}

/* ---------- Deepgram: mint a short-lived token ---------- */
async function deepgramToken(env) {
  if (!env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY is not set on the worker');
  const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: { Authorization: 'Token ' + env.DEEPGRAM_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 120 })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.err_msg || j.message || ('Deepgram returned ' + r.status));
  return { token: j.access_token };
}

/* ---------- Speech to text: free hosted Whisper (Groq, then Cloudflare Workers AI) ---------- */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;   // a 12 s, 16 kHz, 16-bit mono chunk is about 380 KB

async function transcribe(req, url, env) {
  if (!env.GROQ_API_KEY && !(env.AI && env.AI.run)) {
    throw httpError(501, 'No speech service is set up. Add GROQ_API_KEY (or a Workers AI binding named AI) to the worker');
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 1000) throw httpError(400, 'Audio chunk is empty');
  if (buf.byteLength > MAX_AUDIO_BYTES) throw httpError(413, 'Audio chunk is too large');
  const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
  const errors = [];
  if (env.GROQ_API_KEY) {
    try { return { ...(await viaGroq(buf, lang, env.GROQ_API_KEY)), via: 'groq' }; }
    catch (e) { errors.push('groq: ' + (e.message || e)); if (!(env.AI && env.AI.run)) throw httpError(e.status || 502, errors.join('; '), e.retryAfter); }
  }
  try { return { ...(await viaWorkersAi(buf, lang, env.AI)), via: 'workers-ai', fallback: errors.length ? errors[0] : '' }; }
  catch (e) { errors.push('workers-ai: ' + (e.message || e)); throw httpError(e.status || 502, errors.join('; ')); }
}

function httpError(status, message, retryAfter) { const e = new Error(message); e.status = status; if (retryAfter) e.retryAfter = retryAfter; return e; }

// Whisper sometimes invents text during silence or music. Groq returns per-segment confidence; drop the doubtful ones.
function keepSegment(s) {
  if ((s.no_speech_prob || 0) > 0.6 && (s.avg_logprob || 0) < -1) return false;   // probably silence
  if ((s.compression_ratio || 0) > 2.4) return false;                              // probably a repetition loop
  return true;
}

async function viaGroq(buf, lang, key) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'chunk.wav');
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  fd.append('language', lang);
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status + ' ' + ((j.error && j.error.message) || '').toString().slice(0, 140));
    e.status = r.status === 429 ? 429 : 502;
    const ra = parseFloat(r.headers.get('retry-after') || ''); if (ra) e.retryAfter = ra;
    throw e;
  }
  const segs = Array.isArray(j.segments) ? j.segments : null;
  const text = segs ? segs.filter(keepSegment).map(s => s.text).join(' ') : (j.text || '');
  return { text: text.replace(/\s+/g, ' ').trim() };
}

async function viaWorkersAi(buf, lang, ai) {
  const bytes = new Uint8Array(buf);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const out = await ai.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(bin), language: lang, task: 'transcribe' });
  const segs = out && Array.isArray(out.segments) ? out.segments : null;
  const text = segs ? segs.filter(keepSegment).map(s => s.text).join(' ') : ((out && out.text) || '');
  return { text: text.replace(/\s+/g, ' ').trim() };
}

/* ---------- Free claim research: Groq model judging Wikipedia excerpts ----------
   Groq's built-in web-search models (Compound) were shut down on 21 Sept 2026, so this cannot browse the web.
   It fetches Wikipedia introductions for the claim and asks a Groq model to judge ONLY from them. It is deliberately
   cautious: anything it is not fairly sure about comes back UNVERIFIABLE. */
const WIKI_UA = 'VeritasFactCheck/1.0 (non-commercial demo project)';
async function wikiEvidence(claim) {
  const q = claim.replace(/[^\w\s$%.,'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
  const sr = await fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=3&srsearch=' + encodeURIComponent(q), { headers: { 'user-agent': WIKI_UA } });
  const sj = await sr.json().catch(() => ({}));
  const hits = (sj.query && sj.query.search) || [];
  if (!hits.length) return [];
  const er = await fetch('https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=1400&format=json&utf8=1&pageids=' + hits.map(h => h.pageid).join('|'), { headers: { 'user-agent': WIKI_UA } });
  const ej = await er.json().catch(() => ({}));
  const pages = (ej.query && ej.query.pages) || {};
  return hits.map(h => pages[h.pageid]).filter(p => p && p.extract)
    .map(p => ({ title: p.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_')), text: p.extract.replace(/\s+/g, ' ').trim() }));
}

const GROQ_JUDGE_PROMPT = today => `You are a careful, neutral fact-checker. Today is ${today}.
You get ONE claim from an automatically transcribed political video (names and numbers may be misheard) and numbered EVIDENCE excerpts from Wikipedia.
Rules:
- Use ONLY the evidence. Do not use memory or outside knowledge.
- Opinions, predictions, rhetoric, or claims whose specific figures, names or time period the evidence does not directly address: UNVERIFIABLE.
- Wikipedia introductions are often out of date for current events and latest figures. For those, answer UNVERIFIABLE.
- TRUE only if the evidence clearly confirms the whole claim. FALSE only if the evidence clearly contradicts it. MISLEADING if the evidence shows it is partly right but missing important context.
Reply with ONLY a JSON object, no other text:
{"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":"high|medium|low","explanation":"one or two plain sentences naming the evidence used","used":[1]}`;

async function groqJudge(body, env) {
  const claim = String((body && body.claim) || '').slice(0, 600);
  if (claim.split(/\s+/).length < 4) throw new Error('Claim is too short');
  const today = /^\d{4}-\d{2}-\d{2}$/.test((body && body.today) || '') ? body.today : new Date().toISOString().slice(0, 10);
  const ev = await wikiEvidence(claim);
  if (!ev.length) return { verdict: 'UNVERIFIABLE', confidence: 'low', explanation: 'No encyclopedia article matched this claim, so there was nothing to check it against.', sources: [], engine: 'groq-wikipedia' };
  const evidence = ev.map((e, i) => `[${i + 1}] ${e.title}: ${e.text}`).join('\n\n');
  const models = [...new Set([env.GROQ_JUDGE_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'].filter(Boolean))];
  let j = null, lastErr = '';
  for (const model of models) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 1500, messages: [{ role: 'system', content: GROQ_JUDGE_PROMPT(today) }, { role: 'user', content: `Claim: "${claim}"\n\nEVIDENCE:\n${evidence}` }] })
    });
    const out = await r.json().catch(() => ({}));
    if (r.ok) { j = out; break; }
    lastErr = 'HTTP ' + r.status + ' ' + ((out.error && out.error.message) || '').toString().slice(0, 120);
    if (r.status !== 400 && r.status !== 404) throw httpError(r.status === 429 ? 429 : 502, 'Groq judge: ' + lastErr);   // only try the next model if this one is unknown
  }
  if (!j) throw httpError(502, 'Groq judge: ' + lastErr);
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The research step did not return a verdict');
  let out; try { out = JSON.parse(m[0]); } catch { throw new Error('The research step returned unreadable output'); }
  let verdict = ['TRUE', 'MISLEADING', 'FALSE', 'UNVERIFIABLE'].includes(out.verdict) ? out.verdict : 'UNVERIFIABLE';
  const confidence = ['high', 'medium', 'low'].includes(out.confidence) ? out.confidence : 'low';
  let explanation = String(out.explanation || '').slice(0, 500);
  if (verdict !== 'UNVERIFIABLE' && confidence === 'low') { explanation = 'Low confidence, so no verdict. ' + explanation; verdict = 'UNVERIFIABLE'; }
  const used = (Array.isArray(out.used) ? out.used : []).map(n => ev[n - 1]).filter(Boolean);
  const sources = (used.length ? used : ev.slice(0, 2)).slice(0, 3).map(e => ({ title: e.title + ' (Wikipedia)', url: e.url }));
  return { verdict, confidence, explanation, sources, engine: 'groq-wikipedia' };
}

/* ---------- Social links: TikTok details (public oEmbed) and short-link resolution ---------- */
const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;
async function social(target) {
  let u; try { u = new URL(target); } catch { throw httpError(400, 'Bad URL'); }
  if (!/^https?:$/.test(u.protocol) || !TIKTOK_HOST.test(u.hostname)) throw httpError(400, 'Only TikTok links are looked up here');
  for (let i = 0; i < 4 && !/\/video\/\d+/.test(u.pathname); i++) {      // follow short links (vm.tiktok.com/…) by hand, staying on tiktok.com
    const r = await fetch(u.toString(), { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; VeritasBot/1.0)' } });
    const loc = r.headers.get('location'); if (!loc) break;
    const nu = new URL(loc, u); if (!TIKTOK_HOST.test(nu.hostname)) break;
    u = nu;
  }
  const canonical = u.origin + u.pathname;
  const idm = u.pathname.match(/\/video\/(\d+)/);
  let meta = {};
  try { const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(canonical)); if (r.ok) meta = await r.json(); } catch { /* optional */ }
  return { platform: 'tiktok', url: canonical, id: idm ? idm[1] : '', title: String(meta.title || ''), author: String(meta.author_name || ''), thumb: String(meta.thumbnail_url || '') };
}

/* ---------- Claim research: Claude with web search ---------- */
const JUDGE_PROMPT = (today) => `You are a careful, neutral fact-checker. Today is ${today}.
You are given ONE claim from an automatically transcribed political broadcast or video (the transcript may contain mistakes; use the context to interpret names and numbers).

1. Decide whether it is a checkable factual claim (statistics, records, dates, official actions, quotes, public facts, science). Opinions, predictions, rhetoric and vague statements are NOT checkable: answer UNVERIFIABLE and say so.
2. If checkable, search the web. Prefer primary and official sources (government data, court records, official statements) and established fact-checkers (PolitiFact, FactCheck.org, Snopes, AP, Reuters, Full Fact), then reputable news organizations. Judge only on the evidence you found, and watch the time period and the exact wording of the claim.
3. Verdicts: TRUE = accurate; MISLEADING = partly true, missing important context, or framed in a way that gives a wrong impression; FALSE = contradicted by reliable evidence; UNVERIFIABLE = not enough reliable evidence, or not checkable. Prefer UNVERIFIABLE over a weak FALSE.

Reply with ONLY a JSON object, no other text:
{"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":"high|medium|low","explanation":"one or two plain sentences naming the key figure or source","sources":[{"title":"","url":""}]}
Use at most 3 sources, taken from your search.`;

async function judge(body, env) {
  if (!env.ANTHROPIC_API_KEY && env.GROQ_API_KEY) return groqJudge(body, env);   // free, more limited
  if (!env.ANTHROPIC_API_KEY) throw new Error('No claim-research key is set on the worker (GROQ_API_KEY or ANTHROPIC_API_KEY)');
  const claim = String((body && body.claim) || '').slice(0, 600);
  if (claim.split(/\s+/).length < 4) throw new Error('Claim is too short');
  const context = String((body && body.context) || '').slice(0, 800);
  const today = /^\d{4}-\d{2}-\d{2}$/.test((body && body.today) || '') ? body.today : new Date().toISOString().slice(0, 10);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.JUDGE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 900,
      system: JUDGE_PROMPT(today),
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, blocked_domains: ['facebook.com', 'x.com', 'twitter.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'youtube.com'] }],
      messages: [{ role: 'user', content: `Claim: "${claim}"\n\nContext (video title and the lines just before it): ${context || 'none'}` }]
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Anthropic returned ' + r.status));
  const blocks = j.content || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The research step did not return a verdict');
  let out; try { out = JSON.parse(m[0]); } catch { throw new Error('The research step returned unreadable output'); }
  const verdict = ['TRUE', 'MISLEADING', 'FALSE', 'UNVERIFIABLE'].includes(out.verdict) ? out.verdict : 'UNVERIFIABLE';
  let sources = (Array.isArray(out.sources) ? out.sources : []).filter(s => s && /^https?:\/\//.test(s.url || '')).slice(0, 3);
  if (!sources.length) { // fall back to what the search actually returned
    const seen = new Set();
    blocks.filter(b => b.type === 'web_search_tool_result' && Array.isArray(b.content)).forEach(b => b.content.forEach(x => {
      if (x.url && !seen.has(x.url) && sources.length < 3) { seen.add(x.url); sources.push({ title: x.title || '', url: x.url }); }
    }));
  }
  return { verdict, confidence: out.confidence || '', explanation: String(out.explanation || '').slice(0, 500), sources };
}

/* ---------- YouTube captions ---------- */
async function transcript(id, env) {
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Bad video id');
  const errors = [];
  // The hosted provider goes first when configured, because direct access from Cloudflare is often blocked.
  const ways = [];
  if (env && env.SUPADATA_API_KEY) ways.push(() => viaSupadata(id, env.SUPADATA_API_KEY));
  ways.push(() => viaAndroid(id), () => viaWatchPage(id));
  const names = [env && env.SUPADATA_API_KEY ? 'supadata' : null, 'android', 'watch-page'].filter(Boolean);
  for (let i = 0; i < ways.length; i++) {
    try {
      const out = await ways[i]();
      if (out && out.segments && out.segments.length) return out;
      errors.push(names[i] + ': no caption text');
    } catch (e) { errors.push(names[i] + ': ' + (e.message || e)); }
  }
  throw new Error('No captions could be read (' + errors.join('; ') + ')' + (env && env.SUPADATA_API_KEY ? '' : '. Tip: add SUPADATA_API_KEY to the worker, see GUIDE-CLOUDFLARE.md'));
}

async function viaSupadata(id, apiKey) {
  const target = 'https://www.youtube.com/watch?v=' + id;
  const r = await fetch('https://api.supadata.ai/v1/transcript?url=' + encodeURIComponent(target) + '&mode=native', { headers: { 'x-api-key': apiKey } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 206) throw new Error('this video has no captions');
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (j.message || j.error || '').toString().slice(0, 100));
  const list = Array.isArray(j.content) ? j.content : [];
  const segments = list.map(c => ({
    start: (c.offset || 0) / 1000, dur: (c.duration || 0) / 1000,
    text: String(c.text || '').replace(/\s+/g, ' ').trim()
  })).filter(s => s.text);
  return { videoId: id, via: 'supadata', language: j.lang || 'en', auto: false, title: '', live: false, segments };
}

async function viaAndroid(id) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 13) gzip' },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 33, hl: 'en', gl: 'US' } }, videoId: id })
  });
  const raw = await r.text();
  let d; try { d = JSON.parse(raw); } catch { throw new Error('HTTP ' + r.status + ', not JSON: ' + raw.replace(/\s+/g, ' ').slice(0, 70)); }
  return fromPlayer(id, d, 'android');
}

async function viaWatchPage(id) {
  const r = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=en', {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI' }
  });
  const html = await r.text();
  if (/unusual traffic|confirm you.{0,10}not a bot|consent\.youtube/i.test(html)) throw new Error('YouTube is blocking this server (HTTP ' + r.status + ')');
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:var\s|<\/script>)/);
  if (!m) throw new Error('player data not found');
  return fromPlayer(id, JSON.parse(m[1]), 'watch-page');
}

async function fromPlayer(id, d, via) {
  const tracks = (d.captions && d.captions.playerCaptionsTracklistRenderer && d.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  if (!tracks.length) throw new Error('video has no captions');
  const t = tracks.find(x => x.languageCode === 'en' && !x.kind) || tracks.find(x => (x.languageCode || '').startsWith('en')) || tracks[0];
  const res = await fetch(t.baseUrl + (t.baseUrl.includes('fmt=') ? '' : '&fmt=json3'));
  const raw = await res.text();
  if (!raw) throw new Error('caption file was empty');
  const j = JSON.parse(raw);
  const segments = (j.events || []).filter(e => e.segs).map(e => ({
    start: (e.tStartMs || 0) / 1000,
    dur: (e.dDurationMs || 0) / 1000,
    text: e.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim()
  })).filter(s => s.text);
  const vd = d.videoDetails || {};
  return { videoId: id, via, language: t.languageCode, auto: t.kind === 'asr', title: vd.title || '', live: !!vd.isLive, segments };
}

/* ---------- Articles ---------- */
async function article(target) {
  let u;
  try { u = new URL(target); } catch { throw new Error('Bad URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith('.internal')) throw new Error('Blocked address');
  const r = await fetch(u.toString(), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; VeritasBot/1.0)', accept: 'text/html' }, redirect: 'follow' });
  if (!r.ok) throw new Error('Page returned ' + r.status);
  let html = (await r.text()).slice(0, 1500000);
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
