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
- **Free mode:** "Tab audio: free" transcribes any tab's audio on your own device with an open-source speech model (Whisper), from any website, with no accounts. A few seconds behind, less accurate than the cloud option.
- **Live capture:** "Capture tab audio" transcribes a tab's audio (for live streams) through Deepgram, with the key kept in the worker.
- **Demo:** "Run demo" plays scripted sample claims. They are not real checks.

## How a claim is checked
1. **Find claims.** Sentences with numbers, comparisons, records, "never/always/doubled" and similar are picked. Opinions and questions are skipped. Long videos check the 60 most check-worthy sentences, nearest the playhead first.
2. **Tier 1, established fact-checkers.** The Google Fact Check Tools API searches published reviews, including PolitiFact, Snopes, FactCheck.org, AP, Reuters and Full Fact. A match must share most of the claim's key words. The shown rating is mapped to True, Misleading or False and always labelled "related fact-check", with the matched claim and links so you can confirm.
3. **Tier 2, related reporting.** If no fact-checker matched and you set a search engine ID, Veritas searches Reuters, BBC, WSJ news, FT, The Economist, PBS NewsHour, Christian Science Monitor, DW, NewsNation and AP, and shows links with third-party bias ratings (AllSides, Ad Fontes, MBFC). This is context, not confirmation.
4. **Otherwise** the claim shows "No match", which does not mean true or false.

## Setup
Follow **GUIDE-CLOUDFLARE.md** (written for a Chromebook, all in the browser). In short:
1. Enable the Fact Check Tools and YouTube Data APIs, create a Google API key, lock it to your site.
2. Deploy `worker/transcript-worker.js` on Cloudflare (free). This reads captions for recorded videos and Shorts, and fetches articles. Because YouTube often blocks Cloudflare's servers, add a hosted caption provider key (`SUPADATA_API_KEY`, guide step 2b).
3. Open **Setup & settings** at the bottom of the page, paste the key and the worker address, and press **Test setup**. To enable it for every visitor, put the worker address in `docs/assets/config.js` (`defaults`).
4. Optional, for live streams: add a Deepgram key to the worker and use **Capture tab audio** (pick the Chrome Tab option and tick "Also share tab audio").

Without any setup you can still use the demo, red flags, **Check text**, and the microphone. Google is retiring the Custom Search API (related-reporting step) on January 1, 2027, so that step is optional and will be replaced.

## Honest limits
- YouTube has no official API for other channels' captions. The worker uses an unofficial route that can break and may conflict with YouTube's terms. Check them before public use. It has not been tested against live YouTube from the build environment.
- Live streams: captions are re-fetched every 20 seconds when available. Otherwise use Capture tab audio. The microphone only hears the room, not the video.
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
- `docs/assets/whisper-worker.js`: on-device speech model for free mode
- `worker/`: transcript, article and live-audio token service
- `GUIDE-CLOUDFLARE.md`: setup walkthrough
