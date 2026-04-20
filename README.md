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

## Email notifications (optional)

The server can email a configurable list of recipients every time a **new**
Schoology update is detected. Each email contains:

- the **course name**
- the **person who posted** the update
- the **AI summary** (if `GITHUB_TOKEN` is configured — otherwise a placeholder)
- the **original update body**

### 1. Create a Gmail app password

Gmail no longer accepts plain account passwords for SMTP. You need an *app
password*:

1. Go to <https://myaccount.google.com/security> and enable **2-Step
   Verification** on the sending account (`zackt.atp@gmail.com`).
2. Open <https://myaccount.google.com/apppasswords>.
3. Create a new app password (name it e.g. `schoologyconnect`). Google will
   show you a 16-character password — copy it.

### 2. Add the SMTP settings to your `.env`

```env
SMTP_USER=zackt.atp@gmail.com
SMTP_PASS=the_16_char_app_password
NOTIFY_EMAILS=zackt.atp@gmail.com,klpgiraffe@gmail.com
NOTIFY_FROM=zackt.atp@gmail.com
```

Notifications are enabled automatically as soon as `SMTP_USER` and `SMTP_PASS`
are present. If either is missing, the feature is silently disabled and the
app behaves exactly as before.

### 3. How "new" is determined

The server uses a **time-window approach**: an update triggers an email when
its creation timestamp is within the last `NOTIFY_NEW_WINDOW_SECONDS` seconds
(default **300 s = 5 minutes**). Within a single process lifetime, an update
id is only emailed once (tracked in an in-memory set), so reloading the page
won't cause duplicate emails.

This strategy works correctly on **Vercel and other serverless platforms**:
each cold start inspects timestamps rather than relying on remembered state,
so a genuinely new update will still fire an email even if the function
instance was recycled since the last request.

> **Tuning the window**: If you only open the app once an hour, consider
> setting `NOTIFY_NEW_WINDOW_SECONDS=3600` in Vercel's Environment Variables
> so you don't miss updates posted between visits. Setting it too large may
> cause a brief flood of emails after a long gap, so choose a value that
> matches how often the `/api/updates` endpoint is called (e.g. browser
> auto-refresh interval).

### 4. Deploying on Vercel

Add `SMTP_USER`, `SMTP_PASS`, and (optionally) `NOTIFY_EMAILS` and
`NOTIFY_NEW_WINDOW_SECONDS` under **Settings → Environment Variables** in your
Vercel project. Redeploy after saving. Notifications will fire for any update
created within the last `NOTIFY_NEW_WINDOW_SECONDS` seconds at the time
`/api/updates` is fetched (e.g. when the app is opened in a browser).

If you open the app less frequently than the default 5-minute window, increase
`NOTIFY_NEW_WINDOW_SECONDS` to match your usage pattern (e.g. `3600` for
hourly).

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
