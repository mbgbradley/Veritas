/* Claim detection and tiered checking.
   Tier 1: Google Fact Check Tools (aggregates PolitiFact, Snopes, FactCheck.org, AP, Reuters, Full Fact and more).
   Tier 2: if no fact-checker matched, search a custom list of wire/center outlets (Programmable Search) for related reporting.
   Results are "related", never a ruling by Veritas. */
V.checker = (() => {
  const CLAIM_RE = /\d|\b(percent|million|billion|trillion|doubled|tripled|halved|record|highest|lowest|never|always|every|nobody|no one|none|more than|less than|fewer|increase[ds]?|decrease[ds]?|rose|fell|cut|raised|lowered|passed|voted|signed|since|according to|unemployment|inflation|deficit|crime|tax(?:es)?|cost|costs|killed|died|arrested|banned|approved|ruled|said|says|announced|ordered|rejected|won|lost|invaded|attacked|resigned|elected|appointed|charged|convicted|sentenced|created|launched|grew|dropped|climbed|collapsed|eliminated|created|funded|signed|vetoed|repealed|imposed)\b/i;
  const OPINION_RE = /^(i think|i feel|i believe|i hope|i guess|maybe|perhaps|we should|you should|let me|thank you|thanks|well,? |so,? |um|uh)\b/i;

  function isClaim(s) {
    s = s.trim();
    const wc = s.split(/\s+/).length;
    if (wc < 6 || s.endsWith('?') || OPINION_RE.test(s)) return false;
    if (CLAIM_RE.test(s) || V.flags.sentence(s).some(f => f.id === 'good')) return true;
    // a longer sentence naming someone or something specific mid-sentence is often a factual statement
    return wc >= 9 && /\s[A-Z][a-z]{2,}/.test(s.slice(1));
  }
  // Rank used to spend the checking budget on the most check-worthy sentences first.
  function priority(s) {
    let p = 0;
    if (/\d/.test(s)) p += 2;
    if (/\b(percent|million|billion|trillion|doubled|tripled|record|never|always|every|nobody)\b/i.test(s)) p += 2;
    if (/\s[A-Z][a-z]{2,}/.test(s.slice(1))) p += 1;
    p += V.flags.sentence(s).length;
    return p;
  }

  const STOP = new Set('the a an and or of to in on for is are was were be been it that this with as at by from has have had not but they we you i he she his her our their its will would can could do does did so if than then there here what which who about into over under more most very just also'.split(' '));
  const toks = s => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2 && !STOP.has(w));
  function sim(a, b) {
    const A = new Set(toks(a)), B = new Set(toks(b));
    if (!A.size || !B.size) return 0;
    let i = 0; A.forEach(w => B.has(w) && i++);
    return i / Math.min(A.size, B.size);
  }
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const matchHost = (h, list) => list.findIndex(x => h === x.host || h.endsWith('.' + x.host));

  function mapRating(r) {
    r = (r || '').toLowerCase();
    if (/mostly true|largely true|mostly accurate/.test(r)) return 'TRUE';
    if (/(partly|half|mixture|mixed|misleading|missing context|out of context|exaggerat|unproven|needs context|lacks context|distort|mostly false|mostly untrue|unsupported|cherry)/.test(r)) return 'MISLEADING';
    if (/(false|incorrect|fake|wrong|pants|no evidence|baseless|fabricated|not true|untrue|hoax|scam|satire)/.test(r)) return 'FALSE';
    if (/(true|correct|accurate|right|legit)/.test(r)) return 'TRUE';
    return 'MISLEADING';
  }

  // Published fact-check rating -> 0-100 truth score, then kept inside the band of its verdict so colour, label and % agree.
  function ratingScore(r) {
    r = (r || '').toLowerCase();
    if (/pants|fabricated|hoax/.test(r)) return 2;
    if (/mostly false|mostly untrue|largely false/.test(r)) return 20;
    if (/\b(false|incorrect|fake|wrong|baseless|not true|untrue|no evidence|scam|satire)/.test(r)) return 5;
    if (/mostly true|largely true|mostly accurate/.test(r)) return 85;
    if (/(half|mixture|mixed|partly|partially)/.test(r)) return 50;
    if (/(misleading|missing context|out of context|exaggerat|needs context|lacks context|distort|unsupported|cherry|unproven)/.test(r)) return 45;
    if (/(true|correct|accurate|right|legit)/.test(r)) return 95;
    return 45;
  }
  const BAND = { TRUE: [75, 100], MISLEADING: [35, 74], FALSE: [0, 34] };
  const bandScore = (verdict, n) => { const b = BAND[verdict]; return b && isFinite(n) ? Math.round(Math.min(b[1], Math.max(b[0], n))) : null; };

  const cache = new Map();
  // site: optional publisher filter (Google's reviewPublisherSiteFilter), e.g. 'factcheck.org'.
  async function factCheckSearch(text, site, simText) {
    const q = text.length > 220 ? text.slice(0, 220) : text;
    const r = await fetch(`https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(q)}&languageCode=en-US&pageSize=${site ? 5 : 8}${site ? '&reviewPublisherSiteFilter=' + encodeURIComponent(site) : ''}&key=${encodeURIComponent(V.settings.key)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message || 'Fact-check lookup failed');
    const hits = [];
    (j.claims || []).forEach(c => (c.claimReview || []).forEach(cr => hits.push({
      claim: c.text, claimant: c.claimant, publisher: cr.publisher && cr.publisher.name, url: cr.url, rating: cr.textualRating,
      sim: sim(simText || text, c.text || '')
    })));
    return hits;
  }
  async function reportingSearch(text) {
    const q = text.length > 180 ? text.slice(0, 180) : text;
    const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(V.settings.key)}&cx=${encodeURIComponent(V.settings.cx)}&num=4&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message || 'Search failed');
    return (j.items || []).map(i => {
      const h = host(i.link), idx = matchHost(h, V.config.sources), s = idx >= 0 ? V.config.sources[idx] : null;
      return { url: i.link, title: i.title, name: s ? s.name : h, bias: s ? s.bias : '', by: s ? s.by : '', sim: sim(text, (i.title || '') + ' ' + (i.snippet || '')) };
    }).filter(x => x.sim >= 0.35);
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let judgeLeft = V.config.judge.maxPerSession;
  const resetBudget = () => { judgeLeft = V.config.judge.maxPerSession; };
  const judgeOn = () => !!(V.settings.worker && V.info && (V.info.anthropic || V.info.judge));

  // ctx: a string, or a function (may be async) returning the surrounding statements. opts.lead: the sentence before, used to
  // search for claims that start with "they", "it", "that"... and would otherwise match nothing.
  async function check(text, ctx, opts) {
    const k = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (cache.has(k)) return cache.get(k);
    const p = (async () => {
      // Tier 1: published fact-checks
      if (V.settings.key) {
        // FactCheck.org is asked on its own (so its reviews are not crowded out), at the same time as every other publisher.
        const first = V.config.checkers[0] && V.config.checkers[0].host;
        const q = opts && opts.lead ? (opts.lead.slice(-100) + ' ' + text) : text;
        const [pri, all] = await Promise.all([
          first ? factCheckSearch(q, first, text).catch(() => []) : Promise.resolve([]),
          factCheckSearch(q, null, text)
        ]);
        const seenUrl = new Set();
        const hits = [...pri, ...all].filter(h => h.sim >= 0.5 && h.url && !seenUrl.has(h.url) && seenUrl.add(h.url));
        if (hits.length) {
          const rank = h => { const i = matchHost(host(h.url), V.config.checkers); return i < 0 ? 99 : i; };
          hits.sort((a, b) => rank(a) - rank(b) || b.sim - a.sim);
          const top3 = hits.slice(0, 3), verdicts = top3.map(h => mapRating(h.rating));
          let verdict = verdicts[0];
          const mixed = verdicts.includes('TRUE') && verdicts.includes('FALSE');
          if (mixed) verdict = 'MISLEADING';
          const t = top3[0], ti = matchHost(host(t.url), V.config.checkers);
          const who = ti >= 0 ? V.config.checkers[ti].name : (t.publisher || 'A fact-checker');
          const detail = `${mixed ? 'Fact-checkers differ on similar claims. ' : ''}<b>${esc(who)}</b> rated a similar claim “${esc(t.rating || 'reviewed')}”: “${esc((t.claim || '').slice(0, 160))}”. Confirm it matches what was said.`;
          const sc = mixed ? top3.reduce((a, h) => a + ratingScore(h.rating), 0) / top3.length : ratingScore(t.rating);
          return { verdict, detail, score: bandScore(verdict, sc), weight: 1, sources: top3.map(h => ({ url: h.url, label: (h.publisher || host(h.url)) + (h.rating ? ' · ' + h.rating : '') })) };
        }
      }
      // Tier 2: related reporting from a custom outlet list (optional; Google is retiring this API)
      if (V.settings.key && V.settings.cx) {
        try {
          const rep = await reportingSearch(text);
          if (rep.length) {
            return { verdict: 'REPORTED', detail: 'No fact-checker has reviewed this wording. These outlets report on the topic. That is context, not confirmation.',
              sources: rep.slice(0, 3).map(r => ({ url: r.url, label: r.name, bias: r.bias, by: r.by })) };
          }
        } catch (e) { /* fall through to research */ }
      }
      // Tier 3: AI research with web search (needs ANTHROPIC_API_KEY on the worker)
      if (judgeOn() && judgeLeft > 0) {
        judgeLeft--;
        const context = typeof ctx === 'function' ? await ctx() : (ctx || '');
        const j = await V.yt.judge(text, context);
        const sources = (j.sources || []).map(s => ({ url: s.url, label: s.title || host(s.url) }));
        if (j.verdict === 'TRUE' || j.verdict === 'MISLEADING' || j.verdict === 'FALSE') {
          const label = { 'groq-wikipedia': 'Limited AI check</b> using Wikipedia excerpts only, not a web search', 'gemini-knowledge': 'Limited AI check</b> from the model’s own knowledge, with no live web search', 'gemini-grounded': 'AI research</b> using Google Search results through Gemini' }[j.engine] || 'AI research</b> using web sources';
          return { verdict: j.verdict, sources, ai: true, score: bandScore(j.verdict, j.score), weight: j.confidence === 'high' ? 0.8 : 0.5,
            detail: `<b>${label}, not a published fact-check${j.confidence ? ' (confidence: ' + esc(j.confidence) + ')' : ''}. ${esc(j.explanation)}` + (j.standalone && j.standalone.toLowerCase().replace(/\W+/g, ' ').trim() !== text.toLowerCase().replace(/\W+/g, ' ').trim() ? ` <i>Checked in context as: “${esc(j.standalone)}”</i>` : '') };
        }
        return { verdict: 'NOMATCH', sources, detail: `<b>Could not verify.</b> ${esc(j.explanation || 'Not enough reliable evidence found.')}` };
      }
      const why = !V.settings.key && !judgeOn() ? 'Add a Google API key in Setup & settings (page footer) to look up published fact-checks.'
        : judgeOn() ? 'No published fact-check matched, and this session’s AI research limit was reached.'
        : 'No published fact-check matched this wording. That does not mean it is true or false. To have Veritas research claims itself, add an Anthropic key to the service (see the guide).';
      return { verdict: 'NOMATCH', detail: why, sources: [] };
    })();
    cache.set(k, p);
    p.catch(() => cache.delete(k));
    return p;
  }

  return { isClaim, priority, check, mapRating, resetBudget };
})();
