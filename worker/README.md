# Transcript service (optional, free)

Veritas on GitHub Pages is static, and browsers cannot read YouTube captions directly. This tiny Cloudflare Worker does it for the site.

1. Create a free account at cloudflare.com, then **Workers & Pages > Create > Create Worker**.
2. Name it (for example `veritas-transcripts`), click **Deploy**, then **Edit code**.
3. Replace the code with the contents of `transcript-worker.js`, then **Deploy**.
4. Copy the worker address (like `https://veritas-transcripts.yourname.workers.dev`).
5. On your Veritas site open **Settings** and paste it into **Transcript service URL**.
6. Optional: in the worker's **Settings > Variables** add `ALLOWED_ORIGIN` = `https://yourname.github.io` so only your site can use it.

Test: open `<worker address>/transcript?v=<any video id with captions>` in a browser. You should see JSON with `segments`.

Notes
- This is unofficial and may break if YouTube changes its player. Check YouTube's Terms of Service before using it publicly.
- Live streams: captions for a stream in progress are fetched again every 20 seconds, but availability varies. The microphone option always works as a fallback.
- `/article?url=` returns plain text from news articles so they can be checked too.
