// Veritas service: one small Cloudflare Worker (free tier is plenty).
//
//   GET /                        -> health check (shows what is configured)
//   GET /transcript?v=VIDEO_ID   -> YouTube captions as timed segments
//   GET /article?url=https://…   -> readable text of a web article
//   GET /deepgram-token          -> short-lived key so the browser can stream tab audio to Deepgram
//   POST /judge                  -> researches one claim and returns a verdict + truth score. Default (free): a small open-weights model
//                                   (Llama 3.1 8B on Workers AI) that extracts the claim, retrieves evidence and judges only from it (RAG).
//                                   Order: ANTHROPIC_API_KEY (web search) > RAG (binding AI or GROQ_API_KEY) > GEMINI_API_KEY > Groq+Wikipedia.
//                                   JUDGE_ENGINE=rag|gemini|anthropic|groq forces one.
//   GET /social?url=https://tiktok.com/…  -> TikTok caption/author and short-link resolution (no key needed)
//   POST /transcribe             -> speech to text for one short audio chunk (WAV body). Free hosted Whisper:
//                                   Groq first (GROQ_API_KEY), then Cloudflare Workers AI (binding named AI)
//
// Settings (Worker > Settings > Variables and Secrets):
//   GROQ_API_KEY      (Secret)  free Whisper large-v3-turbo from console.groq.com (no card needed)
//   GROQ_WHISPER_MODEL (Text)   optional: whisper-large-v3 (more accurate, slower) instead of the default whisper-large-v3-turbo
//   TAVILY_API_KEY    (Secret)  optional: free web search (1,000/month, no card) from tavily.com; makes the RAG checker much stronger
//   RAG_MODEL         (Text)    optional Workers AI model for the RAG checker (default @cf/meta/llama-3.1-8b-instruct-fp8-fast)
//   GROQ_LLM_MODEL    (Text)    optional Groq fallback model for the RAG checker (default openai/gpt-oss-20b)
//   AI                (Binding) Workers AI: runs the RAG checker's model (and is a Whisper backup): Settings > Bindings > Add > Workers AI, variable name AI
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
      return json({ ok: true, groq: !!env.GROQ_API_KEY, workersAi: !!(env.AI && env.AI.run), deepgram: !!env.DEEPGRAM_API_KEY, supadata: !!env.SUPADATA_API_KEY, anthropic: !!env.ANTHROPIC_API_KEY, gemini: !!env.GEMINI_API_KEY, judge: judgeEngine(env), search: env.TAVILY_API_KEY ? 'tavily+factcheck.org+wikipedia' : 'factcheck.org+wikipedia', ragModel: ragReady(env) ? ((env.AI && env.AI.run ? (env.RAG_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8-fast') : (env.GROQ_LLM_MODEL || 'openai/gpt-oss-20b'))) : '', originLocked: allowed !== '*', routes: ['/transcript?v=', '/article?url=', '/deepgram-token', 'POST /judge', 'POST /transcribe', '/social?url='] }, cors, 0);
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

function normTxt(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
async function transcribe(req, url, env) {
  if (!env.GROQ_API_KEY && !(env.AI && env.AI.run)) {
    throw httpError(501, 'No speech service is set up. Add GROQ_API_KEY (or a Workers AI binding named AI) to the worker');
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 1000) throw httpError(400, 'Audio chunk is empty');
  if (buf.byteLength > MAX_AUDIO_BYTES) throw httpError(413, 'Audio chunk is too large');
  const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
  // Context for Whisper: the video title and the words just before this chunk. It keeps names, spelling and sentences consistent.
  const prompt = (url.searchParams.get('p') || '').replace(/\s+/g, ' ').trim().slice(-400);
  const finish = r => { const n = normTxt(r.text), pn = normTxt(prompt); if (pn && n.length >= 15 && pn.includes(n)) r.text = ''; return r; };   // Whisper sometimes just repeats the prompt over silence
  const errors = [];
  if (env.GROQ_API_KEY) {
    try { return { ...finish(await viaGroq(buf, lang, env.GROQ_API_KEY, prompt, env.GROQ_WHISPER_MODEL)), via: 'groq' }; }
    catch (e) { errors.push('groq: ' + (e.message || e)); if (!(env.AI && env.AI.run)) throw httpError(e.status || 502, errors.join('; '), e.retryAfter); }
  }
  try { return { ...finish(await viaWorkersAi(buf, lang, env.AI, prompt)), via: 'workers-ai', fallback: errors.length ? errors[0] : '' }; }
  catch (e) { errors.push('workers-ai: ' + (e.message || e)); throw httpError(e.status || 502, errors.join('; ')); }
}

function httpError(status, message, retryAfter) { const e = new Error(message); e.status = status; if (retryAfter) e.retryAfter = retryAfter; return e; }

// Whisper sometimes invents text during silence or music. Groq returns per-segment confidence; drop the doubtful ones.
function keepSegment(s) {
  if ((s.no_speech_prob || 0) > 0.6 && (s.avg_logprob || 0) < -1) return false;   // probably silence
  if ((s.compression_ratio || 0) > 2.4) return false;                              // probably a repetition loop
  return true;
}

async function viaGroq(buf, lang, key, prompt, model) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'chunk.wav');
  fd.append('model', model || 'whisper-large-v3-turbo');
  if (prompt) fd.append('prompt', prompt);
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

async function viaWorkersAi(buf, lang, ai, prompt) {
  const bytes = new Uint8Array(buf);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const out = await ai.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(bin), language: lang, task: 'transcribe', ...(prompt ? { initial_prompt: prompt } : {}) });
  const segs = out && Array.isArray(out.segments) ? out.segments : null;
  const text = segs ? segs.filter(keepSegment).map(s => s.text).join(' ') : ((out && out.text) || '');
  return { text: text.replace(/\s+/g, ' ').trim() };
}

/* ---------- Truth score (0-100) shared by every judge ----------
   The model proposes a score; we clamp it into the band of its verdict so card colour, label and percentage always agree.
   TRUE 75-98 (green), MISLEADING 35-74 (orange), FALSE 2-34 (red). No AI check is ever shown as 0 or 100. Rounded to 5. */
const BANDS = { TRUE: [75, 98], MISLEADING: [35, 74], FALSE: [2, 34] };
function scoreFor(verdict, raw) {
  const b = BANDS[verdict]; if (!b) return null;
  let n = Number(raw); if (!isFinite(n)) n = (b[0] + b[1]) / 2;
  return Math.min(b[1], Math.max(b[0], Math.round(n / 5) * 5));
}
// Common clean-up: valid verdict, capped confidence, low confidence => no verdict.
function finalizeJudgment(out, engine, maxConfidence) {
  let verdict = ['TRUE', 'MISLEADING', 'FALSE', 'UNVERIFIABLE'].includes(out.verdict) ? out.verdict : 'UNVERIFIABLE';
  let confidence = ['high', 'medium', 'low'].includes(out.confidence) ? out.confidence : 'low';
  if (maxConfidence === 'medium' && confidence === 'high') confidence = 'medium';
  let explanation = String(out.explanation || '').slice(0, 500);
  if (verdict !== 'UNVERIFIABLE' && confidence === 'low') { explanation = 'Low confidence, so no verdict. ' + explanation; verdict = 'UNVERIFIABLE'; }
  return { verdict, confidence, explanation, score: scoreFor(verdict, out.score), standalone: String(out.standalone || '').replace(/\s+/g, ' ').slice(0, 300), engine };
}

/* ---------- Gemini (free key from aistudio.google.com) ----------
   Tries Google-Search-grounded answers first (real sources). If the key/project is not allowed to ground, falls back to a
   knowledge-only answer, which is labelled as such and never counted with high confidence. */
const GEMINI_PROMPT = (today, grounded) => `You are a careful, neutral fact-checker. Today is ${today}.
You get ONE claim from an automatically transcribed political broadcast (names and numbers may be misheard).
${grounded ? 'Use Google Search. Prefer primary and official sources (government data, court records, official statements), then established fact-checkers (FactCheck.org first, then AP, Reuters, PolitiFact, Snopes, Full Fact), then reputable news. Watch the time period and the exact wording.'
  : 'You cannot search the web. Judge only from stable facts you are sure about. For recent events, latest figures, or anything you are unsure of, answer UNVERIFIABLE.'}
Opinions, predictions and rhetoric are NOT checkable: answer UNVERIFIABLE.
TRUE = accurate. MISLEADING = partly true, missing important context, or framed to give a wrong impression. FALSE = contradicted by reliable evidence. Prefer UNVERIFIABLE over a weak FALSE.
"score" is how accurate the claim is, 0 to 100 (100 = fully accurate), and must agree with the verdict: TRUE 75-98, MISLEADING 35-74, FALSE 2-34.
Reply with ONLY a JSON object, no other text:
{"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":"high|medium|low","score":0,"standalone":"","explanation":"one or two plain sentences naming the key figure or source"}
CONTEXT: you also get the video title and the statements spoken just BEFORE and AFTER the claim. Use them to work out who "they", "he", "it" or "that" refers to, which time period and place are meant, and what the speaker actually means. Judge the claim as the speaker meant it in context, not as an isolated string. If the context shows it is a question, a joke, a hypothetical, or the speaker quoting or describing someone else's claim, answer UNVERIFIABLE and say why.
"standalone" is the claim rewritten so it makes sense on its own (names instead of pronouns, the time period filled in), in at most 40 words. Do not add facts the speaker did not say.`;

async function geminiJudge(body, env) {
  const claim = String((body && body.claim) || '').slice(0, 600);
  if (claim.split(/\s+/).length < 4) throw new Error('Claim is too short');
  const context = String((body && body.context) || '').slice(0, 1400);
  const today = /^\d{4}-\d{2}-\d{2}$/.test((body && body.today) || '') ? body.today : new Date().toISOString().slice(0, 10);
  const plan = [];
  if (env.GEMINI_GROUNDED_MODEL !== 'off') plan.push({ model: env.GEMINI_GROUNDED_MODEL || 'gemini-2.5-flash', search: true });
  plan.push({ model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite', search: false });
  let res = null, used = null, lastErr = '';
  for (const step of plan) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(step.model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEMINI_PROMPT(today, step.search) }] },
        contents: [{ role: 'user', parts: [{ text: `Claim: "${claim}"\n\nContext (video title, then statements before and after the claim): ${context || 'none'}` }] }],
        ...(step.search ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature: 0, maxOutputTokens: 1200 }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { res = j; used = step; break; }
    lastErr = step.model + ': HTTP ' + r.status + ' ' + ((j.error && j.error.message) || '').toString().slice(0, 120);
    if (![400, 403, 404, 429].includes(r.status)) throw httpError(502, 'Gemini: ' + lastErr);   // otherwise try the next option
    if (!step.search && r.status === 429) throw httpError(429, 'Gemini: ' + lastErr);
  }
  if (!res) throw httpError(502, 'Gemini: ' + lastErr);
  const cand = (res.candidates && res.candidates[0]) || {};
  const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The research step did not return a verdict');
  let out; try { out = JSON.parse(m[0]); } catch { throw new Error('The research step returned unreadable output'); }
  const chunks = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || []).map(c => c.web).filter(w => w && /^https?:\/\//.test(w.uri || ''));
  const grounded = used.search && chunks.length > 0;
  const seen = new Set();
  const sources = grounded ? chunks.filter(w => !seen.has(w.uri) && seen.add(w.uri)).slice(0, 3).map(w => ({ title: w.title || 'Source', url: w.uri })) : [];
  const done = finalizeJudgment(out, grounded ? 'gemini-grounded' : 'gemini-knowledge', grounded ? 'high' : 'medium');
  return { ...done, sources };
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
{"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":"high|medium|low","score":0,"standalone":"","explanation":"one or two plain sentences naming the evidence used","used":[1]}
"score" is how accurate the claim is, 0 to 100, and must agree with the verdict: TRUE 75-98, MISLEADING 35-74, FALSE 2-34.
CONTEXT: you also get the video title and the statements spoken just BEFORE and AFTER the claim. Use them to work out who "they", "he", "it" or "that" refers to, which time period and place are meant, and what the speaker actually means. Judge the claim as the speaker meant it in context, not as an isolated string. If the context shows it is a question, a joke, a hypothetical, or the speaker quoting or describing someone else's claim, answer UNVERIFIABLE and say why.
"standalone" is the claim rewritten so it makes sense on its own (names instead of pronouns, the time period filled in), in at most 40 words. Do not add facts the speaker did not say.`;

async function groqJudge(body, env) {
  const claim = String((body && body.claim) || '').slice(0, 600);
  if (claim.split(/\s+/).length < 4) throw new Error('Claim is too short');
  const today = /^\d{4}-\d{2}-\d{2}$/.test((body && body.today) || '') ? body.today : new Date().toISOString().slice(0, 10);
  const ev = await wikiEvidence(claim);
  if (!ev.length) return { verdict: 'UNVERIFIABLE', confidence: 'low', explanation: 'No encyclopedia article matched this claim, so there was nothing to check it against.', score: null, sources: [], engine: 'groq-wikipedia' };
  const evidence = ev.map((e, i) => `[${i + 1}] ${e.title}: ${e.text}`).join('\n\n');
  const models = [...new Set([env.GROQ_JUDGE_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'].filter(Boolean))];
  let j = null, lastErr = '';
  for (const model of models) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 1500, messages: [{ role: 'system', content: GROQ_JUDGE_PROMPT(today) }, { role: 'user', content: `Claim: "${claim}"\n\nContext (video title, then statements before and after the claim): ${String((body && body.context) || '').slice(0, 1000) || 'none'}\n\nEVIDENCE:\n${evidence}` }] })
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
  const done = finalizeJudgment(out, 'groq-wikipedia', 'medium');
  const used = (Array.isArray(out.used) ? out.used : []).map(n => ev[n - 1]).filter(Boolean);
  const sources = (used.length ? used : ev.slice(0, 2)).slice(0, 3).map(e => ({ title: e.title + ' (Wikipedia)', url: e.url }));
  return { ...done, sources };
}

/* ---------- Free RAG fact-check pipeline (small open-weights model + retrieval) ----------
   1. ANALYZE  (small model): is this a checkable factual claim? Rewrite it so it stands alone, using the surrounding statements, and write search queries.
   2. RETRIEVE (no model): published fact-check reviews sent by the browser, FactCheck.org's own search, Tavily web search limited to trusted outlets
               (if TAVILY_API_KEY is set), and Wikipedia for background facts.
   3. VERDICT  (small model): judge ONLY from the numbered evidence and return strict JSON with the evidence it used. The Worker then checks that
               the cited evidence exists; a verdict that cites nothing becomes UNVERIFIABLE.
   Model: Cloudflare Workers AI (binding AI), default Llama 3.1 8B, free daily allowance. Fallback: Groq (GROQ_LLM_MODEL, default openai/gpt-oss-20b). */
const TRUSTED_DOMAINS = ['factcheck.org', 'politifact.com', 'apnews.com', 'reuters.com', 'snopes.com', 'fullfact.org', 'usafacts.org', 'cbo.gov', 'bls.gov', 'census.gov', 'bea.gov', 'federalreserve.gov', 'congress.gov', 'gao.gov', 'cdc.gov', 'fbi.gov', 'pewresearch.org', 'npr.org', 'bbc.com'];
const stripTags = s => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function llmJson(env, system, user, maxTokens) {
  const errs = [];
  const parse = t => {
    if (t && typeof t === 'object') return t;
    const m = String(t || '').match(/\{[\s\S]*\}/); if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  };
  if (env.AI && env.AI.run) {
    const model = env.RAG_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
    try {
      const r = await env.AI.run(model, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0 });
      const raw = r && (r.response !== undefined ? r.response : (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content));
      const out = parse(raw);
      if (out) return { out, model: model.split('/').pop() };
      errs.push(model + ' returned unreadable output');
    } catch (e) { errs.push(model + ': ' + String((e && e.message) || e).slice(0, 120)); }
  }
  if (env.GROQ_API_KEY) {
    const model = env.GROQ_LLM_MODEL || 'openai/gpt-oss-20b';
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, max_tokens: Math.max(maxTokens, 1500), response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { const out = parse(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content); if (out) return { out, model: model.split('/').pop() }; errs.push(model + ' returned unreadable output'); }
      else errs.push(model + ': HTTP ' + r.status);
    } catch (e) { errs.push(model + ': ' + String((e && e.message) || e).slice(0, 100)); }
  }
  throw httpError(502, 'No small model answered. ' + (errs.join('; ') || 'Add the Workers AI binding named AI, or GROQ_API_KEY.'));
}

const ANALYZE_PROMPT = today => `You prepare ONE statement from an automatically transcribed political video for fact-checking. Today is ${today}.
Reply with ONLY a JSON object: {"checkable":true,"kind":"fact","standalone":"","queries":["",""]}
- checkable is true ONLY for a specific statement about the past or present that evidence could confirm or refute: a number, record, date, event, official action, quote, law, or public fact.
- checkable is false for opinions, predictions (anything about what will or might happen, or how likely something is), promises, slogans, insults, jokes, questions, vague statements, a speaker explaining their own reasons, motives or feelings ("I did this because I thought..."), and a speaker describing what someone else claims. Set "kind" to opinion, prediction, question, quote or vague.
- "standalone": rewrite the statement so it makes sense on its own, keeping its exact meaning, using the surrounding statements: names instead of he/she/they/it/that, the time period and place filled in. At most 40 words. Never add a fact the speaker did not say.
- "queries": two short web search queries (under 12 words each) a fact-checker would type. Use names, figures and years. Make the second one end with "fact check".`;

const VERDICT_PROMPT = today => `You are a careful, neutral fact-checker. Today is ${today}.
You get ONE claim and numbered EVIDENCE items. Judge the claim ONLY from the evidence. Do not use memory.
- A published fact-check counts only if it is about the SAME claim (same person, figure and time period). Otherwise ignore it.
- Official data and news reports count only if they directly state the figure or event in the claim. Check the dates: old evidence does not prove a current figure.
- TRUE: the evidence confirms the whole claim. FALSE: the evidence clearly contradicts it. MISLEADING: partly right, but missing important context or framed to give a wrong impression.
- If the evidence does not directly address the claim, answer UNVERIFIABLE. Prefer UNVERIFIABLE over a guess.
- ABSENCE OF EVIDENCE IS NOT FALSE. If the evidence merely does not mention the claim, the answer is UNVERIFIABLE, never FALSE. FALSE needs an evidence item that states the opposite. TRUE needs an item that states the same thing.
- Judge the claim as worded. Do not turn it into a different claim.
- "quote": copy a short passage (under 25 words) EXACTLY from the evidence that supports your verdict. It is required for TRUE, MISLEADING and FALSE.
- "score" is how accurate the claim is, 0 to 100, and must agree: TRUE 75-98, MISLEADING 35-74, FALSE 2-34.
- "used" lists the numbers of the evidence items your verdict rests on. A verdict with an empty "used" is not allowed.
Reply with ONLY a JSON object: {"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":"high|medium|low","score":0,"quote":"","explanation":"one or two plain sentences naming the figures or sources","used":[1]}`;

async function tavilySearch(query, key, domains) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ query: query.slice(0, 380), search_depth: 'basic', max_results: 5, include_answer: false, ...(domains ? { include_domains: domains } : { exclude_domains: ['facebook.com', 'x.com', 'twitter.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'youtube.com'] }) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Tavily HTTP ' + r.status);
  return (j.results || []).filter(x => x && /^https?:\/\//.test(x.url || '')).map(x => ({ title: String(x.title || '').slice(0, 140), url: x.url, text: String(x.content || '').replace(/\s+/g, ' ').slice(0, 520), date: String(x.published_date || '').slice(0, 10), src: 'web' }));
}
// FactCheck.org is a WordPress site, so its public search endpoint needs no key.
async function factCheckOrgSearch(query) {
  const r = await fetch('https://www.factcheck.org/wp-json/wp/v2/posts?per_page=4&_fields=link,title,excerpt,date&search=' + encodeURIComponent(query.slice(0, 200)), { headers: { 'user-agent': WIKI_UA, accept: 'application/json' } });
  if (!r.ok) throw new Error('FactCheck.org HTTP ' + r.status);
  const a = await r.json().catch(() => []);
  return (Array.isArray(a) ? a : []).map(p => ({ title: stripTags(p.title && p.title.rendered).slice(0, 140), url: p.link, text: stripTags(p.excerpt && p.excerpt.rendered).slice(0, 520), date: String(p.date || '').slice(0, 10), src: 'factcheck.org' })).filter(x => x.url);
}

async function gatherEvidence(env, standalone, queries, reviews) {
  const items = [], notes = [];
  (Array.isArray(reviews) ? reviews : []).slice(0, 3).forEach(v => {
    if (v && /^https?:\/\//.test(v.url || '')) items.push({ title: `${String(v.publisher || 'Fact-checker').slice(0, 40)} review`, url: v.url, src: 'review',
      text: `Published fact-check (rating: “${String(v.rating || 'n/a').slice(0, 40)}”) of this claim: “${String(v.claim || '').slice(0, 300)}”` });
  });
  const q1 = queries[0] || standalone, q2 = queries[1] || (standalone + ' fact check');
  const jobs = [factCheckOrgSearch(q1), wikiEvidence(standalone).then(ev => ev.slice(0, 2).map(e => ({ title: e.title + ' (Wikipedia)', url: e.url, text: e.text.slice(0, 500), src: 'wikipedia' })))];
  if (env.TAVILY_API_KEY) {
    jobs.push(tavilySearch(q2, env.TAVILY_API_KEY, TRUSTED_DOMAINS).then(async r => r.length >= 2 ? r : r.concat(await tavilySearch(q1, env.TAVILY_API_KEY, null))));
  }
  const res = await Promise.allSettled(jobs);
  res.forEach(r => { if (r.status === 'fulfilled') items.push(...r.value); else notes.push(String(r.reason && r.reason.message || r.reason).slice(0, 80)); });
  const seen = new Set(), out = [];
  for (const it of items) { if (!it.text || seen.has(it.url)) continue; seen.add(it.url); out.push(it); if (out.length >= 8) break; }
  return { evidence: out, notes };
}

// Cheap rules that catch what a small model gets wrong: predictions and a speaker's own motives are not checkable facts.
const FUTURE_RE = /\b(will|won'?t|will not|going to|gonna|probabilit\w*|likelihood|likely to|chances? (?:are|of)|predict\w*|expect(?:s|ed)? to)\b/i;
const MOTIVE_RE = /\b(i|we) (?:think|thought|believe|believed|feel|felt|hope|wish|want|wanted|disagree\w*|guess)\b/i;
function preFilter(claim) { return FUTURE_RE.test(claim) ? 'prediction' : MOTIVE_RE.test(claim) ? 'opinion' : ''; }
const ABSENCE_RE = /\b(?:does not|doesn'?t|did not|didn'?t|do not|don'?t|no|nor|without|not)\s+(?:\w+\s+){0,2}(?:mention|mentions|address|addresses|state|states|say|says|provide|provides|contain|contains|show|shows|support|supports|confirm|confirms|include|includes|specify|specifies)\b|\bno (?:direct |clear |explicit )?(?:evidence|mention|information|source)|\bnot (?:directly )?(?:addressed|mentioned|supported|stated)\b/i;
const tokSet = t => new Set(normTxt(t).split(' ').filter(w => w.length > 2));
function quoteSupported(quote, items) {
  const q = [...tokSet(quote)]; if (q.length < 3) return false;
  return items.some(e => { const T = tokSet(e.title + ' ' + e.text); return q.filter(w => T.has(w)).length / q.length >= 0.8; });
}

async function ragJudge(body, env) {
  const claim = String((body && body.claim) || '').slice(0, 600);
  if (claim.split(/\s+/).length < 4) throw new Error('Claim is too short');
  const context = String((body && body.context) || '').slice(0, 1400);
  const today = /^\d{4}-\d{2}-\d{2}$/.test((body && body.today) || '') ? body.today : new Date().toISOString().slice(0, 10);
  const pre = preFilter(claim);
  if (pre) return { verdict: 'UNVERIFIABLE', confidence: 'low', explanation: `Not a checkable factual claim (${pre}).`, score: null, standalone: claim, sources: [], engine: 'rag', skip: true };
  // 1. analyze
  const a = await llmJson(env, ANALYZE_PROMPT(today), `Statement: "${claim}"\n\nContext (video title, then statements before and after): ${context || 'none'}`, 400);
  const standalone = String(a.out.standalone || claim).replace(/\s+/g, ' ').trim().slice(0, 300) || claim;
  if (a.out.checkable === false || a.out.checkable === 'false') {
    const kind = String(a.out.kind || 'opinion').replace(/[^a-z ]/gi, '').slice(0, 20) || 'opinion';
    return { verdict: 'UNVERIFIABLE', confidence: 'low', explanation: `Not a checkable factual claim (${kind}).`, score: null, standalone, sources: [], engine: 'rag', skip: true };
  }
  const queries = (Array.isArray(a.out.queries) ? a.out.queries : []).map(q => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 140)).filter(Boolean).slice(0, 2);
  // 2. retrieve
  const { evidence, notes } = await gatherEvidence(env, standalone, queries, body && body.reviews);
  if (!evidence.length) return { verdict: 'UNVERIFIABLE', confidence: 'low', explanation: 'No sources were found for this claim' + (notes.length ? ' (' + notes.join('; ') + ')' : '') + '.', score: null, standalone, sources: [], engine: 'rag' };
  // 3. verdict
  const ev = evidence.map((e, i) => `[${i + 1}] ${e.title}${e.date ? ' (' + e.date + ')' : ''} <${new URL(e.url).hostname.replace(/^www\./, '')}>: ${e.text}`).join('\n\n');
  const v = await llmJson(env, VERDICT_PROMPT(today), `Claim: "${standalone}"\n\nSurrounding statements, for meaning only: ${context.slice(0, 700) || 'none'}\n\nEVIDENCE:\n${ev}`, 450);
  const used = [...new Set((Array.isArray(v.out.used) ? v.out.used : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= evidence.length))];
  const out = { ...v.out };
  out.verdict = String(out.verdict || '').toUpperCase();
  const decided = ['TRUE', 'MISLEADING', 'FALSE'].includes(out.verdict);
  const cited = used.map(n => evidence[n - 1]);
  if (decided && !used.length) { out.verdict = 'UNVERIFIABLE'; out.explanation = 'The model gave a verdict without citing any evidence, so it was discarded.'; }
  else if (decided && ABSENCE_RE.test(String(out.explanation || ''))) { out.verdict = 'UNVERIFIABLE'; out.explanation = 'The sources found do not directly address this claim, so it could not be verified.'; }
  else if (decided && !quoteSupported(out.quote, cited)) { out.verdict = 'UNVERIFIABLE'; out.explanation = 'The model could not point to wording in the sources that supports its verdict, so it was discarded.'; }
  out.standalone = standalone;
  const done = finalizeJudgment(out, 'rag:' + v.model + (env.TAVILY_API_KEY ? '+web' : ''), 'medium');
  const pick = used.length ? used.map(n => evidence[n - 1]) : evidence.slice(0, 2);
  return { ...done, sources: pick.slice(0, 3).map(e => ({ title: e.title, url: e.url })) };
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
2. If checkable, search the web. Prefer primary and official sources (government data, court records, official statements) and established fact-checkers (FactCheck.org first, then PolitiFact, Snopes, AP, Reuters, Full Fact), then reputable news organizations. Judge only on the evidence you found, and watch the time period and the exact wording of the claim.
3. Verdicts: TRUE = accurate; MISLEADING = partly true, missing important context, or framed in a way that gives a wrong impression; FALSE = contradicted by reliable evidence; UNVERIFIABLE = not enough reliable evidence, or not checkable. Prefer UNVERIFIABLE over a weak FALSE.

Reply with ONLY a JSON object, no other text:
{"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":"high|medium|low","score":0,"standalone":"","explanation":"one or two plain sentences naming the key figure or source","sources":[{"title":"","url":""}]}
"score" is how accurate the claim is, 0 to 100 (100 = fully accurate), and must agree with the verdict: TRUE 75-98, MISLEADING 35-74, FALSE 2-34.
Use at most 3 sources, taken from your search.
CONTEXT: you also get the video title and the statements spoken just BEFORE and AFTER the claim. Use them to work out who "they", "he", "it" or "that" refers to, which time period and place are meant, and what the speaker actually means. Judge the claim as the speaker meant it in context, not as an isolated string. If the context shows it is a question, a joke, a hypothetical, or the speaker quoting or describing someone else's claim, answer UNVERIFIABLE and say why.
"standalone" is the claim rewritten so it makes sense on its own (names instead of pronouns, the time period filled in), in at most 40 words. Do not add facts the speaker did not say.`;

const ragReady = env => !!((env.AI && env.AI.run) || env.GROQ_API_KEY);
function judgeEngine(env) {
  const f = String(env.JUDGE_ENGINE || '').toLowerCase();
  if (['rag', 'gemini', 'anthropic', 'groq'].includes(f)) return f;
  return env.ANTHROPIC_API_KEY ? 'anthropic' : ragReady(env) ? 'rag' : env.GEMINI_API_KEY ? 'gemini' : env.GROQ_API_KEY ? 'groq' : '';
}
async function judge(body, env) {
  const eng = judgeEngine(env);
  if (eng === 'rag') {
    try { return await ragJudge(body, env); }
    catch (e) { if (env.GEMINI_API_KEY && !env.JUDGE_ENGINE) return geminiJudge(body, env); throw e; }   // safety net only
  }
  if (eng === 'gemini') return geminiJudge(body, env);   // free tier, Google Search when allowed
  if (eng === 'groq') return groqJudge(body, env);       // free, Wikipedia excerpts only
  if (eng !== 'anthropic' || !env.ANTHROPIC_API_KEY) throw new Error('No claim-research engine is set on the worker (add the Workers AI binding named AI, or GEMINI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY)');
  const claim = String((body && body.claim) || '').slice(0, 600);
  if (claim.split(/\s+/).length < 4) throw new Error('Claim is too short');
  const context = String((body && body.context) || '').slice(0, 1400);
  const today = /^\d{4}-\d{2}-\d{2}$/.test((body && body.today) || '') ? body.today : new Date().toISOString().slice(0, 10);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.JUDGE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 900,
      system: JUDGE_PROMPT(today),
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, blocked_domains: ['facebook.com', 'x.com', 'twitter.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'youtube.com'] }],
      messages: [{ role: 'user', content: `Claim: "${claim}"\n\nContext (video title, then statements before and after the claim): ${context || 'none'}` }]
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Anthropic returned ' + r.status));
  const blocks = j.content || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The research step did not return a verdict');
  let out; try { out = JSON.parse(m[0]); } catch { throw new Error('The research step returned unreadable output'); }
  const done = finalizeJudgment(out, 'anthropic-web', 'high');
  let sources = (Array.isArray(out.sources) ? out.sources : []).filter(s => s && /^https?:\/\//.test(s.url || '')).slice(0, 3);
  if (!sources.length) { // fall back to what the search actually returned
    const seen = new Set();
    blocks.filter(b => b.type === 'web_search_tool_result' && Array.isArray(b.content)).forEach(b => b.content.forEach(x => {
      if (x.url && !seen.has(x.url) && sources.length < 3) { seen.add(x.url); sources.push({ title: x.title || '', url: x.url }); }
    }));
  }
  return { ...done, sources };
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
