/* Veritas app: player, transcript, check queue, timeline, schedule, Shorts. Runs entirely in the browser. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const cfg = V.config, S = V.settings;

  const state = {
    outlets: [...cfg.outlets, ...V.store.get('custom', [])],
    current: null, video: null,
    mode: 'session',            // session (mic/demo) | video (YouTube) | doc (article/pasted text)
    live: false, short: false, duration: 0,
    debate: false, filter: 'all',
    cards: [], lines: [], seen: new Set(), flags: null, docCount: 0,
    t0: null, rec: null, pollTimer: null, timers: [], activeLine: -1, lastSegEnd: -1, openSeq: 0, lastT: 0,
    names: { A: 'Speaker A', B: 'Speaker B' },
    feed: null, shorts: null, tab: 'top', sched: { status: 'all', outlet: 'all' }
  };
  const MAX_CLAIMS = 60;
  let cardSeq = 0, player = null, ytReady = false, pendingAttach = false, interimEl = null;

  const ICON = {
    TRUE: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
    MISLEADING: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
    FALSE: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    NOMATCH: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
    REPORTED: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/></svg>',
    PENDING: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
    FLAG: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 21V4M5 4h12l-2 4 2 4H5"/></svg>'
  };
  const LABEL = { TRUE: 'TRUE', MISLEADING: 'MISLEADING', FALSE: 'FALSE', NOMATCH: 'NO MATCH', REPORTED: 'RELATED REPORTING', PENDING: 'CHECKING' };
  const COLOR = { TRUE: 'var(--true)', MISLEADING: 'var(--mis)', FALSE: 'var(--false)', NOMATCH: 'var(--none)', REPORTED: 'var(--silver)' };
  const EMPTY = '<p class="empty">Pick a story below, paste a link above, or press <b>Run demo</b> to see sample checks.</p>';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = sec => {
    sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
  };
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  const splitSentences = t => t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const outletName = id => (state.outlets.find(o => o.id === id) || {}).name || '';

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 5000);
  }
  let errShown = false;
  const errOnce = m => { if (!errShown) { errShown = true; toast('Lookup problem: ' + m); setTimeout(() => (errShown = false), 20000); } };
  const setStatus = t => { $('#srcStatus').textContent = t ? '· ' + t : ''; };

  let rq = false;
  function schedule() {
    if (rq) return; rq = true;
    requestAnimationFrame(() => { rq = false; renderCards(); renderTimeline(); renderMeters(); renderFlags(); });
  }

  /* ================= PLAYER ================= */
  const originParam = () => /^https?:$/.test(location.protocol) ? '&origin=' + encodeURIComponent(location.origin) : '';
  function embedUrl(o) {
    if (o.type === 'yt-channel') return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(o.ref)}&rel=0&enablejsapi=1` + originParam();
    if (o.type === 'yt-video') return `https://www.youtube.com/embed/${encodeURIComponent(o.ref)}?rel=0&playsinline=1&enablejsapi=1${o.autoplay ? '&autoplay=1' : ''}` + originParam();
    if (o.type === 'social') return o.src || 'about:blank';
    if (o.type === 'twitch') return `https://player.twitch.tv/?channel=${encodeURIComponent(o.ref)}&parent=${encodeURIComponent(location.hostname || 'localhost')}&autoplay=false`;
    return 'about:blank';
  }
  const openUrl = o => o.type === 'social' ? o.href : o.type === 'yt-channel' ? `https://www.youtube.com/channel/${o.ref}/live` : o.type === 'yt-video' ? `https://www.youtube.com/watch?v=${o.ref}` : `https://www.twitch.tv/${o.ref}`;

  window.onYouTubeIframeAPIReady = () => { ytReady = true; if (pendingAttach) attach(); };
  (function () { const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true; document.head.appendChild(s); })();

  function attach() {
    if (!ytReady || !window.YT || !YT.Player) { pendingAttach = true; return; }
    pendingAttach = false;
    try {
      player = new YT.Player('frame', { events: { onReady: () => {
        try { const d = player.getDuration(); if (d > 0 && state.mode === 'video' && !state.live) { state.duration = d; schedule(); } } catch {}
      } } });
    } catch { player = null; }
  }
  function setFrame(o) {
    const f = $('#frame'); player = null;
    const eb = $('#embedBox'); eb.hidden = true; eb.innerHTML = '';
    const useEmbed = o.type === 'social' && !!o.embed;
    f.hidden = useEmbed; $('#articleBox').hidden = true;
    const ph = $('#playerEmpty'); if (ph) ph.hidden = true;
    f.onload = o.type === 'social' ? null : () => attach();      // the YouTube player API only applies to YouTube
    f.src = useEmbed ? 'about:blank' : embedUrl(o);
    if (useEmbed) renderEmbed(o, eb);
    const a = $('#openYT'); a.hidden = false; a.href = openUrl(o); a.textContent = o.type === 'twitch' ? 'Open on Twitch ↗' : o.type === 'social' ? 'Open on ' + o.label + ' ↗' : 'Open on YouTube ↗';
  }
  // TikTok and Instagram: their documented embed markup plus their own embed.js (no login or token).
  function loadEmbedScript(src, key) {
    const old = document.getElementById('emb-' + key); if (old) old.remove();
    const sc = document.createElement('script'); sc.id = 'emb-' + key; sc.async = true; sc.src = src; document.body.appendChild(sc);
  }
  function renderEmbed(o, eb) {
    eb.hidden = false;
    if (o.embed === 'tiktok') {
      eb.innerHTML = `<blockquote class="tiktok-embed" cite="${esc(o.href)}" data-video-id="${esc(o.id)}" style="max-width:605px;min-width:325px;"><section></section></blockquote>`;
      loadEmbedScript('https://www.tiktok.com/embed.js', 'tiktok');
    } else if (o.embed === 'instagram') {
      eb.innerHTML = `<blockquote class="instagram-media" data-instgrm-permalink="${esc(o.href)}" data-instgrm-version="14" style="width:100%;max-width:540px;min-width:326px;margin:0 auto"></blockquote>`;
      if (window.instgrm && window.instgrm.Embeds) window.instgrm.Embeds.process(); else loadEmbedScript('https://www.instagram.com/embed.js', 'instagram');
    }
  }
  const curTime = () => { try { return player && player.getCurrentTime ? player.getCurrentTime() : null; } catch { return null; } };
  function seek(t) { try { if (player && player.seekTo) { player.seekTo(t, true); player.playVideo(); } } catch {} }

  /* ================= SESSION RESET ================= */
  const Q = { items: [], active: 0, max: 3, gen: 0 };
  function reset() {
    stopTab(false); stopLocal(false);
    clearInterval(state.pollTimer); state.pollTimer = null;
    if (state.rec) { try { state.rec.stop(); } catch {} }
    Q.items.length = 0; Q.gen++;
    state.cards = []; state.lines = []; state.seen = new Set(); state.flags = null; state.t0 = null;
    state.lastSegEnd = -1; state.docCount = 0; state.lastT = 0; state.activeLine = -1; cardSeq = 0; interimEl = null; state.newestFirst = false; liveCount = 0;
    V.checker.resetBudget(); hideBanner(); $('#socialHelp').hidden = true;
    state.timers.forEach(clearTimeout); state.timers = [];
    $('#lower').hidden = true; $('#capBody').innerHTML = EMPTY; setStatus('');
    schedule();
  }

  /* ================= CHECK QUEUE ================= */
  function enqueue(c) { Q.items.push(c); pump(); }
  function pump() {
    while (Q.active < Q.max && Q.items.length) {
      let idx = 0;
      if (state.mode === 'video') { // check what is nearest the playhead first
        const f = curTime() || 0; let best = Infinity;
        Q.items.forEach((c, i) => { const d = Math.abs(c.t - f); if (d < best) { best = d; idx = i; } });
      }
      const c = Q.items.splice(idx, 1)[0]; Q.active++;
      run(c).finally(() => { Q.active--; pump(); });
    }
  }
  async function run(c) {
    const g = Q.gen;
    try {
      const lead = (/^(they|he|she|it|this|that|these|those|his|her|their|its|such|there|which|and|but|so|because)\b/i.test(c.text) || wc(c.text) < 8) ? (surround(c, 1, 0).before[0] || '') : '';
      const r = await V.checker.check(c.text, () => ctxLater(c), { lead });
      if (g !== Q.gen) return;
      resolve(c, r.verdict, r.detail, r.sources, r.score, r.weight, r.ai);
    } catch (e) {
      if (g !== Q.gen) return;
      resolve(c, 'NOMATCH', 'Lookup failed: ' + esc(e.message), []); errOnce(e.message);
    }
  }
  // The statements around a claim (every sentence, in order), so a claim is judged in context, not as an isolated string.
  function surround(c, nb, na) {
    const all = []; state.lines.forEach(L => L.sents.forEach(x => all.push(x)));
    const k = norm(c.text), i = all.findIndex(x => norm(x) === k);
    return i < 0 ? { before: [], after: [] } : { before: all.slice(Math.max(0, i - nb), i), after: all.slice(i + 1, i + 1 + na) };
  }
  const titleCtx = () => state.video && state.video.title ? 'Video: ' + state.video.title + (state.video.channel ? ' (' + state.video.channel + ')' : '') + '. ' : '';
  // Used when a claim reaches the AI step: while listening live, wait up to 6 s for the sentences that follow it.
  async function ctxLater(c) {
    const t0 = Date.now();
    while ((local || tab) && Date.now() - t0 < 6000 && surround(c, 0, 2).after.length < 2) await new Promise(r => setTimeout(r, 500));
    const s = surround(c, 3, 2);
    return (titleCtx() + 'Before: ' + (s.before.join(' ') || 'nothing') + ' | After: ' + (s.after.join(' ') || 'nothing')).slice(0, 1400);
  }
  function factPrompt(c) {
    const s = surround(c, 2, 2);
    return `Fact-check this statement from a political video or broadcast. Be neutral. Cite FactCheck.org first if it has covered this, then other credible non-partisan outlets or official data (AP, Reuters, PolitiFact, government statistics).\n\nStatement: "${c.text}"\n` +
      (s.before.length ? `Said just before: ${s.before.join(' ')}\n` : '') + (s.after.length ? `Said just after: ${s.after.join(' ')}\n` : '') + (titleCtx() ? titleCtx() + '\n' : '') +
      `\nJudge it as the speaker meant it in context. Reply with: 1) Verdict: True, Misleading, False or Unverifiable. 2) A truth score from 0 to 100. 3) One or two sentences of explanation. 4) Two or three sources with links.`;
  }
  function resolve(c, verdict, detail, sources, score, weight, ai) {
    c.verdict = verdict; c.detail = detail || ''; c.sources = sources || [];
    c.score = score != null ? score : null; c.weight = weight != null ? weight : null; c.ai = !!ai;
    if (c.line) renderLine(c.line);
    if ((verdict === 'FALSE' || verdict === 'MISLEADING') && (state.mode !== 'video' || state.live || state.newestFirst)) showLower(c);
    schedule();
  }

  /* ================= LINES + CARDS ================= */
  function newCard(text, speaker, t, line) {
    const c = { id: ++cardSeq, text, speaker, t, verdict: 'PENDING', detail: '', sources: [], flags: V.flags.sentence(text), shown: false, line };
    state.cards.push(c); return c;
  }
  function renderLine(L) {
    const tx = L.el.querySelector('.tx');
    tx.innerHTML = L.sents.map(s => {
      const c = L.cards[s]; if (!c) return esc(s);
      const cls = c.verdict === 'MISLEADING' ? ' mis' : (c.verdict === 'PENDING' || c.verdict === 'NOMATCH' || c.verdict === 'REPORTED') ? ' chk' : '';
      return `<span class="mk${cls}" style="--c:${COLOR[c.verdict] || 'var(--none)'}">${esc(s)}</span>`;
    }).join(' ');
  }
  function makeLine(text, t, speaker, keepFn, frag) {
    const L = { t, speaker, text, sents: splitSentences(text), cards: {} };
    if (!L.sents.length) L.sents = [text];
    const el = document.createElement('p'); el.className = 'line';
    const label = state.mode === 'doc' ? '¶' + (++state.docCount) : (state.debate && state.mode === 'session' ? state.names[speaker] : fmt(t));
    el.innerHTML = `<button type="button" class="sp">${esc(label)}</button><span class="tx"></span>`;
    L.el = el;
    el.querySelector('.sp').addEventListener('click', () => { if (state.mode === 'video') seek(L.t); });
    state.lines.push(L);
    L.sents.forEach(s => {
      if (!V.checker.isClaim(s)) return;
      const k = norm(s); if (state.seen.has(k)) return;
      if (keepFn && !keepFn(s)) return;
      state.seen.add(k);
      const c = newCard(s, speaker, t, L); L.cards[s] = c; enqueue(c);
    });
    renderLine(L);
    if (frag) frag.appendChild(el); else placeLine(el);
    return L;
  }
  function ensureSession() {
    if (!state.t0) { state.t0 = Date.now(); $('#capBody').innerHTML = ''; }
  }
  const sessionT = () => state.t0 ? (Date.now() - state.t0) / 1000 : 0;
  function liveLine(text, speaker) {
    ensureSession(); makeLine(text, sessionT(), speaker);
    scrollLatest(); schedule();
  }

  /* captions -> chunks of about a sentence, keeping start times */
  function chunk(segs) {
    const out = []; let cur = null;
    segs.forEach(s => {
      const txt = s.text.replace(/\[[^\]]*\]/g, '').replace(/>>+/g, '').replace(/\s+/g, ' ').trim();
      if (!txt) return;
      if (!cur) cur = { start: s.start, text: txt, end: s.start + (s.dur || 0) };
      else { cur.text += ' ' + txt; cur.end = s.start + (s.dur || 0); }
      const wc = cur.text.split(/\s+/).length;
      if ((/[.!?]["')\]]?$/.test(txt) && wc >= 8) || wc >= 32) { out.push(cur); cur = null; }
    });
    if (cur) out.push(cur);
    return out;
  }
  function ingestSegments(segs, live) {
    const chunks = chunk(segs);
    if (!chunks.length) return;
    const frag = document.createDocumentFragment();
    let keep = null;
    if (!live) { // spend the checking budget on the most check-worthy sentences
      const cand = [];
      chunks.forEach((ch, ci) => splitSentences(ch.text).forEach(s => { if (V.checker.isClaim(s)) cand.push({ k: ci + '|' + s, p: V.checker.priority(s) }); }));
      cand.sort((a, b) => b.p - a.p);
      const set = new Set(cand.slice(0, MAX_CLAIMS).map(x => x.k));
      keep = (ci, s) => set.has(ci + '|' + s);
    }
    chunks.forEach((ch, ci) => makeLine(ch.text, ch.start, 'A', keep ? s => keep(ci, s) : null, frag));
    state.lastSegEnd = Math.max(state.lastSegEnd, ...chunks.map(c => c.end));
    $('#capBody').appendChild(frag);
  }
  const transcriptText = () => state.lines.map(l => l.text).join(' ');

  /* ================= OPEN: VIDEO / CHANNEL / ARTICLE / TEXT ================= */
  async function openVideo(m, opts = {}) {
    const my = ++state.openSeq;
    reset(); state.mode = 'video'; state.video = m; state.live = !!opts.live || m.status === 'live'; state.short = !!opts.short;
    $('#playerBox').classList.toggle('vertical', state.short);
    $('#liveBadge').hidden = !state.live;
    $('#nowPlaying').textContent = m.title || 'Video';
    setFrame({ type: 'yt-video', ref: m.id, autoplay: true });
    $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#capBody').innerHTML = '<p class="empty">Starting…</p>';
    setStatus('starting');
    // With no reliable captions source, listen to the tab right now. This must happen inside the click so Chrome allows it.
    const captionsExpected = !!S.worker && (!V.info || V.info.supadata);
    let audio = null;
    if (!captionsExpected) audio = startAudio(true, true);
    let meta = m;
    if (S.key && !m.description) { try { meta = (await V.yt.one(m.id)) || m; } catch {} }
    if (my !== state.openSeq) return;
    state.video = meta; state.duration = meta.duration || 0;
    if (meta.title) $('#nowPlaying').textContent = meta.title;
    if (meta.status === 'live') { state.live = true; $('#liveBadge').hidden = false; }

    let segs = null, auto = false;
    if (captionsExpected) {
      try {
        const tr = await Promise.race([V.yt.transcript(m.id), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 7000))]);
        segs = tr.segments; auto = tr.auto; if (tr.live) state.live = true;
      } catch (e) { toast('Captions unavailable (' + e.message + '). Listening to the video’s audio instead.'); }
      if (my !== state.openSeq) return;
    }
    if (segs && segs.length) {
      $('#capBody').innerHTML = '';
      ingestSegments(segs, state.live);
      setStatus('captions' + (auto ? ' (auto-generated)' : ''));
      if (state.live) state.pollTimer = setInterval(pollLive, 20000);
    } else {
      const started = audio ? await audio : await startAudio(true, true);
      if (my !== state.openSeq) return;
      if (!started) {
        $('#capBody').innerHTML = ''; ingestMetadata(meta);
        setStatus('title and description only · start transcription to check what is said');
      }
    }
    state.flags = V.flags.video(meta, transcriptText());
    if (!S.key && !(V.info && (V.info.anthropic || V.info.judge))) toast('Add a Google API key in Setup & settings (page footer) to look up fact-checks.');
    schedule();
  }
  function ingestMetadata(meta) {
    const parts = [];
    if (meta.title) parts.push(meta.title.replace(/[.!?]*$/, '.'));
    (meta.description || '').slice(0, 900).split(/\n+/).forEach(p => { p = p.trim(); if (p.split(/\s+/).length >= 6 && !/^https?:/i.test(p)) splitSentences(p).forEach(s => parts.push(s)); });
    const frag = document.createDocumentFragment();
    parts.slice(0, 14).forEach(p => makeLine(p, 0, 'A', null, frag));
    $('#capBody').appendChild(frag);
    if (!parts.length) $('#capBody').innerHTML = '<p class="empty">No text available for this video. Use Listen (mic) while it plays.</p>';
  }
  async function pollLive() {
    if (state.mode !== 'video' || !state.video) return;
    try {
      const tr = await V.yt.transcript(state.video.id);
      const fresh = tr.segments.filter(s => s.start > state.lastSegEnd - 0.5);
      if (fresh.length) { ingestSegments(fresh, true); const b = $('#capBody'); b.scrollTop = b.scrollHeight; setStatus('captions · live'); }
    } catch {}
  }

  async function selectOutlet(o) {
    const my = ++state.openSeq; state.current = o; renderOutlets();
    if (o.type === 'yt-channel' && S.key) {
      try {
        const items = await V.yt.feed(state.outlets, false);
        if (my !== state.openSeq) return;
        const live = items.find(v => v.outlet === o.id && v.status === 'live');
        if (live) { openVideo(live, { live: true }); return; }
      } catch {}
    }
    if (my !== state.openSeq) return;
    reset(); state.mode = 'session'; state.live = false; state.short = false;
    $('#playerBox').classList.remove('vertical'); $('#liveBadge').hidden = false;
    $('#nowPlaying').textContent = o.name; setFrame(o);
    setStatus(S.key ? 'no live video found · use Listen (mic)' : 'use Listen (mic) or add a key to find live video');
  }

  function showDoc(title, link) {
    state.mode = 'doc'; state.live = false;
    $('#frame').hidden = true; $('#liveBadge').hidden = true; $('#playerBox').classList.remove('vertical');
    const ph = $('#playerEmpty'); if (ph) ph.hidden = true;
    $('#embedBox').hidden = true;
    const box = $('#articleBox'); box.hidden = false;
    box.innerHTML = `<div><div class="doc-kicker">Checking text</div><h2>${esc(title)}</h2>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Open original ↗</a>` : ''}</div>`;
    $('#nowPlaying').textContent = title; $('#openYT').hidden = true;
  }
  function runDoc(paragraphs, title, link) {
    reset(); showDoc(title, link);
    $('#capBody').innerHTML = '';
    const frag = document.createDocumentFragment();
    paragraphs.forEach(p => makeLine(p, state.docCount, 'A', null, frag));
    $('#capBody').appendChild(frag);
    setStatus('text');
    state.flags = V.flags.video({ title, description: '' }, paragraphs.join(' '));
    schedule();
    if (!S.key) toast('Add a Google API key in Setup & settings (page footer) to look up fact-checks.');
  }
  /* ---------- TikTok / Instagram / Facebook: official embed player + tab-audio capture ---------- */
  const SOCIAL = { tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook' };
  async function openSocial(p) {
    const my = ++state.openSeq, label = SOCIAL[p.platform];
    reset(); state.mode = 'session'; state.live = false; state.short = false;
    $('#playerBox').classList.toggle('vertical', p.platform === 'tiktok');
    $('#liveBadge').hidden = true; $('#nowPlaying').textContent = label + ' video';
    $('#capBody').innerHTML = '<p class="empty">Starting…</p>'; setStatus('starting');
    $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Start listening inside the click (Chrome only allows the share prompt right after one). The embed loads while you answer it.
    const audio = startAudio(true, true);
    let meta = {};
    if (p.platform === 'tiktok' && S.worker) { try { meta = await V.yt.social(p.url); if (meta.id) p.id = meta.id; if (meta.url) p.url = meta.url; } catch {} }
    if (my !== state.openSeq) return;
    let src = '', embed = '';
    if (p.platform === 'tiktok' && p.id) embed = 'tiktok';
    else if (p.platform === 'instagram') { embed = 'instagram'; p.url = `https://www.instagram.com/${p.type || 'p'}/${p.id}/`; }
    else if (p.platform === 'facebook') src = 'https://www.facebook.com/plugins/video.php?show_text=false&autoplay=true&href=' + encodeURIComponent(p.url);
    if (embed || src) { setFrame({ type: 'social', embed, src, id: p.id, href: p.url, label }); $('#nowPlaying').textContent = meta.title ? meta.title.slice(0, 120) : label + ' video'; }
    else toast('Could not open that ' + label + ' link here. Open it in its own tab, press play, then use Tab audio: free and choose that tab.');
    if (p.platform !== 'facebook') { $('#socialOpen').href = p.url; $('#socialHelp').hidden = false; }   // these embeds often will not play: offer the open-in-a-tab route up front
    const started = await audio;
    if (my !== state.openSeq) return;
    if (started) {
      toast('If the video is paused, press play in the player. Times count from when transcription started.');
      setTimeout(() => {
        if (my === state.openSeq && !liveCount && (local || tab)) showBanner('No speech heard yet. If the video did not load or will not play here, open it in its own tab, play it, then click Start transcription and choose that tab.');
      }, 20000);
    }
  }
  async function openArticle(url) {
    if (!S.worker) { toast('Add a Transcript service URL in Setup & settings (page footer) to fetch articles, or paste the text into Check text.'); return; }
    toast('Fetching article…');
    try { const a = await V.yt.article(url); runDoc(a.paragraphs, a.title || url, a.url); }
    catch (e) { toast('Could not read that page: ' + e.message); }
  }
  function openText(text) {
    const paras = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    runDoc(paras.length ? paras : [text], 'Pasted text', null);
  }

  /* ================= TIMELINE ================= */
  function win() {
    const cur = curTime();
    if (state.mode === 'video' && state.live) { const c = cur || 0; return { lo: Math.max(0, c - 900), hi: Math.max(c, 60) + 15 }; }
    if (state.mode === 'video') {
      const last = state.cards.length ? Math.max(...state.cards.map(c => c.t)) + 30 : 60;
      return { lo: 0, hi: Math.max(state.duration || last, 60) };
    }
    if (state.mode === 'doc') return { lo: 0, hi: Math.max(state.docCount, 1) };
    return { lo: 0, hi: Math.max(sessionT(), 60) };
  }
  function renderTimeline() {
    const tl = $('#timeline'), w = win();
    const pos = state.mode === 'video' ? (curTime() || 0) : state.mode === 'doc' ? 0 : sessionT();
    const pct = t => Math.max(0, Math.min(99.2, (t - w.lo) / (w.hi - w.lo) * 100));
    $('#elapsed').textContent = state.mode === 'video' ? (state.live ? 'LIVE · ' + fmt(pos) : fmt(pos) + ' / ' + fmt(state.duration || w.hi)) : state.mode === 'doc' ? state.docCount + (state.docCount === 1 ? ' paragraph' : ' paragraphs') : fmt(pos);
    let html = '<div class="tl-rail"></div>';
    if (state.mode !== 'doc') html += `<div class="tl-fill" style="width:${pct(pos)}%"></div>`;
    tl.innerHTML = html;
    state.cards.forEach(c => {
      if (c.verdict === 'PENDING') return;
      const t = state.mode === 'doc' ? (c.line ? state.lines.indexOf(c.line) : 0) : c.t;
      if (t < w.lo || t > w.hi) return;
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'tick' + (c.verdict === 'MISLEADING' ? ' dashed' : '');
      b.style.left = pct(t) + '%'; b.style.setProperty('--c', COLOR[c.verdict]);
      const when = state.mode === 'doc' ? 'paragraph ' + (t + 1) : fmt(c.t);
      b.setAttribute('aria-label', `${LABEL[c.verdict]} at ${when}`); b.title = `${LABEL[c.verdict]} · ${when}`;
      b.addEventListener('click', () => focusCard(c));
      tl.appendChild(b);
    });
  }
  function focusCard(c) {
    if (state.mode === 'video') seek(c.t);
    if (state.filter === 'flagged' && c.verdict !== 'FALSE' && c.verdict !== 'MISLEADING') { state.filter = 'all'; syncSeg(); renderCards(); }
    const el = $('#card-' + c.id);
    if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.add('hi'); setTimeout(() => el.classList.remove('hi'), 1600); }
    if (c.line) c.line.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* playback watcher: lower-thirds, active transcript line */
  setInterval(() => {
    if (state.mode === 'video') {
      const cur = curTime();
      if (cur == null) return;
      if (cur < state.lastT - 2) state.cards.forEach(c => (c.shown = false));
      state.lastT = cur;
      state.cards.forEach(c => {
        if (!c.shown && (c.verdict === 'FALSE' || c.verdict === 'MISLEADING') && c.t <= cur && c.t > cur - 8) { c.shown = true; showLower(c); }
      });
      if (state.newestFirst) { renderTimeline(); return; }
      let act = -1;
      for (let i = 0; i < state.lines.length; i++) { if (state.lines[i].t <= cur) act = i; else break; }
      if (act !== state.activeLine && act >= 0) {
        if (state.lines[state.activeLine]) state.lines[state.activeLine].el.classList.remove('now');
        const L = state.lines[act]; L.el.classList.add('now'); state.activeLine = act;
        const b = $('#capBody'); b.scrollTo({ top: Math.max(0, L.el.offsetTop - b.offsetTop - 40), behavior: 'smooth' });
      }
      renderTimeline();
    } else if (state.t0) renderTimeline();
  }, 500);

  let lowerTimer;
  function showLower(c) {
    const el = $('#lower');
    el.style.setProperty('--c', COLOR[c.verdict]);
    el.innerHTML = `<div class="lbl">${ICON[c.verdict]}${LABEL[c.verdict]}</div><div class="txt"><b>“${esc(c.text)}”</b><small>${c.detail ? c.detail.replace(/<[^>]+>/g, '') : ''}</small></div>`;
    el.hidden = false; clearTimeout(lowerTimer); lowerTimer = setTimeout(() => (el.hidden = true), 9000);
  }

  /* ================= FEED, METERS, FLAGS ================= */
  // Free, manual second opinions with live web search: Perplexity opens with the question filled in; Gemini cannot be pre-filled, so the prompt is copied.
  function askAI(c, which) {
    const prompt = factPrompt(c);
    try { navigator.clipboard.writeText(prompt).then(() => toast(which === 'gemini' ? 'Prompt copied. Paste it into Gemini.' : 'Opening Perplexity (prompt also copied).'), () => {}); } catch {}
    window.open(which === 'gemini' ? 'https://gemini.google.com/app' : 'https://www.perplexity.ai/search?q=' + encodeURIComponent(prompt.slice(0, 1500)), '_blank', 'noopener');
  }
  function renderCards() {
    const box = $('#cards'); box.innerHTML = '';
    let list = state.cards.filter(c => state.filter === 'all' || c.verdict === 'FALSE' || c.verdict === 'MISLEADING');
    list = state.mode === 'session' ? list.slice().reverse() : list.slice().sort((a, b) => a.t - b.t);
    list.forEach(c => {
      const el = document.createElement('article');
      el.className = 'card ' + (c.verdict === 'PENDING' ? 'pending' : 'c-' + c.verdict); el.id = 'card-' + c.id;
      const sp = state.debate && state.mode === 'session' ? ` · ${esc(state.names[c.speaker])}` : '';
      const when = state.mode === 'doc' ? '' : fmt(c.t);
      const tags = c.flags.length ? `<div class="tags">${c.flags.map(f => `<span class="tagchip">${ICON.FLAG}${esc(f.label)}</span>`).join('')}</div>` : '';
      const srcs = c.sources.length ? `<div class="src">${c.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}${s.bias ? ` <span class="bias" title="${esc(s.by || '')}">${esc(s.bias)}</span>` : ''} ↗</a>`).join('')}</div>` : '';
      const sc = c.verdict in DEFAULT_SCORE ? cardScore(c) : null;
      const pct = sc != null ? `<span class="pct" title="${c.ai ? 'Estimated by AI' : 'From the published rating'}">${c.ai ? '≈ ' : ''}${sc}% true</span>` : '';
      const bar = sc != null ? `<div class="sbar" role="img" aria-label="${sc} percent true"><i style="width:${sc}%"></i></div>` : '';
      const more = c.text ? `<details class="more"${c.verdict === 'NOMATCH' ? ' open' : ''}><summary>Search this statement</summary><div class="acts"><a class="askg" target="_blank" rel="noopener" href="https://www.factcheck.org/search/#gsc.tab=0&gsc.q=${encodeURIComponent(c.text.slice(0, 120))}">FactCheck.org ↗</a><button type="button" class="askg" data-ask="perplexity" title="Opens Perplexity with the question filled in (also copied)">Perplexity ↗</button><button type="button" class="askg" data-ask="gemini" title="Copies a ready-made prompt and opens Gemini">Gemini ↗</button></div></details>` : '';
      el.innerHTML = `<div class="vh">${ICON[c.verdict]}<span>${LABEL[c.verdict]}${sp}</span>${pct}${when ? `<button type="button" class="t">${when}</button>` : ''}</div>
        <div class="q">“${esc(c.text)}”</div>${bar}${tags}${c.detail ? `<div class="d">${c.detail}</div>` : ''}${srcs}${more}`;
      el.querySelectorAll('button.askg').forEach(b => b.addEventListener('click', () => askAI(c, b.dataset.ask)));
      const tb = el.querySelector('.t'); if (tb) tb.addEventListener('click', () => focusCard(c));
      box.appendChild(el);
    });
    if (!list.length) box.innerHTML = '<p class="fine">Nothing to show yet.</p>';
    const n = k => state.cards.filter(c => c.verdict === k).length;
    const T = n('TRUE'), M = n('MISLEADING'), F = n('FALSE'), R = n('REPORTED'), X = n('NOMATCH'), P = n('PENDING');
    $('#tally').innerHTML = `<div style="flex:${T};background:var(--true)"></div><div style="flex:${M};background:var(--mis)"></div><div style="flex:${F};background:var(--false)"></div><div style="flex:${R};background:var(--silver)"></div><div style="flex:${X};background:var(--none)"></div>`;
    $('#tallyTxt').textContent = state.cards.length ? `${T} true · ${M} misleading · ${F} false · ${R} related reporting · ${X} no match · ${P} checking \u00B7 ${state.lines.length} lines heard` : (state.lines.length ? `${state.lines.length} lines heard, no checkable claims yet.` : 'No claims checked yet.');
  }

  const arc = (a1, a2) => {
    const p = a => [100 - 80 * Math.cos(a * Math.PI / 180), 100 - 80 * Math.sin(a * Math.PI / 180)];
    const [x1, y1] = p(a1), [x2, y2] = p(a2);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A80 80 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  // Overall truth score = weighted average of the per-claim scores. Weight = how strong the evidence was (published fact-check 1.0,
  // AI with high confidence 0.8, medium 0.5) x how check-worthy the claim is (numbers and specifics count up to twice as much).
  const DEFAULT_SCORE = { TRUE: 92, MISLEADING: 55, FALSE: 8 };      // used only for sample/demo cards that carry no score
  const cardScore = c => c.score != null ? c.score : DEFAULT_SCORE[c.verdict];
  const cardWeight = c => (c.weight != null ? c.weight : 1) * (1 + Math.min(6, V.checker.priority(c.text)) / 6);
  function score(list) {
    const rated = list.filter(c => c.verdict in DEFAULT_SCORE);
    if (!rated.length) return { n: 0, s: null };
    let sw = 0, ss = 0; rated.forEach(c => { const w = cardWeight(c); sw += w; ss += w * cardScore(c); });
    return { n: rated.length, s: ss / sw / 100 };
  }
  function gauge(sc) {
    const rot = sc.s === null ? 0 : -90 + 180 * sc.s;
    return `<svg viewBox="0 0 200 115" role="img" aria-label="${sc.s === null ? 'No rated claims yet' : 'Overall truth score ' + Math.round(sc.s * 100) + ' percent'}">
      <path d="${arc(0, 58)}" stroke="var(--false)" stroke-width="16" fill="none"/><path d="${arc(62, 118)}" stroke="var(--mis)" stroke-width="16" fill="none"/><path d="${arc(122, 180)}" stroke="var(--true)" stroke-width="16" fill="none"/>
      <g class="needle" style="transform:rotate(${rot}deg)"><path d="M100 100 L100 32" stroke="#EEF2F7" stroke-width="4" stroke-linecap="round"/><circle cx="100" cy="100" r="8" fill="#EEF2F7"/></g></svg>`;
  }
  function renderMeters() {
    const box = $('#meters'), focus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.sp;
    const mk = (title, list, sp) => {
      const sc = score(list), head = sp ? `<input data-sp="${sp}" value="${esc(state.names[sp])}" aria-label="Name for speaker ${sp}">` : `<h3>${title}</h3>`;
      return `<div class="meter">${head}${gauge(sc)}<div class="val">${sc.s === null ? '—' : Math.round(sc.s * 100) + '%'}</div><div class="sub">${sc.n} rated${sc.n && sc.n < 3 ? ' · early reading' : ''} · truth score</div></div>`;
    };
    if (state.debate) {
      box.innerHTML = mk('', state.cards.filter(c => c.speaker === 'A'), 'A') + mk('', state.cards.filter(c => c.speaker === 'B'), 'B');
      box.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { state.names[i.dataset.sp] = i.value || ('Speaker ' + i.dataset.sp); const w = $('#who'); w.options[0].textContent = state.names.A; w.options[1].textContent = state.names.B; }));
      if (focus) { const f = box.querySelector(`input[data-sp="${focus}"]`); if (f) f.focus(); }
    } else box.innerHTML = mk('Truth meter', state.cards, null);
  }
  function renderFlags() {
    const box = $('#flags');
    if (!state.flags) { box.hidden = true; return; }
    box.hidden = false;
    const title = (state.video && state.video.title) || '';
    const link = title ? `<a class="fx" target="_blank" rel="noopener" href="https://toolbox.google.com/factcheck/explorer/search/${encodeURIComponent(title)}">Search this topic in Google Fact Check Explorer ↗</a>` : '';
    const lineFlags = state.cards.filter(c => c.flags.length).length;
    if (!state.flags.length) {
      box.innerHTML = `<h2>Red flags</h2><p class="ok">None detected in the title, description or speech. That does not make it reliable. Check the source.</p>${lineFlags ? `<p class="fine">${lineFlags} individual claim${lineFlags > 1 ? 's use' : ' uses'} loaded wording.</p>` : ''}${link}`;
      return;
    }
    box.innerHTML = `<h2>Red flags</h2><ul>${state.flags.map(f => `<li class="sev-${f.sev}"><b>${ICON.FLAG} ${esc(f.label)}</b><span>${esc(f.why)}</span></li>`).join('')}</ul>${lineFlags ? `<p class="fine">${lineFlags} individual claim${lineFlags > 1 ? 's' : ''} tagged below.</p>` : ''}${link}`;
  }

  /* ================= OUTLETS ================= */
  function renderOutlets() {
    const box = $('#outletList'); if (!box) return; box.innerHTML = '';
    state.outlets.forEach(o => {
      const b = document.createElement('button'); b.className = 'chip'; b.type = 'button';
      if (state.current && state.current.id === o.id) b.setAttribute('aria-current', 'true');
      b.innerHTML = `<span class="dot"></span>${esc(o.name)}`;
      b.addEventListener('click', () => selectOutlet(o));
      if (o.custom) {
        const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove ' + o.name;
        x.addEventListener('click', e => { e.stopPropagation(); state.outlets = state.outlets.filter(z => z.id !== o.id); V.store.set('custom', state.outlets.filter(z => z.custom)); renderOutlets(); });
        b.appendChild(x);
      }
      box.appendChild(b);
    });
  }

  /* ================= SCHEDULE / TOP STORIES / SHORTS ================= */
  const isShort = v => v.duration > 0 && v.duration <= 62 && v.status === 'none';
  const whenOf = v => v.status === 'live' ? v.actualStart : v.status === 'upcoming' ? v.scheduledStart : (v.actualEnd || v.actualStart || v.publishedAt);
  const fmtWhen = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

  async function loadBrowse(force) {
    if (!S.key) { renderSched(); renderTop(); renderShorts(); return; }
    try {
      const yt = state.outlets.filter(o => o.type === 'yt-channel');
      if (state.tab === 'shorts') { state.shorts = await V.yt.shorts(yt, force); renderShorts(); }
      else { state.feed = await V.yt.feed(yt, force); renderSched(); renderTop(); }
    } catch (e) {
      const msg = `<p class="heads-msg">Could not load: ${esc(e.message)}</p>`;
      $('#schedList').innerHTML = msg; $('#topGrid').innerHTML = msg; $('#shortsGrid').innerHTML = msg;
    }
  }
  function renderSched() {
    const list = $('#schedList'), fl = $('#schedFilters');
    if (!S.key) { list.innerHTML = '<p class="heads-msg">Add your Google API key in Setup & settings (page footer) to load live and recent programs.</p>'; fl.innerHTML = ''; return; }
    if (!state.feed) { list.innerHTML = '<p class="heads-msg">Loading…</p>'; return; }
    const st = [['all', 'All'], ['live', 'Live now'], ['upcoming', 'Coming up'], ['none', 'Recently aired']];
    fl.innerHTML = st.map(([k, l]) => `<button type="button" class="pill${state.sched.status === k ? ' on' : ''}" data-st="${k}">${l}</button>`).join('') +
      `<select id="schedOutlet" aria-label="Outlet"><option value="all">All outlets</option>${state.outlets.filter(o => o.type === 'yt-channel').map(o => `<option value="${o.id}"${state.sched.outlet === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
    fl.querySelectorAll('.pill').forEach(b => b.addEventListener('click', () => { state.sched.status = b.dataset.st; renderSched(); }));
    $('#schedOutlet').addEventListener('change', e => { state.sched.outlet = e.target.value; renderSched(); });
    const rank = { live: 0, upcoming: 1, none: 2 };
    let items = state.feed.filter(v => !isShort(v) && (state.sched.status === 'all' || v.status === state.sched.status) && (state.sched.outlet === 'all' || v.outlet === state.sched.outlet));
    items.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'upcoming' ? new Date(whenOf(a)) - new Date(whenOf(b)) : new Date(whenOf(b)) - new Date(whenOf(a))));
    items = items.slice(0, 60);
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<p class="heads-msg">Nothing found for this filter.</p>'; return; }
    items.forEach(v => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'row-item';
      const badge = v.status === 'live' ? '<span class="bd live-bd">LIVE</span>' : v.status === 'upcoming' ? '<span class="bd up-bd">UPCOMING</span>' : '<span class="bd rec-bd">RECORDED</span>';
      b.innerHTML = `<img src="${esc(v.thumb || '')}" alt=""><span class="ri-main"><span class="ri-title">${esc(v.title)}</span><span class="ri-sub">${esc(outletName(v.outlet))} · ${esc(fmtWhen(whenOf(v)))}${v.duration && v.status === 'none' ? ' · ' + fmt(v.duration) : ''}</span></span>${badge}<span class="ri-go">Watch + check ▸</span>`;
      b.addEventListener('click', () => openVideo(v, { live: v.status === 'live' }));
      list.appendChild(b);
    });
  }
  function renderTop() {
    const g = $('#topGrid');
    if (!S.key) { g.innerHTML = '<p class="heads-msg">Add your Google API key in Setup & settings (page footer) to load stories.</p>'; return; }
    if (!state.feed) { g.innerHTML = '<p class="heads-msg">Loading…</p>'; return; }
    g.innerHTML = '';
    state.outlets.filter(o => o.type === 'yt-channel').forEach(o => {
      const vids = state.feed.filter(v => v.outlet === o.id && !isShort(v) && cfg.politics.test(v.title))
        .sort((a, b) => (b.status === 'live') - (a.status === 'live') || new Date(whenOf(b)) - new Date(whenOf(a))).slice(0, 3);
      const card = document.createElement('div'); card.className = 'topcard';
      card.innerHTML = `<h3>${esc(o.name)}</h3>`;
      if (!vids.length) card.insertAdjacentHTML('beforeend', '<p class="heads-msg">No political stories in recent uploads.</p>');
      vids.forEach((v, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'story';
        b.innerHTML = `<span class="n">${i + 1}</span><span>${esc(v.title)}${v.status === 'live' ? ' <span class="bd live-bd">LIVE</span>' : ''}</span>`;
        b.addEventListener('click', () => openVideo(v, { live: v.status === 'live' }));
        card.appendChild(b);
      });
      g.appendChild(card);
    });
  }
  /* ---------- trending political videos (top of page) ---------- */
  const fmtViews = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n || 0);
  const ago = iso => { const h = Math.max(1, Math.round((Date.now() - new Date(iso)) / 3600000)); return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago'; };
  function renderTrending() {
    const box = $('#trendList'); box.innerHTML = '';
    const items = state.trend || [];
    if (!items.length) { box.innerHTML = '<p class="heads-msg">No trending political videos found.</p>'; return; }
    items.forEach((v, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tcard';
      b.innerHTML = `<span class="rk">#${i + 1}</span><img src="${esc(v.thumb || '')}" alt=""><span class="tt">${esc(v.title)}</span><span class="ts2">${esc(v.channel)} · ${fmtViews(v.views)} views · ${esc(ago(v.publishedAt))}</span>`;
      b.addEventListener('click', () => openVideo(v, { live: v.status === 'live' }));
      box.appendChild(b);
    });
  }
  async function loadTrending(force) {
    const box = $('#trendList');
    if (!S.key) { box.innerHTML = '<p class="heads-msg">Add your Google API key in Setup &amp; settings (page footer) to load trending videos.</p>'; return; }
    box.innerHTML = '<p class="heads-msg">Loading…</p>';
    try { state.trend = await V.yt.trending(force); renderTrending(); }
    catch (e) { box.innerHTML = `<p class="heads-msg">Could not load trending videos: ${esc(e.message)}</p>`; }
  }
  function renderShorts() {
    const g = $('#shortsGrid');
    if (!S.key) { g.innerHTML = '<p class="heads-msg">Add your Google API key in Setup & settings (page footer) to load Shorts. You can also paste any Shorts link in the box at the top.</p>'; return; }
    if (!state.shorts) { g.innerHTML = '<p class="heads-msg">Loading…</p>'; return; }
    g.innerHTML = '';
    if (!state.shorts.length) { g.innerHTML = '<p class="heads-msg">No Shorts found.</p>'; return; }
    state.shorts.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).forEach(v => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'short';
      b.innerHTML = `<span class="sh-img"><img src="${esc(v.thumb || '')}" alt=""><span class="sh-dur">${fmt(v.duration)}</span></span><span class="sh-title">${esc(v.title)}</span><span class="sh-src">${esc(outletName(v.outlet))}</span>`;
      b.addEventListener('click', () => openVideo(v, { short: true }));
      g.appendChild(b);
    });
  }
  function setTab(t) {
    state.tab = t;
    document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    $('#panelSched').hidden = t !== 'sched'; $('#panelTop').hidden = t !== 'top'; $('#panelShorts').hidden = t !== 'shorts';
    if (S.key && ((t === 'shorts' && !state.shorts) || (t !== 'shorts' && !state.feed))) loadBrowse(false);
    else { renderSched(); renderTop(); renderShorts(); }
  }

  /* ================= DEMO + MIC ================= */
  function runDemo() {
    reset(); state.mode = 'session'; state.live = false; ensureSession();
    const gen = Q.gen;
    cfg.demo.forEach((d, i) => state.timers.push(setTimeout(() => makeDemo(d, gen), 1200 + i * 4200)));
    toast('Demo running: scripted sample claims, not real checks.');
  }
  function makeDemo(d, gen) {
    ensureSession();
    const L = { t: sessionT(), speaker: d.s, text: d.text, sents: [d.text], cards: {} };
    const el = document.createElement('p'); el.className = 'line';
    el.innerHTML = `<button type="button" class="sp">${esc(state.debate ? state.names[d.s] : fmt(L.t))}</button><span class="tx"></span>`; L.el = el; state.lines.push(L);
    if (d.v) { const c = newCard(d.text, d.s, L.t, L); L.cards[d.text] = c; setTimeout(() => { if (gen === Q.gen) resolve(c, d.v, esc(d.note), []); }, 1400); }
    renderLine(L); $('#capBody').appendChild(el); const b = $('#capBody'); b.scrollTop = b.scrollHeight; schedule();
  }

  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition, btn = $('#btnMic');
    if (!SR) { toast('Speech recognition is not supported in this browser. Try Chrome or Edge.'); return; }
    if (state.rec) { state.rec.stop(); return; }
    if (state.mode !== 'session') { reset(); state.mode = 'session'; state.live = false; }
    const rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], txt = r[0].transcript.trim(); if (!txt) continue;
        if (r.isFinal) { if (interimEl) { interimEl.remove(); interimEl = null; } splitSentences(txt).forEach(s => liveLine(s, $('#who').value)); }
        else {
          ensureSession();
          if (!interimEl) { interimEl = document.createElement('p'); interimEl.className = 'line interim'; interimEl.innerHTML = '<span class="sp">\u2026</span><span class="tx"></span>'; placeLine(interimEl); }
          interimEl.querySelector('.tx').textContent = txt; scrollLatest();
        }
      }
    };
    rec.onerror = e => { if (e.error !== 'no-speech') toast('Microphone: ' + e.error); };
    rec.onend = () => { state.rec = null; btn.textContent = 'Listen (mic)'; btn.setAttribute('aria-pressed', 'false'); };
    state.newestFirst = true;
    try { rec.start(); state.rec = rec; btn.textContent = 'Stop listening'; btn.setAttribute('aria-pressed', 'true'); ensureSession(); setStatus('microphone'); toast('Listening. Play the audio through speakers so the microphone can hear it.'); }
    catch { toast('Could not start the microphone.'); }
  }

  /* ================= LIVE AUDIO: cloud (Deepgram) and free (on-device Whisper) ================= */
  const LOCAL_LABEL = 'Tab audio: free', CLOUD_LABEL = 'Tab audio: cloud';
  let tab = null, local = null, lw = null, lwReady = null, lwModel = '', lwFiles = {}, lwDevice = '', liveCount = 0;

  function placeLine(el) { const b = $('#capBody'); if (state.newestFirst) b.insertBefore(el, b.firstChild); else b.appendChild(el); }
  function scrollLatest() { const b = $('#capBody'); b.scrollTop = state.newestFirst ? 0 : b.scrollHeight; }
  function showBanner(msg) { $('#audioBannerText').textContent = msg; $('#audioBanner').hidden = false; }
  function hideBanner() { $('#audioBanner').hidden = true; }

  // Time of a statement: the video's own clock when this page is playing it, otherwise time since capture began.
  function clockNow(self, startMs) {
    if (self && state.mode === 'video' && player && player.getPlayerState) {
      try { if (player.getPlayerState() === 1) { const c = curTime(); if (c != null) return c; } } catch {}
    }
    return self ? (Date.now() - startMs) / 1000 : sessionT();
  }
  function prepCapture(self) {
    if (state.mode === 'doc' || (!self && state.mode !== 'session')) { reset(); state.mode = 'session'; state.live = false; }
    document.querySelectorAll('#capBody .empty').forEach(e => e.remove());
    state.newestFirst = true;
    if (!self) ensureSession();
    setStatus('listening');
  }
  // Chrome always shows its own share prompt and a website cannot answer it for you. These hints make it as short as Chrome allows:
  // the "Chrome Tab" page is pre-selected, whole-screen options are hidden, and the tab's audio is requested without Chrome's
  // echo cancellation / noise suppression / gain control, which distort tab audio and hurt speech recognition.
  const shareOpts = self => ({
    video: { width: 2, height: 2, frameRate: 1, displaySurface: 'browser' },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    systemAudio: 'exclude', monitorTypeSurfaces: 'exclude', surfaceSwitching: 'exclude',
    ...(self ? { preferCurrentTab: true, selfBrowserSurface: 'include' } : {})
  });
  const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  function ingestLive(text, speaker, t) {
    document.querySelectorAll('#capBody .empty').forEach(e => e.remove());
    makeLine(text, t != null ? Math.max(0, t) : (state.mode === 'video' ? (curTime() || 0) : sessionT()), speaker);
    scrollLatest(); schedule();
    if (++liveCount % 6 === 0) state.flags = V.flags.video(state.video || { title: '' }, transcriptText());
  }

  // Best free engine first: hosted Whisper through the service (Groq / Workers AI), then Deepgram if its key is set,
  // then the on-device model.
  const hasRemote = () => !!(S.worker && V.info && (V.info.groq || V.info.workersAi));
  async function startAudio(self, quiet) {
    // The service info loads in the background; give it a moment so we pick the right engine (Chrome needs the share prompt soon after the click).
    if (V.infoPending) await Promise.race([V.infoPending, new Promise(r => setTimeout(r, 1500))]);
    const dg = !!(V.info && V.info.deepgram), eng = S.engine || 'auto';
    const useDeepgram = eng === 'deepgram' ? dg : eng === 'whisper' ? false : dg;      // auto: Deepgram (Nova-3) whenever its key is set
    return useDeepgram || !hasRemote() && dg ? startCloud({ self, quiet }) : startLocal({ self, quiet });
  }

  // 16-bit mono WAV from 16 kHz samples (what the speech service accepts).
  function wavBlob(f32, rate) {
    const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), true);
    return new Blob([buf], { type: 'audio/wav' });
  }
  V.wavBlob = wavBlob;

  /* ---------- cloud ---------- */
  function stopTab(flush = true) {
    if (!tab) return;
    const t = tab; tab = null;
    if (t.Dg) { if (flush) flushTail(t.Dg); else clearTimeout(t.Dg.tailTimer); }
    try { if (t.ws.readyState === 1) t.ws.send(JSON.stringify({ type: 'CloseStream' })); t.ws.close(); } catch {}
    try { t.proc.disconnect(); t.ctx.close(); } catch {}
    try { t.stream.getTracks().forEach(x => x.stop()); } catch {}
    if (interimEl) { interimEl.remove(); interimEl = null; }
    const btn = $('#btnTab'); btn.textContent = CLOUD_LABEL; btn.setAttribute('aria-pressed', 'false');
    setStatus('');
  }
  async function startCloud(opts = {}) {
    const self = !!opts.self, bail = msg => { if (opts.quiet) showBanner(msg); else toast(msg); return false; };
    if (!S.worker) return bail('Live capture needs the transcript service. Add its address in Setup & settings (page footer).');
    if (!canShare()) return bail('This browser cannot share tab audio. Use Chrome.');
    stopLocal();
    let token;
    try { token = await V.yt.deepgramToken(); } catch (e) { return bail('Could not start cloud transcription: ' + e.message); }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia(shareOpts(self)); }
    catch { return bail('Choose "Share" so Veritas can hear this tab. Click Start transcription to try again.'); }
    const at = stream.getAudioTracks();
    if (!at.length) { stream.getTracks().forEach(x => x.stop()); return bail('No audio was shared. Choose the tab and tick "Also share tab audio".'); }
    prepCapture(self); hideBanner();
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(new MediaStream(at));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const params = ['encoding=linear16', 'sample_rate=16000', 'channels=1', 'model=nova-3', 'language=en-US', 'punctuate=true', 'interim_results=true', 'endpointing=700', 'utterance_end_ms=1500', 'smart_format=true', 'diarize=true'].join('&');
    const ws = new WebSocket('wss://api.deepgram.com/v1/listen?' + params, ['bearer', token]);
    const startMs = Date.now();
    const Dg = { tail: '', tailT: null, tailTimer: 0, spk: 'A' };
    tab = { stream, ctx, proc, ws, Dg };
    let buf = '', bufStart = null, spk = 'A', base = 0;
    // Deepgram's final pieces go through the same complete-sentence assembly as Whisper. A pause of 1.5 s releases anything held back.
    const flush = force => {
      const text = buf.trim(), t = bufStart != null ? base + bufStart : clockNow(self, startMs);
      buf = ''; bufStart = null;
      if (text) feedSpeech(Dg, text, t, Math.max(1, wc(text) / 2.5), spk);
      if (force) flushTail(Dg);
    };
    ws.onopen = () => {
      base = clockNow(self, startMs);
      proc.onaudioprocess = e => {
        if (ws.readyState !== 1) return;
        const f = e.inputBuffer.getChannelData(0), i16 = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) i16[i] = Math.max(-32768, Math.min(32767, f[i] * 32768));
        ws.send(i16.buffer);
      };
      src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
      const btn = $('#btnTab'); btn.textContent = 'Stop capture'; btn.setAttribute('aria-pressed', 'true');
      setStatus('cloud transcription · live');
    };
    ws.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'UtteranceEnd') { flush(true); return; }
      const alt = d.channel && d.channel.alternatives && d.channel.alternatives[0];
      if (!alt || !alt.transcript) return;
      const w0 = alt.words && alt.words[0]; if (w0 && w0.speaker != null) spk = w0.speaker === 1 ? 'B' : 'A';
      const text = alt.transcript.trim(); if (!text) return;
      if (d.is_final) { if (!buf) bufStart = w0 ? w0.start : null; buf += (buf ? ' ' : '') + text; if (d.speech_final) flush(false); }
      else {
        if (!interimEl) { document.querySelectorAll('#capBody .empty').forEach(e => e.remove()); interimEl = document.createElement('p'); interimEl.className = 'line interim'; interimEl.innerHTML = '<span class="sp">…</span><span class="tx"></span>'; placeLine(interimEl); }
        interimEl.querySelector('.tx').textContent = [Dg.tail, buf, text].filter(Boolean).join(' '); scrollLatest();
      }
    };
    ws.onerror = () => toast('Live transcription connection problem.');
    ws.onclose = () => { if (tab && tab.ws === ws) { toast('Live transcription stopped.'); stopTab(); } };
    at[0].addEventListener('ended', () => { if (tab && tab.stream === stream) stopTab(); });
    return true;
  }
  function toggleTab() { if (tab) stopTab(); else startCloud({ self: false, quiet: false }); }

  /* ---------- free: on-device model ---------- */
  function killLocalWorker() { if (lw) { lw.terminate(); lw = null; lwReady = null; } }
  function ensureWorker() {
    if (lw && lwModel === S.localModel) return lwReady;
    killLocalWorker(); lwModel = S.localModel; lwFiles = {};
    lw = new Worker('assets/whisper-worker.js', { type: 'module' });
    lwReady = new Promise((resolve, reject) => {
      lw.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress') {
          const p = m.p || {};
          if (p.status === 'progress' && p.total) {
            lwFiles[p.file] = { l: p.loaded, t: p.total };
            const l = Object.values(lwFiles).reduce((a, f) => a + f.l, 0), t = Object.values(lwFiles).reduce((a, f) => a + f.t, 0);
            setStatus('downloading speech model ' + Math.round(l / t * 100) + '% (one time)');
          }
        } else if (m.type === 'ready') { lwDevice = m.device; resolve(m.device); }
        else if (m.type === 'result') onLocalResult(m);
        else if (m.type === 'error') { toast('Speech model: ' + m.message); reject(new Error(m.message)); }
      };
      lw.onerror = ev => reject(new Error(ev.message || 'the model worker could not start'));
      lw.postMessage({ type: 'load', model: S.localModel });
    });
    return lwReady;
  }
  /* Complete thoughts: speech arrives in 4-8 second pieces that rarely end where a sentence ends. Words after the last
     sentence end are held back (and shown greyed) and joined to the next piece; fragments under 5 words are joined to the
     next sentence; a held-back tail is released after 7 s of silence, at 45 words, or when capture stops. */
  const SENT_END = /[.!?…]["'”’)\]]*$/;
  const wc = t => (t.match(/\S+/g) || []).length;
  function clearInterim() { if (interimEl) { interimEl.remove(); interimEl = null; } }
  function showInterim(text) {
    document.querySelectorAll('#capBody .empty').forEach(e => e.remove());
    if (!interimEl) { interimEl = document.createElement('p'); interimEl.className = 'line interim'; interimEl.innerHTML = '<span class="sp">…</span><span class="tx"></span>'; placeLine(interimEl); }
    interimEl.querySelector('.tx').textContent = text; scrollLatest();
  }
  function assemble(tail, tailT, text, t0, secs) {
    const tailWords = tail ? wc(tail) : 0, newWords = Math.max(1, wc(text));
    const parts = splitSentences((tail ? tail + ' ' : '') + text);
    let seen = 0;
    const timed = parts.map(p => { const at = seen; seen += wc(p); return { text: p, t: at < tailWords ? tailT : t0 + Math.max(0, (at - tailWords) / newWords) * secs }; });
    let rest = null;
    if (timed.length && !SENT_END.test(timed[timed.length - 1].text)) rest = timed.pop();       // unfinished: hold back
    const out = []; let acc = null;
    timed.forEach(p => {
      acc = acc ? { t: acc.t, text: acc.text + ' ' + p.text } : { ...p };
      if (wc(acc.text) >= 5) { out.push(acc); acc = null; }
    });
    if (acc) {
      if (rest) rest = { t: acc.t, text: acc.text + ' ' + rest.text };
      else if (out.length) out[out.length - 1].text += ' ' + acc.text;
      else out.push(acc);
    }
    if (rest && wc(rest.text) >= 45) { out.push(rest); rest = null; }                              // a run-on: do not hold it forever
    return { out, rest };
  }
  function feedSpeech(L, text, t0, secs, spk) {
    if (spk) L.spk = spk;
    const r = assemble(L.tail, L.tailT, text, t0, secs);
    clearInterim();
    r.out.forEach(p => ingestLive(p.text, L.spk || 'A', p.t));
    L.tail = r.rest ? r.rest.text : ''; L.tailT = r.rest ? r.rest.t : null;
    clearTimeout(L.tailTimer);
    if (L.tail) { showInterim(L.tail); L.tailTimer = setTimeout(() => flushTail(L), L.remote ? 17000 : 7000); }
  }
  function flushTail(L) {
    clearTimeout(L.tailTimer);
    if (!L.tail) return;
    const text = L.tail, t = L.tailT; L.tail = ''; L.tailT = null;
    clearInterim(); ingestLive(text, L.spk || 'A', t);
  }
  V.assemble = assemble;
  const HALLUCINATION = /^\s*(\[[^\]]*\]|\([^)]*\)|thank you\.?|thanks for watching\.?|thanks\.?|you\.?|bye\.?|\.+)\s*$/i;
  function onLocalResult(m) {
    const L = local; if (!L) return;
    const rec = L.pend && L.pend.id === m.id ? L.pend : null;
    L.busy = false; L.pend = null;
    let lag = 0;
    if (rec) {
      const dur = (performance.now() - rec.sent) / 1000; L.avg = L.avg ? L.avg * 0.6 + dur * 0.4 : dur;
      lag = (performance.now() - rec.heard) / 1000;
    }
    const text = (m.text || '').replace(/\s+/g, ' ').trim();
    if (rec && text && !HALLUCINATION.test(text)) feedSpeech(L, text, rec.t, Math.max(1, rec.secs));
    if (m.via) L.via = m.via;
    if (L.remote) setStatus(`free cloud Whisper${L.via ? ' (' + L.via + ')' : ''} · about ${Math.round(lag)}s behind${L.via === 'workers-ai' ? ' · slower backup engine, add GROQ_API_KEY' : ''}`);
    else setStatus(`free mode · about ${Math.round(lag)}s behind${lwDevice === 'wasm' ? ' (CPU)' : ''}${L.avg > V.config.local.maxSec ? ' · this device is slow, try cloud mode' : ''}`);
    L.pump();
  }
  // Hosted Whisper: send one chunk to the service and feed the answer back through the same path as the on-device model.
  // What Whisper is told about the audio: the video title and the words just before this piece (keeps names and sentences consistent).
  function whisperPrompt(L) {
    const title = state.video && state.video.title ? state.video.title + '.' : '';
    const prev = state.lines.slice(-2).map(x => x.text).join(' ');
    return (title + ' ' + prev + ' ' + (L.tail || '')).replace(/\s+/g, ' ').trim().slice(-380);
  }
  async function sendRemote(L, id, audio) {
    let text = '', failed = '', via = '';
    try {
      const pr = whisperPrompt(L);
      const r = await fetch(S.worker.replace(/\/$/, '') + '/transcribe' + (pr ? '?p=' + encodeURIComponent(pr) : ''), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavBlob(audio, 16000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { text = j.text || ''; via = j.via || ''; }
      else {
        failed = (j && j.error) || ('status ' + r.status);
        if (r.status === 429) L.holdUntil = performance.now() + Math.max(2, Math.min(30, j.retryAfter || 5)) * 1000;
        else if (++L.fails >= 3) L.holdUntil = performance.now() + 10000;
      }
    } catch (e) { failed = e.message || 'network error'; if (++L.fails >= 3) L.holdUntil = performance.now() + 10000; }
    if (local !== L) return;
    if (failed) {
      if (L.pend && L.pend.id === id) L.pend = null;
      L.busy = false; L.lost++;
      // Keep the audio and try again shortly, so a rate limit or a brief outage does not lose words.
      const back = []; for (let i = 0; i < audio.length; i += 4096) back.push({ f: audio.slice(i, i + 4096), quiet: false });
      L.blocks.unshift(...back);
      setStatus('cloud Whisper problem: ' + failed.slice(0, 120) + (L.holdUntil > performance.now() ? ' · retrying shortly' : ''));
      if (L.lost === 1 || L.lost % 5 === 0) toast('Transcription service: ' + failed.slice(0, 160));
      setTimeout(() => { if (local === L) L.pump(); }, Math.max(300, (L.holdUntil || 0) - performance.now()));
      return;
    }
    L.fails = 0;
    onLocalResult({ id, text, via: via });
  }
  function stopLocal(flush = true) {
    if (!local) return;
    const L = local; local = null;
    if (flush) flushTail(L); else clearTimeout(L.tailTimer);
    clearInterim();
    try { L.proc.disconnect(); L.ctx.close(); } catch {}
    try { L.stream.getTracks().forEach(x => x.stop()); } catch {}
    const btn = $('#btnLocal'); btn.textContent = LOCAL_LABEL; btn.setAttribute('aria-pressed', 'false'); btn.disabled = false;
    setStatus('');
  }
  async function startLocal(opts = {}) {
    const self = !!opts.self, bail = msg => { if (opts.quiet) showBanner(msg); else toast(msg); return false; };
    if (!canShare()) return bail('This browser cannot share tab audio. Use Chrome.');
    const remote = hasRemote();
    if (!remote && !window.Worker) return bail('This browser cannot run the on-device model.');
    stopTab();
    let stream;                      // ask for the audio first: Chrome only allows this right after a click
    try { stream = await navigator.mediaDevices.getDisplayMedia(shareOpts(self)); }
    catch { return bail('Choose "Share" so Veritas can hear this tab. Click Start transcription to try again.'); }
    const at = stream.getAudioTracks();
    if (!at.length) { stream.getTracks().forEach(x => x.stop()); return bail('No audio was shared. Choose the tab and tick "Also share tab audio".'); }
    prepCapture(self); hideBanner();
    const cfgL = remote ? V.config.remote : V.config.local, BLOCK = 4096, SEC = BLOCK / 16000, startMs = Date.now();
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(new MediaStream(at));
    const proc = ctx.createScriptProcessor(BLOCK, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const L = local = { stream, ctx, proc, blocks: [], ready: false, busy: true, avg: 0, seq: 0, pend: null, remote, fails: 0, holdUntil: 0, lost: 0, tail: '', tailT: null, tailTimer: 0 };
    const btn = $('#btnLocal'); btn.textContent = 'Stop free capture'; btn.setAttribute('aria-pressed', 'true');

    const send = cut => {
      const t = clockNow(self, startMs) - L.blocks.length * SEC;      // when the first buffered block was heard
      const heardEnd = performance.now() - (L.blocks.length - cut) * SEC * 1000;
      const part = L.blocks.splice(0, cut);
      if (!part.some(b => !b.quiet)) { L.pump(); return; }              // only silence: skip it
      const audio = new Float32Array(part.length * BLOCK);
      part.forEach((b, i) => audio.set(b.f, i * BLOCK));
      const id = ++L.seq; L.busy = true;
      L.pend = { id, t: Math.max(0, t), secs: part.length * SEC, sent: performance.now(), heard: heardEnd };
      if (L.remote) sendRemote(L, id, audio);
      else lw.postMessage({ type: 'run', id, audio }, [audio.buffer]);
    };
    // Whenever the model is idle, send everything heard so far, cut at the last pause so words are not split.
    L.pump = () => {
      if (local !== L || !L.ready || L.busy || performance.now() < L.holdUntil) return;
      const bl = L.blocks, n = bl.length;
      if (n * SEC < cfgL.minSec) return;
      let tail = 0; for (let i = n - 1; i >= 0 && bl[i].quiet; i--) tail++;
      let cut = 0;
      if (tail >= 2) cut = n;
      else {
        for (let i = n - 1; i >= 0; i--) { if (bl[i].quiet && (i + 1) * SEC >= cfgL.minSec) { cut = i + 1; break; } }
        if (!cut && n * SEC >= cfgL.maxSec) {          // no pause for a long time: cut at the quietest moment of the last 3 s so a word is not split
          let best = n - 1, bv = Infinity;
          for (let i = n - 1; i >= Math.max(0, n - Math.round(3 / SEC)); i--) if ((i + 1) * SEC >= cfgL.minSec && bl[i].r < bv) { bv = bl[i].r; best = i; }
          cut = best + 1;
        }
      }
      if (!cut) return;
      send(Math.min(cut, Math.floor(cfgL.hardSec / SEC)));
    };
    proc.onaudioprocess = e => {
      if (local !== L) return;
      const f = new Float32Array(e.inputBuffer.getChannelData(0));
      let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
      const rms = Math.sqrt(s / f.length);
      L.blocks.push({ f, quiet: rms < cfgL.quietRms, r: rms });
      if (L.blocks.length > 120 / SEC) L.blocks.splice(0, 40);           // never hold more than about two minutes
      L.pump();
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    at[0].addEventListener('ended', () => { if (local === L) stopLocal(); });
    if (remote) { L.ready = true; L.busy = false; setStatus('free cloud Whisper · listening'); return true; }
    setStatus(lw && lwModel === S.localModel ? 'free mode · listening' : 'loading speech model (first time only)');
    ensureWorker().then(() => { if (local === L) { L.ready = true; L.busy = false; V.store.set('localUsed', true); setStatus('free mode · listening'); L.pump(); } })
      .catch(e => { if (local === L) { toast('Could not load the speech model: ' + e.message + '. It needs access to cdn.jsdelivr.net and huggingface.co.'); killLocalWorker(); stopLocal(); } });
    return true;
  }
  function toggleLocal() { if (local) stopLocal(); else startLocal({ self: false, quiet: false }); }

  /* ================= SETUP SELF-TEST ================= */
  async function selfTest() {
    const out = $('#selfTest'); out.innerHTML = '';
    const key = $('#keyInput').value.trim(), worker = $('#workerInput').value.trim().replace(/\/$/, '');
    const add = (cls, msg) => { const li = document.createElement('li'); li.className = cls; li.textContent = (cls === 'ok' ? '✓ ' : cls === 'bad' ? '✗ ' : '! ') + msg; out.appendChild(li); };
    const get = async u => { const r = await fetch(u); let j = {}; try { j = await r.json(); } catch {} return { r, j }; };
    const errMsg = (r, j) => (j.error && (j.error.message || j.error)) || ('status ' + r.status);
    if (!key) add('bad', 'No Google API key entered.');
    else {
      try { const { r, j } = await get(`https://factchecktools.googleapis.com/v1alpha1/claims:search?query=vaccines&pageSize=1&key=${encodeURIComponent(key)}`); r.ok ? add('ok', 'Fact Check Tools API works') : add('bad', 'Fact Check Tools API: ' + errMsg(r, j)); } catch (e) { add('bad', 'Fact Check Tools API: ' + e.message); }
      try { const { r, j } = await get(`https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(key)}`); r.ok ? add('ok', 'YouTube Data API works') : add('bad', 'YouTube Data API: ' + errMsg(r, j)); } catch (e) { add('bad', 'YouTube Data API: ' + e.message); }
    }
    if (!worker) add('bad', 'No transcript service address entered.');
    else {
      try {
        const { r, j } = await get(worker + '/');
        if (!r.ok || !j.ok) add('bad', 'Transcript service: ' + errMsg(r, j));
        else {
          add('ok', 'Transcript service is running');
          add(j.anthropic || j.judge ? 'ok' : 'warn', j.anthropic ? 'Claim research key is set (AI research tier on)' : j.judge === 'gemini' ? 'Claim research runs on your Gemini key (free tier: Google Search when your key allows it, otherwise the model’s own knowledge)' : j.judge === 'groq' ? 'Claim research runs on your Groq key (free, limited: Wikipedia excerpts only, no web search)' : 'No claim research key. Without GEMINI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY only published fact-checks are used');
          add(j.supadata ? 'ok' : 'warn', j.supadata ? 'Hosted caption provider key is set' : 'Hosted caption provider key (SUPADATA_API_KEY) is not set. Recommended: YouTube often blocks direct caption access');
          if (j.groq || j.workersAi) {
            if (!j.groq) add('warn', 'Groq key (GROQ_API_KEY) is NOT set on the worker, so only the slower Cloudflare backup is answering. Add the key for faster results (guide section 7)');
            add('ok', 'Free speech service is set up (' + [j.groq ? 'Groq' : '', j.workersAi ? 'Cloudflare Workers AI backup' : ''].filter(Boolean).join(' + ') + ')');
            try { // send one second of silence to prove the key works
              const r2 = await fetch(worker + '/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavBlob(new Float32Array(16000), 16000) });
              const j2 = await r2.json().catch(() => ({}));
              r2.ok ? add('ok', 'Speech test passed (answered by ' + (j2.via || 'the service') + (j2.fallback ? '; Groq failed: ' + j2.fallback : '') + ')') : add('bad', 'Speech test: ' + errMsg(r2, j2));
            } catch (e) { add('bad', 'Speech test: ' + e.message); }
          } else add('warn', 'Free speech service is not set up. Add GROQ_API_KEY to the worker (see GUIDE-CLOUDFLARE.md section 7). Until then, free mode runs on this device and is slower');
          add(j.deepgram ? 'ok' : 'warn', j.deepgram ? 'Deepgram key is set (optional)' : 'Deepgram key (DEEPGRAM_API_KEY) is not set. Optional');
          const t = await get(worker + '/transcript?v=dQw4w9WgXcQ');
          t.r.ok && t.j.segments ? add('ok', `Captions work (${t.j.segments.length} lines read${t.j.via ? ' via ' + t.j.via : ''})`) : add('bad', 'Captions: ' + errMsg(t.r, t.j));
        }
      } catch (e) { add('bad', 'Transcript service: ' + e.message + ' (check the address and ALLOWED_ORIGIN)'); }
    }
  }

  /* ================= WIRING ================= */
  function syncSeg() { document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.f === state.filter)); }

  $('#omni').addEventListener('submit', e => {
    e.preventDefault();
    const p = V.yt.parseLink($('#omniIn').value);
    if (p.kind === 'video') openVideo({ id: p.id, status: 'none' });
    else if (p.kind === 'short') openVideo({ id: p.id, status: 'none' }, { short: true });
    else if (p.kind === 'social') openSocial(p);
    else if (p.kind === 'article') openArticle(p.url);
    else if (p.kind === 'text') openText(p.text);
  });
  $('#btnDebate').addEventListener('click', e => {
    state.debate = !state.debate; e.currentTarget.setAttribute('aria-pressed', String(state.debate));
    $('#whoWrap').hidden = !state.debate; schedule();
  });
  $('#btnDemo').addEventListener('click', runDemo);
  $('#btnClear').addEventListener('click', () => { reset(); });
  $('#btnMic').addEventListener('click', toggleMic);
  $('#btnTab').addEventListener('click', toggleTab);
  $('#btnLocal').addEventListener('click', toggleLocal);
  $('#btnTest').addEventListener('click', selfTest);
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; syncSeg(); renderCards(); }));
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#btnRefresh').addEventListener('click', () => loadBrowse(true));
  $('#btnTrend').addEventListener('click', () => loadTrending(true));

  $('#btnSettings').addEventListener('click', () => { $('#selfTest').innerHTML = ''; $('#keyInput').value = S.key; $('#cxInput').value = S.cx; $('#modelInput').value = S.localModel; $('#engineInput').value = S.engine; $('#workerInput').value = S.worker; $('#dlgSettings').showModal(); });
  $('#saveKey').addEventListener('click', () => {
    S.key = $('#keyInput').value.trim(); S.cx = $('#cxInput').value.trim(); S.worker = $('#workerInput').value.trim();
    S.engine = $('#engineInput').value;
    const mdl = $('#modelInput').value; if (mdl !== S.localModel) { S.localModel = mdl; stopLocal(); killLocalWorker(); }
    V.saveSettings();
    toast('Saved in this browser.'); loadInfo(); state.feed = null; state.shorts = null; loadBrowse(true); loadTrending(false);
  });
  $('#btnText').addEventListener('click', () => $('#dlgText').showModal());
  $('#runText').addEventListener('click', () => { const t = $('#textIn').value.trim(); if (t) openText(t); });
  $('#btnAdd').addEventListener('click', () => $('#dlgAdd').showModal());
  $('#saveAdd').addEventListener('click', () => {
    const raw = $('#addRef').value.trim(); let o = null, m;
    if (/^UC[\w-]{20,}$/.test(raw)) o = { type: 'yt-channel', ref: raw };
    else if ((m = raw.match(/youtube\.com\/channel\/(UC[\w-]+)/))) o = { type: 'yt-channel', ref: m[1] };
    else if ((m = raw.match(/twitch\.tv\/(\w+)/))) o = { type: 'twitch', ref: m[1] };
    if (!o) { toast('Use a YouTube channel ID (starts with UC) or a Twitch link.'); return; }
    o = { id: 'c' + Date.now(), name: $('#addName').value.trim() || 'Custom stream', custom: true, ...o };
    state.outlets.push(o); V.store.set('custom', state.outlets.filter(x => x.custom));
    $('#addName').value = ''; $('#addRef').value = ''; selectOutlet(o);
  });

  function loadInfo() {
    V.info = null; V.infoPending = null;
    if (!S.worker) return;
    V.infoPending = fetch(S.worker.replace(/\/$/, '') + '/').then(r => r.json()).then(j => { if (j && j.ok) V.info = j; }).catch(() => {}).then(() => { V.infoPending = null; });
  }
  $('#socialStart').addEventListener('click', () => startAudio(false, false));
  $('#audioBannerBtn').addEventListener('click', () => { hideBanner(); startAudio(true, false); });
  loadInfo();
  if (V.store.get('localUsed', false) && 'Worker' in window) setTimeout(() => { if (!hasRemote() && !(V.info && V.info.deepgram)) ensureWorker().catch(() => {}); }, 2500);
  renderOutlets(); renderMeters(); renderTimeline(); renderCards();
  loadTrending(false);
  loadBrowse(false);
})();
