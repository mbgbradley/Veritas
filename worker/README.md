# Veritas service (Cloudflare Worker)

Full step-by-step instructions are in `../GUIDE-CLOUDFLARE.md`.

Short version: create a Worker, paste `transcript-worker.js`, set `ALLOWED_ORIGIN` (your site) and optionally `DEEPGRAM_API_KEY` (a Secret, for live tab-audio capture), then paste the worker address into Veritas under **Setup & settings** (page footer) and press **Test setup**.

Routes: `/` health check, `/transcript?v=ID`, `/article?url=`, `/deepgram-token`.
