/* Red-flag detector: emotional triggers, too-good-to-be-true language, and out-of-context clues.
   These are warnings to look closer, never proof that something is false. */
V.flags = (() => {
  const EMOTION = /\b(outrage[ds]?|outrageous|shocking|shocked|furious|fury|terrifying|terrified|horrifying|disgusting|disgrace\w*|unbelievable|insane|evil|traitors?|enemy|enemies|destroy\w*|wake up|they(?:'re| are) (?:hiding|lying)|exposed|bombshell|you won'?t believe|share (?:this )?before|urgent|panic|nightmare|catastroph\w+|disaster|betray\w*|sickening|rage)\b/gi;
  const TOO_GOOD = /\b(miracle|cure[sd]?|secret|they don'?t want you to know|instantly|guaranteed|100 ?%|doctors hate|one weird trick|free money|get rich|overnight|impossible|never before seen|unheard of|giant|world record|banned|suppressed)\b/gi;
  const NOW = /\b(today|tonight|right now|this morning|this afternoon|just happened|happening now|breaking|yesterday|moments ago|minutes ago)\b/gi;

  const count = (re, s) => (s.match(re) || []).length;
  const words = s => (s.match(/\b[\w']+\b/g) || []).length;
  const ids = { emo: 'Emotional trigger', good: 'Too good to be true', now: 'Time claim' };

  // Tags for a single sentence (shown on cards).
  function sentence(text) {
    const out = [];
    const e = count(EMOTION, text), caps = (text.match(/\b[A-Z]{4,}\b/g) || []).length, ex = (text.match(/!/g) || []).length;
    if (e >= 1 || caps >= 2 || ex >= 2) out.push({ id: 'emo', label: ids.emo });
    if (count(TOO_GOOD, text) >= 1) out.push({ id: 'good', label: ids.good });
    return out;
  }

  const STOP = new Set('the a an and or of to in on for is are was were be been it that this with as at by from has have had not but they we you your i he she his her our their its will would can could do does did so if than then there here what which who about into over under more most very just also how why when new says said live news video'.split(' '));
  const toks = s => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2 && !STOP.has(w));

  // Whole-video review from metadata + transcript.
  // meta: {title, description, publishedAt, live}   text: transcript text (may be '')
  function video(meta, text) {
    const flags = [];
    const title = meta.title || '', desc = (meta.description || '').slice(0, 1500), body = text || '';
    const all = [title, desc, body].join(' ');
    const n = Math.max(words(all), 1);

    // Emotional triggers
    const eHits = count(EMOTION, all), exTitle = (title.match(/!/g) || []).length;
    const capsTitle = (title.match(/\b[A-Z]{4,}\b/g) || []).length;
    const eRate = eHits / n * 100;
    if (count(EMOTION, title) >= 1 || eRate >= 0.8 || exTitle >= 2 || capsTitle >= 2) {
      flags.push({ id: 'emo', sev: eRate >= 1.5 || count(EMOTION, title) >= 2 ? 'high' : 'med', label: 'Emotional triggers',
        why: 'Strong anger, fear or outrage language can push you to react before checking. Slow down and look for the original source.' });
    }

    // Too good to be true / absurd
    const gHits = count(TOO_GOOD, all);
    if (gHits >= 1) {
      flags.push({ id: 'good', sev: gHits >= 3 ? 'high' : 'med', label: 'Too good to be true',
        why: 'Miracle, secret or impossible-sounding claims need independent confirmation before you believe or share them.' });
    }

    // Out-of-context: "now" words on an older upload
    if (meta.publishedAt && !meta.live) {
      const ageDays = (Date.now() - new Date(meta.publishedAt).getTime()) / 864e5;
      const nowHits = count(NOW, title + ' ' + body.slice(0, 4000));
      if (ageDays > 3 && nowHits >= 1) {
        flags.push({ id: 'now', sev: ageDays > 30 ? 'high' : 'med', label: 'Says "now" but is not new',
          why: `This was uploaded about ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? '' : 's'} ago, yet it uses words like "today" or "breaking". Old footage is often reposted as if it just happened.` });
      }
    }

    // Out-of-context: title does not match what is said
    if (title && body.length > 400) {
      const tt = [...new Set(toks(title))];
      if (tt.length >= 3) {
        const bodySet = new Set(toks(body));
        const hit = tt.filter(w => bodySet.has(w)).length / tt.length;
        if (hit < 0.2) {
          flags.push({ id: 'ctx', sev: 'med', label: 'Title does not match what is said',
            why: 'Few of the title’s key words appear in the speech. Check that the caption describes the actual event.' });
        }
      }
    }
    return flags;
  }

  return { sentence, video, ids };
})();
