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
//   GET  /api/folder?path=…            is this path a folder in a git repo? Returns the repo's root
//   GET  /api/token                    is there a working token in server/.env?
//   GET  /api/apps?repo=…              the app names in that repo
//   GET  /api/tags?repo=…&app=web-app  the app's OLD / NEW tags
//   POST /api/release                  create the release page
//
// The form sends the monorepo's root folder (from /api/folder) with every request, and git runs there.
//
// This file shows what each of those does, and handleRequest() at the bottom picks one by its path. The details live in lib/:
//   settings.ts              config.json, the port, the paths and Confluence's address
//   git.ts                   apps, tags and merged PRs
//   token.ts                 the Confluence token from server/.env
//   confluence.ts            Confluence's REST API: checking the token, creating a page
//   release-page-content.ts  the page's table and info box
//   browser.ts               opening the new page in the browser
//   web.ts                   reading requests, sending answers and files
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.

import http from 'node:http';
import { config, PORT, CONFLUENCE_URL } from './lib/settings.ts';
import * as git from './lib/git.ts';
import { requireToken } from './lib/token.ts';
import * as confluence from './lib/confluence.ts';
import { releasePageContent } from './lib/release-page-content.ts';
import { openInBrowser } from './lib/browser.ts';
import * as web from './lib/web.ts';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/folder?path=C:\git\monorepo
// Is this path a folder in a git repo? The form checks the monorepo's path with it.
// Returns the repo's root, e.g. { folder: 'C:\\git\\monorepo' }, which the form sends with every later request.
// ═══════════════════════════════════════════════════════════════════════════

function checkFolder(folder: string): { folder: string } {
  return { folder: git.findRepo(folder) };
}

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
// GET /api/apps?repo=C:\git\monorepo
// The app names, e.g. { apps: ['admin-app', 'web-app'] }
// ═══════════════════════════════════════════════════════════════════════════

function listApps(repo: string): { apps: string[] } {
  return { apps: git.listApps(repo) };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/tags?repo=C:\git\monorepo&app=web-app
// The app's OLD / NEW tags, newest first, e.g. { tags: ['web-app-12-NEW', 'web-app-12-OLD', ...] }
// ═══════════════════════════════════════════════════════════════════════════

function listTags(repo: string, app: string): { tags: string[] } {
  return { tags: git.listTags(repo, app) };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/release
// Body: { repo, app, from, to, version, date }
// Reads the merged PRs, creates the release page and opens it.
// ═══════════════════════════════════════════════════════════════════════════

async function createRelease(body: Record<string, any>): Promise<{ pageUrl: string; pullRequestCount: number }> {
  const token = requireToken();
  const { repo, app, from, to, version, date } = body;

  // 1. Read the merged PRs between the two tags.
  const pullRequests = git.listMergedPullRequests(repo, app, from, to);

  // 2. Create the page in Confluence.
  const pageUrl = await confluence.createConfluencePage(token, {
    title: `Rel of ${app} - ${date}`,
    parentPageId: config.parentPageIds[app],
    content: releasePageContent({ app, version, date, from, to, pullRequests }),
  });

  // 3. Open it.
  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  openInBrowser(pageUrl);
  return { pageUrl, pullRequestCount: pullRequests.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Every request goes through here
// ═══════════════════════════════════════════════════════════════════════════

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');

    let answer: object;
    if (method === 'GET' && pathname === '/api/folder') {
      answer = checkFolder(searchParams.get('path') ?? '');
    } else if (method === 'GET' && pathname === '/api/token') {
      answer = await checkToken();
    } else if (method === 'GET' && pathname === '/api/apps') {
      answer = listApps(searchParams.get('repo') ?? '');
    } else if (method === 'GET' && pathname === '/api/tags') {
      answer = listTags(searchParams.get('repo') ?? '', searchParams.get('app') ?? '');
    } else if (method === 'POST' && pathname === '/api/release') {
      answer = await createRelease(await web.readJsonBody(request));
    } else if (method === 'GET') {
      // The form page: "/" is index.html, "/style.css" is public/style.css, "/form.js" is client/form.ts, and so on.
      web.sendPublicFile(response, pathname);
      return;
    } else {
      web.sendJson(response, 404, { ok: false, message: `The release server has no "${method} ${pathname}".` });
      return;
    }

    web.sendJson(response, 200, { ok: true, ...answer });
  } catch (error) {
    console.error('[server]', error instanceof Error ? error.message : error);
    web.sendJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
