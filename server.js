'use strict';

require('dotenv').config();
const express = require('express');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const { SCHOOLOGY_KEY, SCHOOLOGY_SECRET, PORT = 3000 } = process.env;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const COPILOT_MODEL = process.env.COPILOT_MODEL || 'gpt-4o-mini';

// Email notification config. All optional — if SMTP_USER/SMTP_PASS are unset,
// the notifier is disabled and the app behaves exactly as before.
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NOTIFY_FROM = process.env.NOTIFY_FROM || SMTP_USER;
// Default to the two addresses requested in the task; override via env if you
// want a different recipient list.
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS ||
  'zackt.atp@gmail.com,klpgiraffe@gmail.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!SCHOOLOGY_KEY || !SCHOOLOGY_SECRET) {
  console.error(
    '[schoologyconnect] ERROR: SCHOOLOGY_KEY and SCHOOLOGY_SECRET must be set in your .env file.\n' +
    'Copy .env.example to .env and fill in your credentials from https://cishk.schoology.com/api'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// OAuth 1.0a client (two-legged: consumer key/secret only, no access token)
// ---------------------------------------------------------------------------
const oauth = OAuth({
  consumer: { key: SCHOOLOGY_KEY, secret: SCHOOLOGY_SECRET },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});

const BASE_URL = 'https://api.schoology.com/v1';

// Maximum number of redirects to follow for a single API call. Schoology
// typically only redirects once (e.g. /users/me -> /users/<uid>), so a small
// cap is sufficient and prevents infinite redirect loops.
const MAX_REDIRECTS = 5;

/**
 * Perform an authenticated GET request to the Schoology REST API.
 *
 * Redirects are followed manually by issuing a brand-new signed request to
 * the Location URL. We cannot let node-fetch transparently follow redirects:
 * the OAuth 1.0a signature (including the nonce + timestamp) is bound to the
 * exact request URL, so replaying the same Authorization header against a
 * different URL is rejected by Schoology as a replay attack with
 *   "Duplicate timestamp/nonce combination, possible replay attack."
 * Re-signing each hop with a fresh nonce/timestamp avoids that.
 *
 * @param {string} path - API path, e.g. '/users/me'
 * @returns {Promise<object>} Parsed JSON response
 */
async function schoologyGet(path) {
  let url = `${BASE_URL}${path}`;

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    // Build a fresh Authorization header for this exact URL (new nonce +
    // timestamp each call, signed against the current target).
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'GET' }));

    const res = await fetch(url, {
      headers: {
        ...authHeader,
        Accept: 'application/json',
      },
      redirect: 'manual',
    });

    // On redirect, resolve the Location header against the current URL and
    // loop to re-sign for the new destination.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(
          `Schoology API redirected ${res.status} for ${path} with no Location header.`
        );
      }
      url = new URL(location, url).toString();
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Schoology API error ${res.status} for ${path}: ${body}`);
    }

    return res.json();
  }

  throw new Error(
    `Schoology API exceeded ${MAX_REDIRECTS} redirects for ${path}.`
  );
}

// ---------------------------------------------------------------------------
// GitHub Copilot chat integration
//
// The user supplies a GitHub token (GITHUB_TOKEN) that has Copilot access.
// We exchange it for a short-lived Copilot session token at
//   GET https://api.github.com/copilot_internal/v2/token
// and cache the result until shortly before `expires_at`. We then call the
// OpenAI-compatible chat completions endpoint at
//   POST https://api.githubcopilot.com/chat/completions
// with a cheap model (default gpt-4o-mini) to rewrite each Schoology update
// into clearer prose.
// ---------------------------------------------------------------------------

// Headers required by the Copilot API to recognize us as a client.
const COPILOT_CLIENT_HEADERS = {
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.22.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'GitHubCopilotChat/0.22.0',
};

// Cached Copilot session token: { token, expiresAt (ms since epoch) }
let copilotTokenCache = null;

/**
 * Fetch (or reuse a cached) short-lived Copilot session token derived from
 * the user's GitHub token. Refreshed ~1 minute before actual expiry.
 */
async function getCopilotToken() {
  if (!GITHUB_TOKEN) return null;

  const now = Date.now();
  if (copilotTokenCache && copilotTokenCache.expiresAt - 60_000 > now) {
    return copilotTokenCache.token;
  }

  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/json',
      ...COPILOT_CLIENT_HEADERS,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Copilot token exchange failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  // `expires_at` is a Unix timestamp (seconds). Fall back to 20 min if absent.
  const expiresAt = data.expires_at
    ? data.expires_at * 1000
    : now + 20 * 60 * 1000;
  copilotTokenCache = { token: data.token, expiresAt };
  return data.token;
}

// In-memory cache of AI-rewritten update bodies, keyed by Schoology update id.
// Schoology update bodies are immutable for a given id, so caching is safe and
// avoids re-summarizing the same update on every page load.
const summaryCache = new Map();

/**
 * Rewrite a Schoology update body into a cleaner, easier-to-read summary
 * using GitHub Copilot's chat completions API. Returns null if AI is
 * disabled or any error occurs (callers should fall back to the raw body).
 *
 * @param {string} body  Raw update body text from Schoology.
 * @param {string} id    Schoology update id, used as the cache key.
 */
async function summarizeUpdate(body, id) {
  if (!GITHUB_TOKEN) return null;
  if (!body || !body.trim()) return null;

  if (id != null && summaryCache.has(id)) {
    return summaryCache.get(id);
  }

  try {
    const copilotToken = await getCopilotToken();
    if (!copilotToken) return null;

    const res = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        ...COPILOT_CLIENT_HEADERS,
      },
      body: JSON.stringify({
        model: COPILOT_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You rewrite messages from a school learning-management system ' +
              'into short, plain, easy-to-read text for a student. Keep all ' +
              'factual details (dates, times, assignment names, links, ' +
              'instructions). Strip HTML tags and boilerplate. Use simple ' +
              'language and short sentences. If the message contains a ' +
              'clear action or deadline, put it first. Do not invent facts. ' +
              'Respond with only the rewritten message — no preamble, no ' +
              'quotes, no markdown headings.',
          },
          { role: 'user', content: body },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn(
        `[schoologyconnect] Copilot completion failed ${res.status}: ${errBody.slice(0, 200)}`
      );
      return null;
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content?.trim() || null;
    if (summary && id != null) summaryCache.set(id, summary);
    return summary;
  } catch (err) {
    console.warn(`[schoologyconnect] Summarization error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email notifications for new Schoology updates
//
// The first time /api/updates is handled by this server process, every
// currently-visible update id is recorded in `notifiedUpdateIds` *without*
// sending any emails — this avoids blasting the entire backlog out on
// startup. On subsequent calls, any update id that is not already in the set
// is considered "new": an email is sent to NOTIFY_EMAILS and the id is
// recorded.
//
// Caveat: the "seen" set lives in process memory. On a long-running server
// (`npm start`) this works out of the box. On serverless platforms like
// Vercel, function instances are short-lived, so each cold start will
// re-prime and no emails will fire; durable storage (Redis, a database, etc.)
// would be required there. This is documented in README.md.
// ---------------------------------------------------------------------------

const notifierEnabled = Boolean(SMTP_USER && SMTP_PASS && NOTIFY_EMAILS.length);
const notifiedUpdateIds = new Set();
let notifierPrimed = false;
let mailTransporter = null;

function getMailTransporter() {
  if (!notifierEnabled) return null;
  if (mailTransporter) return mailTransporter;
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return mailTransporter;
}

/**
 * Escape a string for safe interpolation into HTML.
 */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send a single notification email for a new Schoology update.
 * Errors are logged but never thrown — notification failures must not break
 * the /api/updates response.
 */
async function sendUpdateEmail(update) {
  const transporter = getMailTransporter();
  if (!transporter) return;

  const course = update.course_title || 'Unknown course';
  const poster = update.display_name || 'Unknown user';
  const summary = update.summary || '(AI summary not available)';
  const original = update.body || '(no body)';

  const subject = `[Schoology] ${course} — new update from ${poster}`;

  const text =
    `Course: ${course}\n` +
    `Posted by: ${poster}\n\n` +
    `AI summary:\n${summary}\n\n` +
    `Original update:\n${original}\n`;

  // Escape both the summary and the original body. Schoology update bodies
  // often contain HTML, but embedding untrusted HTML in outbound email is an
  // XSS risk in any mail client that renders it — so we render everything as
  // plain text with <br> for line breaks.
  const html =
    `<p><strong>Course:</strong> ${escapeHtml(course)}<br>` +
    `<strong>Posted by:</strong> ${escapeHtml(poster)}</p>` +
    `<h3>AI summary</h3>` +
    `<p>${escapeHtml(summary).replace(/\n/g, '<br>')}</p>` +
    `<h3>Original update</h3>` +
    `<div>${escapeHtml(original).replace(/\n/g, '<br>')}</div>`;

  try {
    await transporter.sendMail({
      from: NOTIFY_FROM,
      to: NOTIFY_EMAILS.join(', '),
      subject,
      text,
      html,
    });
  } catch (err) {
    console.warn(
      `[schoologyconnect] Failed to send notification for update ${update.id}: ${err.message}`
    );
  }
}

/**
 * Given the current feed, determine which updates are new (unseen by this
 * process) and send emails for them. The first call just primes the cache.
 */
async function notifyNewUpdates(feed) {
  if (!notifierEnabled) return;

  if (!notifierPrimed) {
    for (const u of feed) {
      if (u.id != null) notifiedUpdateIds.add(u.id);
    }
    notifierPrimed = true;
    console.log(
      `[schoologyconnect] Email notifier primed with ${notifiedUpdateIds.size} existing updates; recipients: ${NOTIFY_EMAILS.join(', ')}`
    );
    return;
  }

  const newUpdates = feed.filter(
    (u) => u.id != null && !notifiedUpdateIds.has(u.id)
  );
  if (!newUpdates.length) return;

  // Record ids up front so a slow-sending message doesn't cause duplicates
  // if /api/updates is hit again while we're still emailing.
  for (const u of newUpdates) notifiedUpdateIds.add(u.id);

  console.log(
    `[schoologyconnect] Sending email notifications for ${newUpdates.length} new update(s).`
  );

  // Send serially to avoid tripping Gmail's per-connection rate limit.
  for (const u of newUpdates) {
    await sendUpdateEmail(u);
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Serve static files from public/
app.use(express.static('public'));

/**
 * GET /api/health
 * Simple liveness check.
 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/**
 * GET /api/updates
 * Returns the authenticated user's profile, per-course update lists, and a
 * flattened feed sorted newest-first.
 */
app.get('/api/updates', async (_req, res) => {
  try {
    // 1. Identify the current user
    const me = await schoologyGet('/users/me');
    const uid = me.uid;

    // 2. List all enrolled sections (courses)
    const sectionsResp = await schoologyGet(`/users/${uid}/sections`);
    const sections = sectionsResp.section || [];

    // 3. Fetch updates for every section in parallel; one failed section won't
    //    crash the whole response.
    const courses = await Promise.all(
      sections.map(async (sec) => {
        try {
          const updResp = await schoologyGet(
            `/sections/${sec.id}/updates?with_attachments=1&limit=20`
          );
          const updates = (updResp.update || []).map((u) => ({
            id: u.id,
            body: u.body,
            created: u.created,            // Unix timestamp
            uid: u.uid,
            display_name: u.display_name,
            num_comments: u.num_comments,
            attachments: u.attachments || null,
          }));
          return {
            section_id: sec.id,
            course_title: sec.course_title,
            section_title: sec.section_title,
            updates,
          };
        } catch (err) {
          // Surface per-section errors without killing the whole request
          return {
            section_id: sec.id,
            course_title: sec.course_title,
            section_title: sec.section_title,
            updates: [],
            error: err.message,
          };
        }
      })
    );

    // 4. Flatten all updates into a single feed sorted by creation date desc
    const feed = courses
      .flatMap((course) =>
        course.updates.map((u) => ({
          ...u,
          course_title: course.course_title,
          section_id: course.section_id,
        }))
      )
      .sort((a, b) => b.created - a.created);

    // 5. Optionally rewrite each update body with GitHub Copilot so the feed
    //    is easier to read. Runs in parallel; individual failures fall back
    //    to the raw body without failing the whole request.
    if (GITHUB_TOKEN) {
      await Promise.all(
        feed.map(async (u) => {
          const summary = await summarizeUpdate(u.body, u.id);
          if (summary) u.summary = summary;
        })
      );
      // Mirror summaries back onto the per-course `updates` arrays so both
      // views stay consistent.
      const summaryById = new Map(
        feed.filter((u) => u.summary).map((u) => [u.id, u.summary])
      );
      for (const course of courses) {
        for (const u of course.updates) {
          if (summaryById.has(u.id)) u.summary = summaryById.get(u.id);
        }
      }
    }

    res.json({
      me: { uid, name: me.name_display },
      courses,
      feed,
      ai: { enabled: Boolean(GITHUB_TOKEN), model: GITHUB_TOKEN ? COPILOT_MODEL : null },
    });

    // Fire-and-forget: detect new updates and email the notify list. We do
    // this *after* sending the response so slow SMTP delivery never delays
    // the feed load. Any errors are already logged inside notifyNewUpdates.
    if (notifierEnabled) {
      notifyNewUpdates(feed).catch((err) => {
        console.warn(
          `[schoologyconnect] notifyNewUpdates failed: ${err.message}`
        );
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
// Only bind a port when this file is executed directly (e.g. `npm start`).
// On Vercel the file is imported as a serverless function handler, and
// calling app.listen there would break request handling.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[schoologyconnect] Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
