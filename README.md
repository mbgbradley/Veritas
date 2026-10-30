# Veritas

Live political fact-checking for broadcasts, recorded programs, YouTube Shorts, articles and links people send you.

The website lives in `docs/` (publish it with GitHub Pages: Settings > Pages > Deploy from a branch > `main` > `/docs`).
The optional transcript service lives in `worker/`.

## What it does
- **Check anything:** the box at the top accepts a YouTube link (video, Short or live), an article link, or pasted text.
- **Live outlets:** PBS, ABC, CBS, Fox, CNN, NBC, BBC, Al Jazeera, plus **+ Add outlet**. With an API key, clicking an outlet finds its current live stream and checks it.
- **TV schedule:** live now, coming up and recently aired programs from each outlet. Click a program to play it in the theater with the checker running.
- **Top political stories:** the three most recent politics-related videos per outlet.
- **Shorts:** the latest Shorts from each outlet in a vertical grid, or paste any Shorts link. Meant for a younger audience.
- **Theater:** player, lower-third flag banner, timeline of checked claims (click a tick to jump to that moment), synced transcript, fact-check feed.
- **Truth meter** and **Debate mode** (two named speakers, one meter each).
- **Red flags:** emotional triggers, too-good-to-be-true language, and out-of-context clues (says "today" on an old upload; title does not match what is said), at video level and tagged on individual claims.
- **Demo:** "Run demo" plays scripted sample claims. They are not real checks.

## How a claim is checked
1. **Find claims.** Sentences with numbers, comparisons, records, "never/always/doubled" and similar are picked. Opinions and questions are skipped. Long videos check the 60 most check-worthy sentences, nearest the playhead first.
2. **Tier 1, established fact-checkers.** The Google Fact Check Tools API searches published reviews, including PolitiFact, Snopes, FactCheck.org, AP, Reuters and Full Fact. A match must share most of the claim's key words. The shown rating is mapped to True, Misleading or False and always labelled "related fact-check", with the matched claim and links so you can confirm.
3. **Tier 2, related reporting.** If no fact-checker matched and you set a search engine ID, Veritas searches Reuters, BBC, WSJ news, FT, The Economist, PBS NewsHour, Christian Science Monitor, DW, NewsNation and AP, and shows links with third-party bias ratings (AllSides, Ad Fontes, MBFC). This is context, not confirmation.
4. **Otherwise** the claim shows "No match", which does not mean true or false.

## Setup (all optional, in this order)
**A. Google API key.** In Google Cloud Console create a project, enable **Fact Check Tools API**, **YouTube Data API v3** and **Custom Search API**, create an API key, and restrict it to your site (HTTP referrer `https://YOURNAME.github.io/*`) and to those three APIs. On the site, open **Settings** and paste it. Each visitor uses their own key and quota; it is stored only in their browser. Without a key you can still use the demo, red flags, microphone and text input.

**B. Related-reporting search engine (Tier 2).** At programmablesearchengine.google.com create a search engine that searches only: reuters.com, bbc.com, bbc.co.uk, wsj.com, ft.com, economist.com, pbs.org, csmonitor.com, dw.com, newsnation.com, apnews.com. Copy its **Search engine ID** into Settings.

**C. Transcript service (full captions and articles).** Browsers cannot read YouTube captions or most article pages directly. Follow `worker/README.md` to deploy the free Cloudflare Worker, then paste its address in Settings. Without it, a video is checked from its title and description, and you can use **Listen (mic)** for audio.

## Honest limits
- YouTube has no official API for other channels' captions. The worker uses an unofficial route that can break and may conflict with YouTube's terms. Check them before public use. It has not been tested against live YouTube from the build environment.
- Live streams: captions are re-fetched every 20 seconds when available. Otherwise use the microphone.
- Whether an outlet's live embed plays is up to the broadcaster. Channel IDs are in `docs/assets/config.js`; correct any that show the wrong stream.
- Matching is by wording, so a similar claim can have a different verdict. Always read the linked fact-check.
- Automated results can be wrong. Keep the on-page disclaimer.

## Files
- `docs/index.html`, `docs/assets/styles.css`: page and theme (primary `#245696`, silver, light blue)
- `docs/assets/config.js`: outlets, fact-checker and source lists, demo script
- `docs/assets/checker.js`: claim detection and tiered checking
- `docs/assets/redflags.js`: red-flag rules
- `docs/assets/youtube.js`: schedule, Shorts and transcript calls
- `docs/assets/app.js`: interface
- `worker/`: optional transcript and article service
