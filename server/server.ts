// Local server for the release form, built with Express.
//
// It does three things:
//   1. Serves the form page (the files in public/).
//   2. Answers the form's questions: which apps exist, which tags they have, is there a working token.
//   3. Creates the release page in Confluence:
//        - reads the "Merged PR" commits of the app between the two tags,
//        - builds a table of them (author + PR title, plus empty isVerified and Note columns for some apps),
//        - creates the page under the app's parent page,
//        - opens the new page in the browser.
//
// The API:
//   GET  /api/token            is there a working token in server/.env?
//   GET  /api/apps             the app names
//   GET  /api/tags?app=web-app the app's OLD / NEW tags
//   POST /api/release          create the release page
//
// This file shows what each of those does. The details live in lib/:
//   settings.ts              config.json, the port, the paths and Confluence's address
//   helpers.ts               fail() and other small helpers
//   git.ts                   apps, tags and merged PRs
//   token.ts                 the Confluence token from server/.env
//   confluence.ts            Confluence's REST API: checking the token, creating a page
//   release-page-content.ts  the page's table and info box
//   browser.ts               opening the new page in the browser
//   web.ts                   who may call the server
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.
// A route stops with fail(status, message); the error handler at the bottom turns that into the answer.

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, PORT, PUBLIC_DIR, CONFLUENCE_URL } from './lib/settings.ts';
import { fail, textValue, HttpError } from './lib/helpers.ts';
import * as git from './lib/git.ts';
import { requireToken } from './lib/token.ts';
import * as confluence from './lib/confluence.ts';
import { releasePageContent } from './lib/release-page-content.ts';
import { openInBrowser } from './lib/browser.ts';
import { isFromOwnPage } from './lib/web.ts';

const server = express();
server.disable('x-powered-by');

// Only this computer's own page may use the server.
server.use((request, _response, next) => {
  if (!isFromOwnPage(request)) {
    fail(403, `This server only answers its own page. Open it as http://localhost:${PORT}/ or http://127.0.0.1:${PORT}/.`);
  }
  next();
});

// The form page: "/" is index.html, "/style.css" is public/style.css, and so on.
server.use(express.static(PUBLIC_DIR));

// The JSON the form sends. At most 100 KB.
server.use(express.json({ limit: '100kb' }));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/token
// Is there a working token in server/.env? Never sends the token itself.
// ═══════════════════════════════════════════════════════════════════════════

server.get('/api/token', async (_request, response) => {
  const token = requireToken();
  const userName = await confluence.checkTokenWithConfluence(token);
  response.json({ ok: true, message: `Authenticated as ${userName}` });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/apps
// The app names, e.g. { apps: ['admin-app', 'web-app'] }
// ═══════════════════════════════════════════════════════════════════════════

server.get('/api/apps', (_request, response) => {
  response.json({ ok: true, apps: git.listApps() });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/tags?app=web-app
// The app's OLD / NEW tags, newest first, e.g. { tags: ['web-app-12-NEW', 'web-app-12-OLD', ...] }
// ═══════════════════════════════════════════════════════════════════════════

server.get('/api/tags', (request, response) => {
  response.json({ ok: true, tags: git.listTags(textValue(request.query.app)) });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/release
// Body: { app, from, to, version, date }
// Checks the form, reads the merged PRs, creates the release page and opens it.
// ═══════════════════════════════════════════════════════════════════════════

server.post('/api/release', async (request, response) => {
  const token = requireToken();

  // 1. Check what the form sent.
  if (!request.is('application/json')) {
    fail(415, 'Requests to the release server must be sent as JSON.');
  }
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(400, 'The request must be a JSON object, e.g. { "app": "web-app", ... }.');
  }
  const form = body as Record<string, unknown>;
  const app = textValue(form.app);
  const from = textValue(form.from);
  const to = textValue(form.to);
  const version = textValue(form.version);
  const date = textValue(form.date);

  if (!version || version.length > 50) {
    fail(400, 'Enter a version, e.g. 1.4.0 (at most 50 characters).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { // YYYY-MM-DD
    fail(400, 'Enter the release date as YYYY-MM-DD, e.g. 2026-10-30.');
  }

  const appTags = git.listTags(app); // also refuses unknown apps
  if (!appTags.includes(from) || !appTags.includes(to)) {
    fail(400, `"${from}" and "${to}" aren't both tags of ${app}. Pick the app again to reload its tags.`);
  }

  const parentPageId = config.parentPageIds[app];
  if (!parentPageId) {
    fail(400, `${app} has no parent page yet. Add "${app}": "<page ID>" to "parentPageIds" in server/config.json.`);
  }

  // 2. Read the merged PRs between the two tags.
  const pullRequests = git.listMergedPullRequests(app, from, to);
  if (pullRequests.length === 0) {
    fail(400, `No merged PRs in ${app} between ${from} and ${to}: no commit there has "Merged PR" in its message `
      + `and changes the ${app} folder. Check that "From tag" is the older tag and "To tag" the newer one.`);
  }

  // 3. Create the page in Confluence.
  const pageUrl = await confluence.createConfluencePage(token, {
    title: `Rel of ${app} - ${date}`,
    parentPageId,
    content: releasePageContent({ app, version, date, from, to, pullRequests }),
  });

  // 4. Open it.
  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  openInBrowser(pageUrl);
  response.json({ ok: true, pageUrl, pullRequestCount: pullRequests.length });
});

// ═══════════════════════════════════════════════════════════════════════════
// Anything else, and every error
// ═══════════════════════════════════════════════════════════════════════════

server.use(request => {
  fail(404, `The release server has no "${request.method} ${request.path}".`);
});

// Express calls this for every error: from fail(), from express.json(), or unexpected ones.
// (Express knows it's the error handler because it takes four arguments.)
server.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  let status = 500;
  let message = 'Something went wrong in the release server. The terminal it runs in shows the details.';

  // express.json() marks its errors with a "type".
  const bodyError = (error as { type?: string }).type;

  if (error instanceof HttpError) {
    // Our own errors, from fail().
    status = error.status;
    message = error.message;
  } else if (bodyError === 'entity.parse.failed') {
    status = 400;
    message = 'The request isn\'t valid JSON.';
  } else if (bodyError === 'entity.too.large') {
    status = 413;
    message = 'The request is too large (over 100 KB).';
  }

  // Unexpected errors may contain internals, so the form only gets a pointer to the terminal.
  if (status >= 500) console.error('[server]', error instanceof Error ? error.message : error);
  response.status(status).json({ ok: false, message });
});

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

// 127.0.0.1: only this computer can reach the server.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
