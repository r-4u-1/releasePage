// Local server for the release form.
//
// It does two things:
//   1. Serves the form page (the files in public/).
//   2. Answers the form: which apps and tags exist, and creates the release page in Confluence.
//
// The API:
//   GET  /api/folder?path=…            is this path a folder in a git repo? Returns the repo's root
//   GET  /api/apps?repo=…              the app names in that repo
//   GET  /api/tags?repo=…&app=web-app  the app's OLD / NEW tags
//   POST /api/release                  create the release page
//
// The details live in lib/:
//   settings.ts    config.json and the paths
//   git.ts         apps, tags and merged PRs
//   confluence.ts  the token, creating the page and its content
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, PORT, PUBLIC_DIR } from './lib/settings.ts';
import * as git from './lib/git.ts';
import * as confluence from './lib/confluence.ts';

// POST /api/release
// Body: { repo, app, from, to, version, date }
// Reads the merged PRs and creates the release page.
async function createRelease(body: any): Promise<{ pageUrl: string; pullRequestCount: number }> {
  const { repo, app, from, to, version, date } = body;
  const pullRequests = git.listMergedPullRequests(repo, app, from, to);
  const pageUrl = await confluence.createConfluencePage(
    `Rel of ${app} - ${date}`,
    config.parentPageIds[app],
    confluence.releasePageContent(version, date, from, to, pullRequests),
  );
  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  return { pageUrl, pullRequestCount: pullRequests.length };
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

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');
    const repo = searchParams.get('repo') ?? '';

    let answer: object;
    if (method === 'GET' && pathname === '/api/folder') {
      answer = { folder: git.findRepo(searchParams.get('path') ?? '') };
    } else if (method === 'GET' && pathname === '/api/apps') {
      answer = { apps: git.listApps(repo) };
    } else if (method === 'GET' && pathname === '/api/tags') {
      answer = { tags: git.listTags(repo, searchParams.get('app') ?? '') };
    } else if (method === 'POST' && pathname === '/api/release') {
      answer = await createRelease(await readJsonBody(request));
    } else if (method === 'GET') {
      sendPublicFile(response, pathname);
      return;
    } else {
      sendJson(response, 404, { ok: false, message: `No ${method} ${pathname}` });
      return;
    }

    sendJson(response, 200, { ok: true, ...answer });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: (error as Error).message });
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
