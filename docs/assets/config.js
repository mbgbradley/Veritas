// Veritas configuration. Edit this file to change outlets, checkers, sources or the demo script.
window.V = window.V || {};
V.config = {
  // type: "yt-channel" (ref = YouTube channel ID starting with UC), "yt-video", "twitch"
  outlets: [
    { id: "pbs", name: "PBS NewsHour", type: "yt-channel", ref: "UC6ZFN9Tx6xh-skjvjyKVeEg" },
    { id: "abc", name: "ABC News",     type: "yt-channel", ref: "UCBi2mrWuNuyYy4gbM6fU18Q" },
    { id: "cbs", name: "CBS News",     type: "yt-channel", ref: "UC8p1vwvWtl6T73JiExfWs1g" },
    { id: "fox", name: "Fox News",     type: "yt-channel", ref: "UCXIJgqnII2ZOINSWNOGFThA" },
    { id: "cnn", name: "CNN",          type: "yt-channel", ref: "UCupvZG-5ko_eiXAupbDfxWw" },
    { id: "nbc", name: "NBC News",     type: "yt-channel", ref: "UCeY0bbntWzzVIaj2z3QigXg" },
    { id: "bbc", name: "BBC News",     type: "yt-channel", ref: "UC16niRr50-MSBwiO3YDb3RA" },
    { id: "aje", name: "Al Jazeera",   type: "yt-channel", ref: "UCNye-wNBqNL5ZzHSJj3l8Bg" }
  ],

  // Tier 1: established fact-checkers. Order = priority when results disagree.
  checkers: [
    { host: "politifact.com", name: "PolitiFact" },
    { host: "snopes.com", name: "Snopes" },
    { host: "factcheck.org", name: "FactCheck.org" },
    { host: "apnews.com", name: "AP Fact Check" },
    { host: "reuters.com", name: "Reuters Fact Check" },
    { host: "fullfact.org", name: "Full Fact" }
  ],

  // Tier 2: outlets used to cross-reference claims no fact-checker has covered.
  // Bias labels are third-party ratings (AllSides, Ad Fontes, MBFC) and vary by rater.
  sources: [
    { host: "reuters.com", name: "Reuters", bias: "Center", by: "AllSides, Ad Fontes, MBFC" },
    { host: "bbc.com", name: "BBC News", bias: "Center", by: "AllSides, Ad Fontes" },
    { host: "bbc.co.uk", name: "BBC News", bias: "Center", by: "AllSides, Ad Fontes" },
    { host: "wsj.com", name: "Wall Street Journal (news)", bias: "Center", by: "AllSides" },
    { host: "ft.com", name: "Financial Times", bias: "Center", by: "Ad Fontes, MBFC" },
    { host: "economist.com", name: "The Economist", bias: "Center / Lean Left", by: "Ad Fontes, MBFC; AllSides" },
    { host: "pbs.org", name: "PBS NewsHour", bias: "Center", by: "AllSides, Ad Fontes" },
    { host: "csmonitor.com", name: "Christian Science Monitor", bias: "Least biased / Center", by: "MBFC, Ad Fontes" },
    { host: "dw.com", name: "Deutsche Welle", bias: "Least biased / Center", by: "MBFC" },
    { host: "newsnation.com", name: "NewsNation", bias: "Center", by: "AllSides" },
    { host: "apnews.com", name: "Associated Press", bias: "Center / Lean Left", by: "AllSides, Ad Fontes" }
  ],

  // Used to pick "top political stories" from an outlet's recent videos.
  politics: /\b(congress|senate|senator|house|white house|president|presidential|election|vote[sd]?|voters?|ballot|campaign|democrat\w*|republican\w*|gop|governor|mayor|lawmakers?|legislat\w+|bill|policy|supreme court|justice|court|tariffs?|budget|shutdown|debate|administration|trump|biden|harris|vance|pelosi|schumer|johnson|politic\w+|impeach\w*|immigration|border|sanctions?|minister|parliament|nato|ukraine|gaza|israel|china|russia)\b/i,

  // Scripted SAMPLE session for the demo button. Not real claims and not real checks.
  demo: [
    { s: "A", text: "Thanks for having me. The bill passed the Senate on Tuesday night.", v: "TRUE", note: "Sample verdict: matches the roll-call record (demo data)." },
    { s: "B", text: "I think that vote tells us a lot about where the country is headed.", v: null },
    { s: "A", text: "We cut the deficit in half in just two years.", v: "MISLEADING", note: "Sample verdict: true for one measure and one year; depends on the baseline (demo data)." },
    { s: "B", text: "Gas prices in this state have doubled since last year.", v: "FALSE", note: "Sample verdict: official price series show a smaller change (demo data)." },
    { s: "A", text: "Unemployment has been below five percent for eighteen straight months.", v: "TRUE", note: "Sample verdict: consistent with the published monthly series (demo data)." },
    { s: "B", text: "Nobody in this administration has ever released a budget on time.", v: "FALSE", note: "Sample verdict: records show on-time releases (demo data)." },
    { s: "A", text: "More than a million people signed up in the first week.", v: "MISLEADING", note: "Sample verdict: sign-ups counted differently from enrollments (demo data)." }
  ]
};

// Settings live in this browser only.
V.store = {
  get(k, d) { try { const v = localStorage.getItem('veritas.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('veritas.' + k, JSON.stringify(v)); } catch {} }
};
V.settings = {
  key: V.store.get('key', ''),        // Google API key (Fact Check Tools, YouTube Data, Custom Search)
  cx: V.store.get('cx', ''),          // Programmable Search Engine ID for the Tier 2 sources
  worker: V.store.get('worker', '')   // Transcript service URL (see worker/README)
};
V.saveSettings = () => { V.store.set('key', V.settings.key); V.store.set('cx', V.settings.cx); V.store.set('worker', V.settings.worker); };
