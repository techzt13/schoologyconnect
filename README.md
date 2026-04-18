# schoologyconnect

A Node.js + Express web app that aggregates updates from all of your Schoology courses into a single unified feed.

---

## ⚠️ Security Warning

**Your consumer secret must never be exposed in frontend code.**  
Anyone who can read your client-side JavaScript can steal the secret and impersonate you against the Schoology API. This backend exists specifically to keep signing logic and credentials server-side only.

---

## Setup

1. **Clone the repo and enter it**
   ```bash
   git clone https://github.com/techzt13/schoologyconnect.git
   cd schoologyconnect
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure credentials**  
   Copy the example env file and fill in your key and secret from https://cishk.schoology.com/api:
   ```bash
   cp .env.example .env
   # Edit .env and set SCHOOLOGY_KEY and SCHOOLOGY_SECRET
   # Optionally set GITHUB_TOKEN to enable AI-cleaned updates (see below)
   ```

4. **Start the server**
   ```bash
   npm start
   ```

5. **Open the app**  
   Visit http://localhost:3000 in your browser.

---

## How it works

The app uses **two-legged OAuth 1.0a** to authenticate every request to the Schoology REST API. Unlike three-legged OAuth (which requires a user to explicitly grant access), two-legged OAuth uses only the consumer key and secret you generated at `/api` on your school's Schoology instance. Each outgoing request is signed with an HMAC-SHA1 signature that includes a nonce and timestamp, so the secret is never transmitted directly.

Three Schoology API endpoints are used:

| Endpoint | Purpose |
|---|---|
| `GET /users/me` | Retrieve the current user's `uid` and display name |
| `GET /users/{uid}/sections` | List all course sections the user is enrolled in |
| `GET /sections/{id}/updates?with_attachments=1&limit=20` | Fetch the latest updates for each section |

Section updates are fetched in parallel (`Promise.all`), so a single failing section won't break the entire response — it will surface its error inline.

---

## Notes

- **Rate limits**: Schoology allows roughly 50 requests per 5 seconds per consumer key. Fetching updates for 10–20 courses in parallel is well within this limit; cache responses if you have many more.
- **Filtering active sections**: `/users/{uid}/sections` may include archived or past-year courses. Append `?active=1` to the request to limit results to currently active sections.
- **Google SSO is irrelevant to the API**: You log in to the Schoology web UI via Google SSO, but the REST API is authenticated entirely by the consumer key/secret. No Google auth flow is required.

---

## AI-cleaned updates (optional)

If you have a GitHub Copilot Pro account, set `GITHUB_TOKEN` in your `.env` to
your Copilot-enabled GitHub token. The server will exchange it for a
short-lived Copilot session token and run each Schoology update body through
GitHub Copilot's chat API to produce a short, plain-language summary. The
rewritten text is shown in the feed, with a "Show original" toggle on each
card. The raw body is never discarded.

- **Default model**: `gpt-4o-mini` (cheap and fast). Override with `COPILOT_MODEL`.
- **Caching**: summaries are cached in-memory by update id, so each update is
  only rewritten once per server process.
- **Graceful degradation**: if `GITHUB_TOKEN` is not set, or if the Copilot
  API call fails, the feed falls back to the raw Schoology text.

Endpoints used:

| Endpoint | Purpose |
|---|---|
| `GET https://api.github.com/copilot_internal/v2/token` | Exchange GitHub token for a Copilot session token |
| `POST https://api.githubcopilot.com/chat/completions`   | Rewrite each update body |

---

## Deploying to Vercel

This repo includes a `vercel.json` that wires `server.js` up as a serverless function and serves `public/` as static assets.

1. Push the repo to GitHub, then import it at https://vercel.com/new.
2. Leave the framework preset as **Other**; no build or output settings are needed.
3. Under **Environment Variables**, add `SCHOOLOGY_KEY` and `SCHOOLOGY_SECRET` (do **not** set `PORT` — Vercel manages that).
4. Click **Deploy**.

If you see `Failed to load updates: Unexpected token 'T', "The page c"... is not valid JSON`, it means `/api/updates` returned Vercel's HTML 404 page. Make sure `vercel.json` is committed and the latest deployment includes it, then redeploy.

---

## Ideas for extending

- **Assignments**: `GET /sections/{id}/assignments` — list upcoming assignments per course.
- **Grades**: `GET /users/{uid}/grades` — retrieve the authenticated user's grades.
- **Multi-user support**: Implement three-legged OAuth so other users at your school can log in and see their own feeds (request token → user authorizes at `cishk.schoology.com/oauth/authorize` → access token).
