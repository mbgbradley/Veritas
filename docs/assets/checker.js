/* Claim detection and tiered checking.
   Tier 1: Google Fact Check Tools (aggregates PolitiFact, Snopes, FactCheck.org, AP, Reuters, Full Fact and more).
   Tier 2: if no fact-checker matched, search a custom list of wire/center outlets (Programmable Search) for related reporting.
   Results are "related", never a ruling by Veritas. */
V.checker = (() => {
  const CLAIM_RE = /\d|\b(percent|million|billion|trillion|doubled|tripled|halved|record|highest|lowest|never|always|every|nobody|no one|none|more than|less than|fewer|increase[ds]?|decrease[ds]?|rose|fell|cut|raised|lowered|passed|voted|signed|since|according to|unemployment|inflation|deficit|crime|tax(?:es)?|cost|costs|killed|died|arrested|banned|approved|ruled)\b/i;
  const OPINION_RE = /^(i think|i feel|i believe|i hope|maybe|perhaps|we should|you should|let me|thank you|thanks)\b/i;

  function isClaim(s) {
    s = s.trim();
    if (s.split(/\s+/).length < 6 || s.endsWith('?') || OPINION_RE.test(s)) return false;
    return CLAIM_RE.test(s) || V.flags.sentence(s).some(f => f.id === 'good');
  }
  // Rank used to spend the checking budget on the most check-worthy sentences first.
  function priority(s) {
    let p = 0;
    if (/\d/.test(s)) p += 2;
    if (/\b(percent|million|billion|trillion|doubled|tripled|record|never|always|every|nobody)\b/i.test(s)) p += 2;
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

  const cache = new Map();
  async function factCheckSearch(text) {
    const q = text.length > 220 ? text.slice(0, 220) : text;
    const r = await fetch(`https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(q)}&languageCode=en-US&pageSize=5&key=${encodeURIComponent(V.settings.key)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message || 'Fact-check lookup failed');
    const hits = [];
    (j.claims || []).forEach(c => (c.claimReview || []).forEach(cr => hits.push({
      claim: c.text, claimant: c.claimant, publisher: cr.publisher && cr.publisher.name, url: cr.url, rating: cr.textualRating,
      sim: sim(text, c.text || '')
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

  async function check(text) {
    const k = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (cache.has(k)) return cache.get(k);
    const p = (async () => {
      if (!V.settings.key) return { verdict: 'NOMATCH', detail: 'Add a Google API key in Settings to look up published fact-checks.', sources: [] };
      // Tier 1
      let hits = (await factCheckSearch(text)).filter(h => h.sim >= 0.5 && h.url);
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
        return { verdict, detail, sources: top3.map(h => ({ url: h.url, label: (h.publisher || host(h.url)) + (h.rating ? ' · ' + h.rating : '') })) };
      }
      // Tier 2
      if (V.settings.cx) {
        const rep = await reportingSearch(text);
        if (rep.length) {
          return { verdict: 'REPORTED', detail: 'No fact-checker has reviewed this wording. These outlets report on the topic. That is context, not confirmation.',
            sources: rep.slice(0, 3).map(r => ({ url: r.url, label: r.name, bias: r.bias, by: r.by })) };
        }
      }
      return { verdict: 'NOMATCH', detail: 'No published fact-check or related reporting matched this wording. That does not mean it is true or false.', sources: [] };
    })();
    cache.set(k, p);
    p.catch(() => cache.delete(k));
    return p;
  }

  return { isClaim, priority, check, mapRating };
})();
