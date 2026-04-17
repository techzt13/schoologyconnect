'use strict';

require('dotenv').config();
const express = require('express');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const fetch = require('node-fetch');

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const { SCHOOLOGY_KEY, SCHOOLOGY_SECRET, PORT = 3000 } = process.env;

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

    res.json({
      me: { uid, name: me.name_display },
      courses,
      feed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[schoologyconnect] Server running at http://localhost:${PORT}`);
});
