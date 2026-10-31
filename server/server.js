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
//   settings.js              config.json, the port, the paths and Confluence's address
//   helpers.js               fail() and other small helpers
//   git.js                   apps, tags and merged PRs
//   token.js                 the Confluence token from server/.env
//   confluence.js            Confluence's REST API: checking the token, creating a page
//   release-page-content.js  the page's table and info box
//   browser.js               opening the new page in the browser
//   web.js                   who may call the server, reading requests, sending answers
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.

const http = require('node:http');
const { config, PORT, CONFLUENCE_URL } = require('./lib/settings');
const { fail, textValue } = require('./lib/helpers');
const git = require('./lib/git');
const { requireToken } = require('./lib/token');
const confluence = require('./lib/confluence');
const { releasePageContent } = require('./lib/release-page-content');
const { openInBrowser } = require('./lib/browser');
const web = require('./lib/web');

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/token
// Is there a working token in server/.env? Never sends the token itself.
// ═══════════════════════════════════════════════════════════════════════════

async function checkToken() {
  const token = requireToken();
  const userName = await confluence.checkTokenWithConfluence(token);
  return { message: `Authenticated as ${userName}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/apps
// The app names, e.g. { apps: ['admin-app', 'web-app'] }
// ═══════════════════════════════════════════════════════════════════════════

function listApps() {
  return { apps: git.listApps() };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/tags?app=web-app
// The app's OLD / NEW tags, newest first, e.g. { tags: ['web-app-12-NEW', 'web-app-12-OLD', ...] }
// ═══════════════════════════════════════════════════════════════════════════

function listTags(app) {
  return { tags: git.listTags(app) };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/release
// Body: { app, from, to, version, date }
// Checks the form, reads the merged PRs, creates the release page and opens it.
// ═══════════════════════════════════════════════════════════════════════════

async function createRelease(body) {
  const token = requireToken();

  // 1. Check what the form sent.
  const { app, from, to } = body;
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

async function handleRequest(request, response) {
  try {
    // Only this computer's own page may use the server.
    if (!web.isFromOwnPage(request)) {
      fail(403, `This server only answers its own page. Open it as http://localhost:${PORT}/ or http://127.0.0.1:${PORT}/.`);
    }

    const { method } = request;
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');

    // The form page: "/" is index.html, "/style.css" is public/style.css, and so on.
    const fileName = web.publicFileFor(pathname);
    if (method === 'GET' && fileName) {
      web.sendPublicFile(response, fileName);
      return;
    }

    // Everything else is the API.
    let answer;
    if (method === 'GET' && pathname === '/api/token') {
      answer = await checkToken();
    } else if (method === 'GET' && pathname === '/api/apps') {
      answer = listApps();
    } else if (method === 'GET' && pathname === '/api/tags') {
      answer = listTags(searchParams.get('app'));
    } else if (method === 'POST' && pathname === '/api/release') {
      answer = await createRelease(await web.readJsonBody(request));
    } else {
      fail(404, `The release server has no "${method} ${pathname}".`);
    }

    web.sendJson(response, 200, { ok: true, ...answer });
  } catch (error) {
    // Our own errors (from fail) have a status. A URIError is a broken %-escape in the address.
    const status = error.status || (error instanceof URIError ? 400 : 500);
    if (status >= 500) console.error('[server]', error.message);

    // Unexpected errors may contain internals, so the form only gets a pointer to the terminal.
    const message = error.status || status === 400
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
