// Local server for the release form.
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
// This file shows what each of those does, and handleRequest() at the bottom picks one by its path. The details live in lib/:
//   settings.ts              config.json, the port, the paths and Confluence's address
//   helpers.ts               fail() and other small helpers
//   git.ts                   apps, tags and merged PRs
//   token.ts                 the Confluence token from server/.env
//   confluence.ts            Confluence's REST API: checking the token, creating a page
//   release-page-content.ts  the page's table and info box
//   browser.ts               opening the new page in the browser
//   web.ts                   who may call the server, reading requests, sending answers
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.

import http from 'node:http';
import { config, PORT, CONFLUENCE_URL } from './lib/settings';
import { fail, textValue, HttpError } from './lib/helpers';
import * as git from './lib/git';
import { requireToken } from './lib/token';
import * as confluence from './lib/confluence';
import { releasePageContent } from './lib/release-page-content';
import { openInBrowser } from './lib/browser';
import * as web from './lib/web';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/token
// Is there a working token in server/.env? Never sends the token itself.
// ═══════════════════════════════════════════════════════════════════════════

async function checkToken(): Promise<{ message: string }> {
  const token = requireToken();
  const userName = await confluence.checkTokenWithConfluence(token);
  return { message: `Authenticated as ${userName}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/apps
// The app names, e.g. { apps: ['admin-app', 'web-app'] }
// ═══════════════════════════════════════════════════════════════════════════

function listApps(): { apps: string[] } {
  return { apps: git.listApps() };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/tags?app=web-app
// The app's OLD / NEW tags, newest first, e.g. { tags: ['web-app-12-NEW', 'web-app-12-OLD', ...] }
// ═══════════════════════════════════════════════════════════════════════════

function listTags(app: string): { tags: string[] } {
  return { tags: git.listTags(app) };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/release
// Body: { app, from, to, version, date }
// Checks the form, reads the merged PRs, creates the release page and opens it.
// ═══════════════════════════════════════════════════════════════════════════

async function createRelease(body: Record<string, unknown>): Promise<{ pageUrl: string; pullRequestCount: number }> {
  const token = requireToken();

  // 1. Check what the form sent.
  const app = textValue(body.app);
  const from = textValue(body.from);
  const to = textValue(body.to);
  const version = textValue(body.version);
  const date = textValue(body.date);

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
  return { pageUrl, pullRequestCount: pullRequests.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Every request goes through here
// ═══════════════════════════════════════════════════════════════════════════

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    // Only this computer's own page may use the server.
    if (!web.isFromOwnPage(request)) {
      fail(403, `This server only answers its own page. Open it as http://localhost:${PORT}/ or http://127.0.0.1:${PORT}/.`);
    }

    const method = request.method ?? 'GET';
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');

    // The form page: "/" is index.html, "/style.css" is public/style.css, and so on.
    const fileName = web.publicFileFor(pathname);
    if (method === 'GET' && fileName) {
      web.sendPublicFile(response, fileName);
      return;
    }

    // Everything else is the API.
    let answer: object;
    if (method === 'GET' && pathname === '/api/token') {
      answer = await checkToken();
    } else if (method === 'GET' && pathname === '/api/apps') {
      answer = listApps();
    } else if (method === 'GET' && pathname === '/api/tags') {
      answer = listTags(searchParams.get('app') ?? '');
    } else if (method === 'POST' && pathname === '/api/release') {
      answer = await createRelease(await web.readJsonBody(request));
    } else {
      fail(404, `The release server has no "${method} ${pathname}".`);
    }

    web.sendJson(response, 200, { ok: true, ...answer });
  } catch (error) {
    // Our own errors (from fail) have a status. Anything else is unexpected.
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('[server]', error instanceof Error ? error.message : error);

    // Unexpected errors may contain internals, so the form only gets a pointer to the terminal.
    const message = error instanceof HttpError
      ? error.message
      : 'Something went wrong in the release server. The terminal it runs in shows the details.';
    web.sendJson(response, status, { ok: false, message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

// 127.0.0.1: only this computer can reach the server.
http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
