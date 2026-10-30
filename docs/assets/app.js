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
    feed: null, shorts: null, tab: 'sched', sched: { status: 'all', outlet: 'all' }
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
  const EMPTY = '<p class="empty">Pick a program below, paste a link above, or press <b>Run demo</b> to see sample checks.</p>';

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
    if (o.type === 'yt-video') return `https://www.youtube.com/embed/${encodeURIComponent(o.ref)}?rel=0&playsinline=1&enablejsapi=1` + originParam();
    if (o.type === 'twitch') return `https://player.twitch.tv/?channel=${encodeURIComponent(o.ref)}&parent=${encodeURIComponent(location.hostname || 'localhost')}&autoplay=false`;
    return 'about:blank';
  }
  const openUrl = o => o.type === 'yt-channel' ? `https://www.youtube.com/channel/${o.ref}/live` : o.type === 'yt-video' ? `https://www.youtube.com/watch?v=${o.ref}` : `https://www.twitch.tv/${o.ref}`;

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
    f.hidden = false; $('#articleBox').hidden = true;
    f.onload = () => attach();
    f.src = embedUrl(o);
    const a = $('#openYT'); a.hidden = false; a.href = openUrl(o); a.textContent = o.type === 'twitch' ? 'Open on Twitch ↗' : 'Open on YouTube ↗';
  }
  const curTime = () => { try { return player && player.getCurrentTime ? player.getCurrentTime() : null; } catch { return null; } };
  function seek(t) { try { if (player && player.seekTo) { player.seekTo(t, true); player.playVideo(); } } catch {} }

  /* ================= SESSION RESET ================= */
  const Q = { items: [], active: 0, max: 3, gen: 0 };
  function reset() {
    clearInterval(state.pollTimer); state.pollTimer = null;
    if (state.rec) { try { state.rec.stop(); } catch {} }
    Q.items.length = 0; Q.gen++;
    state.cards = []; state.lines = []; state.seen = new Set(); state.flags = null; state.t0 = null;
    state.lastSegEnd = -1; state.docCount = 0; state.lastT = 0; state.activeLine = -1; cardSeq = 0; interimEl = null;
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
      const r = await V.checker.check(c.text);
      if (g !== Q.gen) return;
      resolve(c, r.verdict, r.detail, r.sources);
    } catch (e) {
      if (g !== Q.gen) return;
      resolve(c, 'NOMATCH', 'Lookup failed: ' + esc(e.message), []); errOnce(e.message);
    }
  }
  function resolve(c, verdict, detail, sources) {
    c.verdict = verdict; c.detail = detail || ''; c.sources = sources || [];
    if (c.line) renderLine(c.line);
    if ((verdict === 'FALSE' || verdict === 'MISLEADING') && state.mode !== 'video') showLower(c);
    if ((verdict === 'FALSE' || verdict === 'MISLEADING') && state.mode === 'video' && state.live) showLower(c);
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
    (frag || $('#capBody')).appendChild(el);
    return L;
  }
  function ensureSession() {
    if (!state.t0) { state.t0 = Date.now(); $('#capBody').innerHTML = ''; }
  }
  const sessionT = () => state.t0 ? (Date.now() - state.t0) / 1000 : 0;
  function liveLine(text, speaker) {
    ensureSession(); makeLine(text, sessionT(), speaker);
    const b = $('#capBody'); b.scrollTop = b.scrollHeight; schedule();
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
    setFrame({ type: 'yt-video', ref: m.id });
    $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#capBody').innerHTML = '<p class="empty">Reading captions…</p>';
    setStatus('loading');
    let meta = m;
    if (S.key && !m.description) { try { meta = (await V.yt.one(m.id)) || m; } catch {} }
    if (my !== state.openSeq) return;
    state.video = meta; state.duration = meta.duration || 0;
    if (meta.title) $('#nowPlaying').textContent = meta.title;
    if (meta.status === 'live') { state.live = true; $('#liveBadge').hidden = false; }

    let segs = null, auto = false;
    if (S.worker) {
      try { const tr = await V.yt.transcript(m.id); segs = tr.segments; auto = tr.auto; if (tr.live) state.live = true; }
      catch (e) { toast('Captions unavailable: ' + e.message); }
    }
    if (my !== state.openSeq) return;
    $('#capBody').innerHTML = '';
    if (segs && segs.length) {
      ingestSegments(segs, state.live);
      setStatus('captions' + (auto ? ' (auto-generated)' : ''));
      if (state.live) state.pollTimer = setInterval(pollLive, 20000);
    } else {
      ingestMetadata(meta);
      setStatus(S.worker ? 'metadata only (no captions found)' : 'metadata only · add a transcript service for full captions');
    }
    state.flags = V.flags.video(meta, transcriptText());
    if (!S.key) toast('Add a Google API key in Settings to look up fact-checks.');
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
    if (!S.key) toast('Add a Google API key in Settings to look up fact-checks.');
  }
  async function openArticle(url) {
    if (!S.worker) { toast('Add a Transcript service URL in Settings to fetch articles, or paste the text into Check text.'); return; }
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
      el.innerHTML = `<div class="vh">${ICON[c.verdict]}<span>${LABEL[c.verdict]}${sp}</span>${when ? `<button type="button" class="t">${when}</button>` : ''}</div>
        <div class="q">“${esc(c.text)}”</div>${tags}${c.detail ? `<div class="d">${c.detail}</div>` : ''}${srcs}`;
      const tb = el.querySelector('.t'); if (tb) tb.addEventListener('click', () => focusCard(c));
      box.appendChild(el);
    });
    if (!list.length) box.innerHTML = '<p class="fine">Nothing to show yet.</p>';
    const n = k => state.cards.filter(c => c.verdict === k).length;
    const T = n('TRUE'), M = n('MISLEADING'), F = n('FALSE'), R = n('REPORTED'), X = n('NOMATCH'), P = n('PENDING');
    $('#tally').innerHTML = `<div style="flex:${T};background:var(--true)"></div><div style="flex:${M};background:var(--mis)"></div><div style="flex:${F};background:var(--false)"></div><div style="flex:${R};background:var(--silver)"></div><div style="flex:${X};background:var(--none)"></div>`;
    $('#tallyTxt').textContent = state.cards.length ? `${T} true · ${M} misleading · ${F} false · ${R} related reporting · ${X} no match · ${P} checking` : 'No claims checked yet.';
  }

  const arc = (a1, a2) => {
    const p = a => [100 - 80 * Math.cos(a * Math.PI / 180), 100 - 80 * Math.sin(a * Math.PI / 180)];
    const [x1, y1] = p(a1), [x2, y2] = p(a2);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A80 80 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  function score(list) {
    const T = list.filter(c => c.verdict === 'TRUE').length, M = list.filter(c => c.verdict === 'MISLEADING').length, F = list.filter(c => c.verdict === 'FALSE').length;
    const n = T + M + F; return { n, s: n ? (T + 0.5 * M) / n : null };
  }
  function gauge(sc) {
    const rot = sc.s === null ? 0 : -90 + 180 * sc.s;
    return `<svg viewBox="0 0 200 115" role="img" aria-label="${sc.s === null ? 'No rated claims yet' : Math.round(sc.s * 100) + ' percent of rated claims held up'}">
      <path d="${arc(0, 58)}" stroke="var(--false)" stroke-width="16" fill="none"/><path d="${arc(62, 118)}" stroke="var(--mis)" stroke-width="16" fill="none"/><path d="${arc(122, 180)}" stroke="var(--true)" stroke-width="16" fill="none"/>
      <g class="needle" style="transform:rotate(${rot}deg)"><path d="M100 100 L100 32" stroke="#EEF2F7" stroke-width="4" stroke-linecap="round"/><circle cx="100" cy="100" r="8" fill="#EEF2F7"/></g></svg>`;
  }
  function renderMeters() {
    const box = $('#meters'), focus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.sp;
    const mk = (title, list, sp) => {
      const sc = score(list), head = sp ? `<input data-sp="${sp}" value="${esc(state.names[sp])}" aria-label="Name for speaker ${sp}">` : `<h3>${title}</h3>`;
      return `<div class="meter">${head}${gauge(sc)}<div class="val">${sc.s === null ? '—' : Math.round(sc.s * 100) + '%'}</div><div class="sub">${sc.n} rated · held up</div></div>`;
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
    const box = $('#outletList'); box.innerHTML = '';
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
    if (!S.key) { list.innerHTML = '<p class="heads-msg">Add your Google API key in Settings to load live and recent programs.</p>'; fl.innerHTML = ''; return; }
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
    if (!S.key) { g.innerHTML = '<p class="heads-msg">Add your Google API key in Settings to load stories.</p>'; return; }
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
  function renderShorts() {
    const g = $('#shortsGrid');
    if (!S.key) { g.innerHTML = '<p class="heads-msg">Add your Google API key in Settings to load Shorts. You can also paste any Shorts link in the box at the top.</p>'; return; }
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
          if (!interimEl) { interimEl = document.createElement('p'); interimEl.className = 'line interim'; interimEl.innerHTML = '<span class="sp"></span><span class="tx"></span>'; $('#capBody').appendChild(interimEl); }
          interimEl.querySelector('.tx').textContent = txt; const b = $('#capBody'); b.scrollTop = b.scrollHeight;
        }
      }
    };
    rec.onerror = e => { if (e.error !== 'no-speech') toast('Microphone: ' + e.error); };
    rec.onend = () => { state.rec = null; btn.textContent = 'Listen (mic)'; btn.setAttribute('aria-pressed', 'false'); };
    try { rec.start(); state.rec = rec; btn.textContent = 'Stop listening'; btn.setAttribute('aria-pressed', 'true'); ensureSession(); setStatus('microphone'); toast('Listening. Play the audio through speakers so the microphone can hear it.'); }
    catch { toast('Could not start the microphone.'); }
  }

  /* ================= WIRING ================= */
  function syncSeg() { document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.f === state.filter)); }

  $('#omni').addEventListener('submit', e => {
    e.preventDefault();
    const p = V.yt.parseLink($('#omniIn').value);
    if (p.kind === 'video') openVideo({ id: p.id, status: 'none' });
    else if (p.kind === 'short') openVideo({ id: p.id, status: 'none' }, { short: true });
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
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.f; syncSeg(); renderCards(); }));
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#btnRefresh').addEventListener('click', () => loadBrowse(true));

  $('#btnSettings').addEventListener('click', () => { $('#keyInput').value = S.key; $('#cxInput').value = S.cx; $('#workerInput').value = S.worker; $('#dlgSettings').showModal(); });
  $('#saveKey').addEventListener('click', () => {
    S.key = $('#keyInput').value.trim(); S.cx = $('#cxInput').value.trim(); S.worker = $('#workerInput').value.trim(); V.saveSettings();
    toast('Saved in this browser.'); state.feed = null; state.shorts = null; loadBrowse(true);
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

  renderOutlets(); renderMeters(); renderTimeline(); renderCards();
  selectOutlet(state.outlets[0]);
  loadBrowse(false);
})();
