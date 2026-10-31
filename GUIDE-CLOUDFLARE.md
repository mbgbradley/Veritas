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
