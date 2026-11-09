# Step-by-step: turn on captions and live capture (Chromebook friendly)

Everything below is done in a web browser. You will do four things:

1. Enable two Google APIs and lock your key to your site (5 minutes)
2. Deploy the transcript service on Cloudflare (10 minutes)
3. Connect the service to your website (3 minutes)
4. Optional: add live tab-audio capture with Deepgram (5 minutes)

Cloudflare's and Google's screens change from time to time. If a button is named slightly differently, look for the closest match.

---

## 1. Google key (Fact Check + YouTube)

1. Go to **console.cloud.google.com** and select your project.
2. **APIs & Services > Library**. Search **Fact Check Tools API** > **Enable**. Search **YouTube Data API v3** > **Enable**.
3. **APIs & Services > Credentials**. Because your earlier key was shared in a chat, delete it and click **Create credentials > API key** for a fresh one.
4. Click the new key:
   - **Application restrictions:** Websites. Add these two entries (your GitHub username in place of YOURNAME), exactly like this, **with no repository name**:
     - `https://YOURNAME.github.io/*`
     - `https://YOURNAME.github.io`
     Why: when your page calls Google, the browser only sends the site address (not the folder after it), so a pattern like `https://YOURNAME.github.io/veritas/*` is refused with "Requests from referer ... are blocked". Changes can take up to about 5 minutes to apply.
   - **API restrictions:** Restrict key. Tick **Fact Check Tools API** and **YouTube Data API v3**.
   - **Save.**
5. Keep the key private for now (do not paste it in chats or into GitHub). You will type it into the site in step 3.

## 2. Transcript service on Cloudflare

1. Go to **dash.cloudflare.com** and sign up (free, no card needed for Workers).
2. In the left menu open **Workers & Pages** (sometimes under **Compute**). Click **Create** > **Create Worker** (or "Start with Hello World").
3. Name it `veritas-service` and click **Deploy**.
4. Click **Edit code**. Select everything in the editor and delete it. Open `worker/transcript-worker.js` from your Veritas folder (the Files app opens it in a text viewer; or open it on GitHub and click **Raw**), copy everything, and paste it in. Click **Deploy**.
5. Copy your worker address. It looks like `https://veritas-service.YOURNAME.workers.dev`. You can find it at the top of the worker page.
6. Lock it to your site. Open the worker, then **Settings > Variables and Secrets > Add**:
   - Type **Text**, name `ALLOWED_ORIGIN`, value `https://YOURNAME.github.io` (no slash at the end, no repository name).
   - Click **Deploy** so the change takes effect.
7. Quick test in a new browser tab: open `https://veritas-service.YOURNAME.workers.dev/`. You should see `{"ok":true, ...}`. (With ALLOWED_ORIGIN set, the page-to-service calls from your site are allowed and other websites are refused.)

### 2b. Captions provider (recommended; this is what makes captions work)

YouTube commonly blocks requests that come from Cloudflare's servers, so reading captions directly often fails. A hosted transcript provider does that part for you.

1. Go to **supadata.ai** and sign up. Their free plan lists 100 credits a month and no credit card; check the current terms on their pricing page.
2. Copy your API key from the dashboard.
3. In Cloudflare open your worker > **Settings > Variables and Secrets > Add**: Type **Secret**, name `SUPADATA_API_KEY`, paste the key, then **Deploy**.
4. Re-deploy the updated worker code from this zip (`worker/transcript-worker.js`: Edit code, paste, Deploy), since the earlier code does not know about this key.

The worker uses it first and falls back to direct access if it is not set. Each video's captions use provider credits, and results are cached for a minute. Live tab-audio capture (section 4) does not depend on YouTube captions at all, so it is the backup for any video where captions are missing.

## 3. Connect it to the site

Two options. You can do both.

**A. Just for you (fastest).** Open your live site, scroll to the bottom, click **Setup & settings**. Paste the Google key and the worker address, then click **Test setup**. You should see green checks for Fact Check, YouTube and the Transcript service, and "Captions work". Click **Save**.

If a check fails the message says why. Common ones:
- "Requests from referer https://YOURNAME.github.io/ are blocked": the website entries in step 1.4 are wrong. Use exactly the two entries listed there, no repository name, wait five minutes, and try again. If it still fails, temporarily set Application restrictions to **None**, press Test setup to prove the key works, then put the restriction back.
- "has not been used in project / is disabled": enable that API in step 1.2.
- "Origin not allowed": ALLOWED_ORIGIN does not exactly match your site (check for a trailing slash or a typo).
- "No captions could be read ... YouTube is blocking this server": do step 2b (SUPADATA_API_KEY) and re-deploy the worker code.
- "supadata: HTTP 401/402/429": the provider key is wrong, not allowed on your plan, or your monthly credits are used up.

**B. For every visitor.** On GitHub open `docs/assets/config.js`, click the pencil, and fill in:
```
defaults: { worker: "https://veritas-service.YOURNAME.workers.dev", key: "" },
```
The worker address is safe to publish. Only put the Google key there if you accept that anyone can see it; the restrictions in step 1.4 are what protect it. Click **Commit changes**. The site updates in about a minute.

## 4. Optional: live tab-audio capture (Deepgram)

This lets Veritas listen to the audio of a live stream playing in a browser tab, with no microphone.

1. Go to **console.deepgram.com** and sign up (new accounts come with free credit).
2. **API Keys > Create a New API Key.** Give it Member permissions or higher. Copy the key now (it is shown once).
3. In Cloudflare open your worker > **Settings > Variables and Secrets > Add**: Type **Secret**, name `DEEPGRAM_API_KEY`, paste the key. **Deploy.**
4. On your site, **Setup & settings > Test setup** should now show "Live tab-audio key is set".

Using it:
1. Play a live stream on the page.
2. Press **Capture tab audio**.
3. In the Chrome window pick the **Chrome Tab** option, choose the Veritas tab, and **tick "Also share tab audio"** (without this no sound is shared).
4. Words appear in the transcript within a couple of seconds and claims are checked as they come in. Press **Stop capture** (or Chrome's "Stop sharing") to end.

The key is never in your website. The service hands the browser a code that expires in two minutes.

---

## 5. Free mode: transcribe any tab on your own device (no accounts, no cost)

This is the closest thing to your Chromebook's Live Caption. It works for a video playing on any website, not just inside Veritas, and needs no Cloudflare or Deepgram.

1. Open the video you want to check in **its own Chrome tab** (any site).
2. Switch to Veritas and press **Tab audio: free**.
3. First time only: wait while it downloads a speech model (tens of MB; it is saved in the browser after that). The status next to "Transcript" shows the progress. It needs access to cdn.jsdelivr.net and huggingface.co.
4. In Chrome's share window pick **Chrome Tab**, choose the tab with the video, and **tick "Also share tab audio"**.
5. Go back to the video tab and play it. Text appears in Veritas a few seconds after it is spoken, and claims are checked as they arrive. Keep the Veritas tab open (it can be in another window).
6. Press **Stop free capture** when finished.

What to expect
- It runs on your Chromebook, so it lags. If it falls behind, the status says "skipped" and it drops the oldest audio instead of freezing. Use **Tab audio: cloud** if you need every word.
- The **tiny** model is fastest but makes more mistakes; **base** is more accurate and slower. Change it in Setup & settings > Free-mode speech model.
- It does not separate speakers, and it can mishear names and numbers, so claim checks are only as good as the transcript. Always read the quoted claim.

## Notes
- Captions come from an unofficial route and may break if YouTube changes things. Review YouTube's Terms of Service before using this publicly.
- Deepgram bills by audio minute after the free credit is used. Watch usage in the Deepgram console.
- Cloudflare's free plan allows 100,000 requests a day, far more than this needs.

---

## 5. Turn on AI claim research (what makes claims get verdicts)

Published fact-checks only exist for a small share of what people say. This step lets Veritas research the rest with web search and return True / Misleading / False, with sources, clearly labelled "AI research".

1. Go to **console.anthropic.com**, sign up, add a few dollars of credit, and under **Settings > Limits** set a low monthly spend limit.
2. In the console, make sure **web search** is enabled for your organization (Settings > Privacy or Features, depending on the screen).
3. **API Keys > Create Key.** Copy it.
4. Cloudflare > your worker > **Settings > Variables and Secrets > Add**: Type **Secret**, name `ANTHROPIC_API_KEY`, paste the key. Deploy. (Re-paste the updated worker code from `worker/transcript-worker.js` first; it now has a `/judge` route.)
5. Optional: Type **Text**, name `JUDGE_MODEL`, to pick another model.
6. Setup & settings > **Test setup** should show "Claim research key is set".

Cost: each researched claim is one request with up to three web searches, roughly a few cents. Veritas caps this at 30 per session (`V.config.judge.maxPerSession` in config.js). Keep your spend limit low.

## 6. How transcription starts now

Click any video and Veritas starts listening automatically. Chrome still shows its share prompt once per video (it cannot be skipped): pick **This tab** and make sure audio sharing is on. If you decline, a "Start transcription" bar appears under the player.

- With `GROQ_API_KEY` set (section 7): free hosted Whisper, text about 3 to 6 seconds behind. This is used first.
- With `DEEPGRAM_API_KEY` set and no Groq/Workers AI: Deepgram, words in about 1 to 2 seconds (uses paid credit).
- With neither: free on-device model. The first use downloads about 40 MB. Expect several seconds of delay; weak Chromebooks may lag more. Cloud mode is the way to get true real time.
- Newest words are on the first line. Times are the video's own clock when the video is playing in this page.

## 7. Free hosted Whisper (recommended: better accuracy, no lag on your Chromebook)

Your Chromebook only captures the tab's audio. Short chunks (about 4 to 8 seconds, cut at pauses) go through your worker to Groq's free Whisper large-v3-turbo model, and the text comes back.

1. Go to **console.groq.com**, sign up (no card needed at the time of writing), open **API Keys > Create API Key**, and copy it.
2. Cloudflare > your worker > **Settings > Variables and Secrets > Add**: Type **Secret**, name `GROQ_API_KEY`, paste the key. Paste the updated `worker/transcript-worker.js` (Edit code) and **Deploy**.
3. Optional backup, also free: worker **Settings > Bindings > Add > Workers AI**, variable name `AI`. If Groq is rate-limited or down, the worker uses this instead (about 3.5 hours of audio a day on Cloudflare's free allowance).
4. Upload the new `docs/` files to GitHub. On the site, **Setup & settings > Test setup** should show "Free speech service is set up" and "Speech test passed (answered by groq)".
5. Click a video, or press **Tab audio: free**, share the tab with audio on, and watch the status line: it should say "free cloud Whisper".

Limits to know about (check Groq's current limits page, free tiers change):
- Groq's free tier was listed at about 20 requests a minute and 28,800 audio-seconds a day, shared by everyone using your site. Veritas keeps one request in flight and at least 4 seconds of audio per request, so one viewer uses about 12 requests a minute and real-time audio.
- If you hit a limit, the status line says so and Veritas retries and keeps the audio instead of dropping it.
- Audio is sent to Groq (or Cloudflare) for transcription. Read their data terms before making the site public. Set `ALLOWED_ORIGIN` (section 2) so only your site can use your worker.

### If Test setup says "answered by workers-ai" (Groq is not active)
- Open `https://YOUR-WORKER.workers.dev/` in a browser tab. It must show `"groq":true`. If it shows `"groq":false`, the worker does not see the key.
- The secret name must be exactly `GROQ_API_KEY` (capital letters, underscores, no spaces), added to the same worker whose address is in Veritas settings.
- After adding a secret or variable, click **Deploy** again. Then reload the address above.
- Create the key at console.groq.com > API Keys. It starts with `gsk_`.
- Once `"groq":true` shows, Test setup should say "answered by groq", and the transcript status line shows "(groq)".

## 8. Free claim research with Groq (no new key needed)

Groq retired its web-search models (Compound) on 21 Sept 2026, so Groq cannot browse the web. v8 instead fetches Wikipedia introductions for each claim and asks a Groq model to judge ONLY from those excerpts. It is limited: Wikipedia lags current events, so many claims will come back "Could not verify". That is intended; it never guesses from memory. Results are labelled "Limited AI check".

1. Paste the new `worker/transcript-worker.js` into your Worker (Edit code) and **Deploy**. Your existing `GROQ_API_KEY` is reused.
2. Open `https://YOUR-WORKER.workers.dev/`. You should see `"judge":"groq"`. (If `ANTHROPIC_API_KEY` is also set, it shows `"anthropic"` and the web-search research is used instead.)
3. Upload the new `docs/` files to GitHub and reload with Ctrl + Shift + R. **Test setup** should say "Claim research runs on your Groq key".
4. Try it: **Check text**, paste "The unemployment rate in the United States fell to 3.7 percent." and press Check. Expect a card labelled "Limited AI check" or "Could not verify".
5. Optional: Worker variable (Text) `GROQ_JUDGE_MODEL` to choose another Groq model. Default tries `openai/gpt-oss-120b`, then `openai/gpt-oss-20b`.

It shares your Groq free quota with transcription. Veritas caps research at 30 claims per session (`V.config.judge.maxPerSession`).

## 9. TikTok, Instagram and Facebook links

Paste a link in the "Check anything" box. Veritas shows the platform's own embed player and listens to the tab's audio (Chrome's share prompt appears once: choose **This tab** with audio on).

- TikTok: short links (vm.tiktok.com) are resolved by the Worker, and the caption is read from TikTok's public oEmbed.
- Instagram and Facebook: shown through their embed players. No login, token or download is used.
- If a post will not play in the embed (private, age-restricted, embeds disabled, region-locked, or Facebook asking you to log in), open it in its own tab, play it, then press **Tab audio: free** and choose that tab.
- These players cannot report the playback time, so the timestamps count from when transcription started.
- Not supported on the free setup: downloading the video, Instagram Stories, private accounts.

## 10. Trending strip

The top of the page lists the 10 most-viewed videos in YouTube's News & Politics category from the last 3 days (political titles first). It uses your Google key (about 101 quota units per refresh, cached 30 minutes). The old outlet bar was removed; **+ Add outlet** is now next to Refresh above the schedule.

## 11. v9: Gemini as the claim checker (free key), and how the truth % works

**Which checker runs.** The Worker uses the first of these that has a key: `ANTHROPIC_API_KEY` (web search, paid), `GEMINI_API_KEY` (free key), `GROQ_API_KEY` (Wikipedia only). The worker address shows which one in `"judge"`.

**Add Gemini (free):**
1. Go to **aistudio.google.com**, sign in, click **Get API key > Create API key**, and copy it.
2. Cloudflare > your worker > **Settings > Variables and Secrets > Add**: Type **Secret**, name `GEMINI_API_KEY`, paste it, **Deploy**. Paste the new `worker/transcript-worker.js` first.
3. Open your worker address. You should see `"judge":"gemini"`. **Test setup** in Veritas should say "Claim research runs on your Gemini key".

What to expect (free tiers change; check Google's current limits): the Worker first asks for a Google-Search-grounded answer (`gemini-2.5-flash`). Newer free keys are often not allowed to do that, so it falls back to a knowledge-only answer from `gemini-3.5-flash-lite`, labelled "Limited AI check ... no live web search". Free limits were measured at roughly 20 requests a day on the larger models and 500 a day on flash-lite. Optional Text variables: `GEMINI_MODEL`, `GEMINI_GROUNDED_MODEL` (set to `off` to skip grounding). Free-tier data may be used by Google to improve its products; do not send anything private.

**Ask Gemini button.** Cards that say "No match" now have **Ask Gemini**. It copies a ready-made prompt and opens Gemini, which has web search built in. This is the free, manual way to get a properly sourced answer for the claims that matter most in a demo.

**How the truth % is calculated**
- Published fact-check (Google Fact Check Tools): the rating is converted to a score: Pants on fire 2, False 5, Mostly false 20, Misleading 45, Half true 50, Mostly true 85, True 95. If checkers disagree, the scores are averaged.
- AI check: the model proposes a score, which is forced into the band of its verdict (True 75 to 98, Misleading 35 to 74, False 2 to 34) and rounded to 5, so colour, label and % always agree. AI scores show with "≈". Low-confidence answers get no verdict and no score.
- Card colours: green True, orange Misleading, red False. Grey (no %) means not verified.
- **Meter** = weighted average of the claim scores. Weight = evidence strength (published fact-check 1.0, AI high confidence 0.8, medium 0.5) x check-worthiness (claims with numbers and specifics count up to 2x). Unverified claims are left out and not counted as true or false. With fewer than 3 rated claims it says "early reading". Debate mode gives each speaker their own meter.
- Why not use the AI's own percentage directly? Models are not calibrated: "95 to 98%" sounds precise, but it is a guess. Clamping to verdict bands and weighting by evidence keeps the number honest.

## 12. v9: Instagram and TikTok

Veritas now uses each platform's official embed script (the same markup their "Embed" button gives you) instead of a guessed player link. Facebook is unchanged.

If a post still will not play in the page, a bar under the player stays visible: **Open post** (new tab), press play there, come back, click **Start transcription**, choose that tab, and tick "Also share tab audio". This works for any site, including posts that block embedding.

## 13. v9: trending list is English only

The trending strip keeps only videos whose YouTube language is English. If the uploader left the language blank, Veritas checks that the title and description look like English. A few English videos with no language tag and unusual titles may be skipped.

## 14. v10: FactCheck.org first, complete sentences, default tab

**FactCheck.org first.** For every claim Veritas asks Google's Fact Check Tools API two questions at the same time: one limited to FactCheck.org (the API's `reviewPublisherSiteFilter`) and one across all publishers. FactCheck.org reviews are ranked first, so they are not crowded out. It uses the same Google key you already have; nothing new to set up. The AI checkers are also told to look at FactCheck.org first. FactCheck.org's own website search is a Google search box with no API, so Veritas does not scrape it. Instead, cards that say "No match" now have a **Search FactCheck.org** link that opens their search page with the claim filled in.

**Complete sentences.** Speech arrives in 4 to 8 second pieces. Words after the last sentence end are now held back (shown greyed) and joined to the next piece, fragments under 5 words are joined to the next sentence, and a held-back tail is released after 7 seconds of silence, at 45 words, or when you stop. Each transcript line, and each claim sent for checking, is now a full statement. The cost is that a claim is checked a few seconds after its sentence finishes.

**Default tab.** Top political stories is now first and shown by default. Shorts is next, and TV schedule is last.

## 15. What's new in v11 (better transcripts, context-aware checks, search buttons)

**Redeploy the Worker.** Cloudflare dashboard → Workers & Pages → veritas-service → Edit code → paste the new `worker/transcript-worker.js` → Deploy. Then upload the new `docs/` folder to GitHub (replace the old files).

**Best-quality transcription (free): Deepgram Nova-3**
1. Sign up at deepgram.com (no card). You get a free credit (about $200, roughly 400+ hours). Check the expiry on your Deepgram dashboard.
2. Create an API key (Settings → API Keys, "Member" role is enough).
3. In Cloudflare: your Worker → Settings → Variables and Secrets → Add → type *Secret*, name `DEEPGRAM_API_KEY`, paste the key → Deploy.
4. Open `/` on your Worker URL: it should now show `"deepgram":true`.
5. In Veritas → Setup & settings → **Transcription engine**: *Automatic* uses Deepgram when the key exists, otherwise Groq Whisper. You can force either one.

Whisper (Groq) is now tuned too: longer chunks (6–14 s), cuts at the quietest moment, and it is told the video title and the last lines so names and sentences continue cleanly. Optional: add variable `GROQ_WHISPER_MODEL` = `whisper-large-v3` (slower, a bit more accurate).

**Context-aware fact-checking.** Each claim is judged with the video title, the 3 statements before it and 2 after it. Claims such as "They did that last year" are rewritten as a standalone statement ("Checked in context as: …"), and the earlier sentence is used to find published fact-checks.

**Search this statement.** Every card has a "Search this statement" drop-down: FactCheck.org, Perplexity and Gemini. Perplexity opens with the question pre-filled. Gemini cannot be pre-filled, so the prompt is copied and Gemini opens; paste it.

**Tab audio prompt.** Chrome always asks the viewer to pick the tab, and a website cannot answer it. v11 pre-selects "This tab", turns off the extra options and ticks "Also share tab audio" where Chrome allows. Removing the prompt completely needs a small Chrome extension.
