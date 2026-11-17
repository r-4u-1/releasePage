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
//   GET  /api/repo-path                the repo's root from repoPath in config.json, and its apps
//   GET  /api/folder?path=…            is this path a folder in a git repo? Returns the repo's root
//   GET  /api/token                    is there a working token in server/.env?
//   GET  /api/apps?repo=…              the app names in that repo
//   GET  /api/tags?repo=…&app=web-app  the app's OLD / NEW tags
//   POST /api/release                  create the release page
//
// The details live in lib/:
//   settings.ts              config.json and the paths
//   git.ts                   apps, tags and merged PRs
//   confluence.ts            the token, checking it, creating a page
//   release-pages/           the page's content: a base template, and one file per app
//   browser.ts               opening the new page in the browser
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, PORT, PUBLIC_DIR } from './lib/settings.ts';
import * as git from './lib/git.ts';
import * as confluence from './lib/confluence.ts';
import { releasePageContent } from './lib/release-pages/index.ts';
import { openInBrowser } from './lib/browser.ts';

// POST /api/release
// Body: { repo, app, from, to, version, date }
// Reads the merged PRs, creates the release page and opens it.
async function createRelease(body: any): Promise<{ pageUrl: string; pullRequestCount: number }> {
  const { repo, app, from, to, version, date } = body;
  const pullRequests = git.listMergedPullRequests(repo, app, from, to);
  const pageUrl = await confluence.createConfluencePage(
    `Rel of ${app} - ${date}`,
    config.parentPageIds[app],
    releasePageContent({ app, version, date, from, to, pullRequests }),
  );
  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  openInBrowser(pageUrl);
  return { pageUrl, pullRequestCount: pullRequests.length };
}

// GET /api/repo-path
// The repo from repoPath in config.json, if it's set and has apps in it.
// When it fails, the form asks for the path instead.
function repoPathFromConfig(): { folder: string; apps: string[] } {
  const repoPath = (config.repoPath ?? '').trim();
  // Without this check, git would run in the server's own folder.
  if (!repoPath) throw new Error('No repoPath in config.json');
  if (!fs.existsSync(repoPath)) throw new Error(`repoPath in config.json doesn't exist: ${repoPath}`);
  const folder = git.findRepo(repoPath);
  const apps = git.listApps(folder);
  if (apps.length === 0) throw new Error(`No apps matching ${config.appPattern} in ${folder}`);
  return { folder, apps };
}

// ═══════════════════════════════════════════════════════════════════════════
// Requests and answers
// ═══════════════════════════════════════════════════════════════════════════

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// The form page: "/" is index.html, "/style.css" is public/style.css, and so on.
function sendPublicFile(response: http.ServerResponse, pathname: string): void {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const content = fs.readFileSync(file); // read first: a missing file fails before anything is sent
  response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
  response.end(content);
}

async function readJsonBody(request: http.IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}

function sendJson(response: http.ServerResponse, status: number, data: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// The API's routes, as "METHOD /path".
// An object rather than an enum: Node runs this file as it is, and it can't run an enum.
const Route = {
  RepoPath: 'GET /api/repo-path',
  Folder: 'GET /api/folder',
  Token: 'GET /api/token',
  Apps: 'GET /api/apps',
  Tags: 'GET /api/tags',
  Release: 'POST /api/release',
} as const;

type RouteKey = (typeof Route)[keyof typeof Route];

// Each route returns the answer, which is sent as { ok: true, ...answer }.
type RouteHandler = (query: URLSearchParams, request: http.IncomingMessage) => object | Promise<object>;

// A Record over RouteKey: leaving out a route is a type error.
const routes: Record<RouteKey, RouteHandler> = {
  [Route.RepoPath]: () => repoPathFromConfig(),
  [Route.Folder]: query => ({ folder: git.findRepo(query.get('path') ?? '') }),
  [Route.Token]: async () => ({ message: `Authenticated as ${await confluence.checkToken()}` }),
  [Route.Apps]: query => ({ apps: git.listApps(query.get('repo') ?? '') }),
  [Route.Tags]: query => ({ tags: git.listTags(query.get('repo') ?? '', query.get('app') ?? '') }),
  [Route.Release]: async (query, request) => createRelease(await readJsonBody(request)),
};

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');

    // Any other request finds nothing here, hence the "| undefined".
    const route: RouteHandler | undefined = routes[`${method} ${pathname}` as RouteKey];
    if (route) {
      sendJson(response, 200, { ok: true, ...await route(searchParams, request) });
    } else if (method === 'GET') {
      sendPublicFile(response, pathname);
    } else {
      sendJson(response, 404, { ok: false, message: `No ${method} ${pathname}` });
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, message: (error as Error).message });
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${config.confluenceBaseUrl})`);
});
