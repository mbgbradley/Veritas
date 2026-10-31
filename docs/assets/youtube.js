/* YouTube data layer. Uses the visitor's own Google API key (their quota, not yours).
   Cost per full refresh: about 8 units for uploads + 3 for details. Shorts: 8 units. */
V.yt = (() => {
  const API = 'https://www.googleapis.com/youtube/v3';

  async function api(path, params) {
    const u = new URL(API + path);
    Object.entries({ ...params, key: V.settings.key }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message || 'YouTube API ' + r.status);
    return j;
  }

  // Classify what the user pasted.
  function parseLink(raw) {
    raw = (raw || '').trim();
    if (!raw) return { kind: 'empty' };
    let m;
    if ((m = raw.match(/youtube\.com\/shorts\/([\w-]{11})/))) return { kind: 'short', id: m[1] };
    if ((m = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:live|embed)\/)([\w-]{11})/))) return { kind: 'video', id: m[1] };
    if ((m = raw.match(/youtube\.com\/watch\?[^#]*\bv=([\w-]{11})/))) return { kind: 'video', id: m[1] };
    if (/^[\w-]{11}$/.test(raw) && !/\s/.test(raw) && /[A-Z0-9_-]/.test(raw)) return { kind: 'video', id: raw };
    if (/^https?:\/\//i.test(raw)) return { kind: 'article', url: raw };
    return { kind: 'text', text: raw };
  }

  const iso = d => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };

  async function playlist(id, max) {
    const j = await api('/playlistItems', { part: 'snippet,contentDetails', maxResults: max, playlistId: id });
    return (j.items || []).map(i => ({
      id: i.contentDetails.videoId, title: i.snippet.title,
      publishedAt: i.contentDetails.videoPublishedAt || i.snippet.publishedAt
    }));
  }

  async function details(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const j = await api('/videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') });
      (j.items || []).forEach(v => {
        const s = v.snippet, l = v.liveStreamingDetails || {};
        out[v.id] = {
          id: v.id, title: s.title, description: s.description || '', channel: s.channelTitle, channelId: s.channelId,
          publishedAt: s.publishedAt, duration: iso(v.contentDetails && v.contentDetails.duration),
          status: s.liveBroadcastContent || 'none',           // live | upcoming | none
          scheduledStart: l.scheduledStartTime || null, actualStart: l.actualStartTime || null, actualEnd: l.actualEndTime || null,
          thumb: (s.thumbnails.medium || s.thumbnails.default || {}).url
        };
      });
    }
    return out;
  }
  async function one(id) { const d = await details([id]); return d[id] || null; }

  const ssGet = k => { try { const v = JSON.parse(sessionStorage.getItem(k)); return v && Date.now() - v.t < 600000 ? v.d : null; } catch { return null; } };
  const ssSet = (k, d) => { try { sessionStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch {} };

  // Recent uploads (includes live streams and upcoming premieres) for every YouTube outlet.
  const inflight = {};
  const shared = (ck, fn) => inflight[ck] || (inflight[ck] = fn().finally(() => { delete inflight[ck]; }));
  function feed(outlets, force) { const ck = 'feed.' + outlets.map(o => o.ref).join(','); return shared(ck, () => feedRaw(outlets, force, ck)); }
  function shorts(outlets, force) { const ck = 'shorts.' + outlets.map(o => o.ref).join(','); return shared(ck, () => shortsRaw(outlets, force, ck)); }
  async function feedRaw(outlets, force, ck) {
    if (!force) { const c = ssGet(ck); if (c) return c; }
    const chans = outlets.filter(o => o.type === 'yt-channel');
    const lists = await Promise.all(chans.map(async o => {
      try { return (await playlist('UU' + o.ref.slice(2), 15)).map(v => ({ ...v, outlet: o.id })); } catch (e) { return []; }
    }));
    const flat = lists.flat();
    const det = await details([...new Set(flat.map(v => v.id))]);
    const items = flat.filter(v => det[v.id]).map(v => ({ ...det[v.id], outlet: v.outlet }));
    ssSet(ck, items);
    return items;
  }

  // Short-form videos only (the channel's Shorts playlist).
  async function shortsRaw(outlets, force, ck) {
    if (!force) { const c = ssGet(ck); if (c) return c; }
    const chans = outlets.filter(o => o.type === 'yt-channel');
    const lists = await Promise.all(chans.map(async o => {
      try { return (await playlist('UUSH' + o.ref.slice(2), 6)).map(v => ({ ...v, outlet: o.id })); } catch (e) { return []; }
    }));
    const flat = lists.flat();
    const det = await details([...new Set(flat.map(v => v.id))]);
    const items = flat.filter(v => det[v.id]).map(v => ({ ...det[v.id], outlet: v.outlet }));
    ssSet(ck, items);
    return items;
  }

  // Captions and articles come from the optional transcript service (worker/).
  async function transcript(id) {
    if (!V.settings.worker) throw new Error('No transcript service set');
    const r = await fetch(V.settings.worker.replace(/\/$/, '') + '/transcript?v=' + encodeURIComponent(id));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Transcript service error');
    return j;
  }
  async function article(url) {
    if (!V.settings.worker) throw new Error('No transcript service set');
    const r = await fetch(V.settings.worker.replace(/\/$/, '') + '/article?url=' + encodeURIComponent(url));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Article service error');
    return j;
  }

  async function deepgramToken() {
    if (!V.settings.worker) throw new Error('No transcript service set');
    const r = await fetch(V.settings.worker.replace(/\/$/, '') + '/deepgram-token');
    const j = await r.json();
    if (!r.ok || !j.token) throw new Error(j.error || 'Could not get a live-audio token');
    return j.token;
  }

  return { parseLink, one, details, feed, shorts, transcript, article, deepgramToken };
})();
