// Release page creator: creates the Confluence release page for one app in the monorepo.
//
//   GET  /             the form (public/index.html)
//   POST /api/release  { app, from, to, version, date } → creates the page, returns its address
//
// The server reads the merged PRs of the app between the two tags from git, puts them in a table,
// and creates the page "Rel of <app> - <date>" under the app's parent page in Confluence.
//
// The monorepo's folder and Confluence's address are set in config.json, the token in server/.env.
// Start with "node server.ts" and open http://localhost:3000/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'config.json'), 'utf8'));
const INDEX_HTML = path.join(import.meta.dirname, '..', 'public', 'index.html');
const ENV_FILE = path.join(import.meta.dirname, '.env');

interface PullRequest {
  title: string;
  author: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Git
// ═══════════════════════════════════════════════════════════════════════════

// The "Merged PR" commits on the main line between the two tags that changed the app's folder, newest first.
function listMergedPullRequests(app: string, from: string, to: string): PullRequest[] {
  const output = execSync(
    `git log --first-parent --grep="Merged PR" --format="%an|%s" ${from}..${to} -- ${app}`,
    { cwd: config.repo, encoding: 'utf8' },
  );

  return output.split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('|');
    return {
      author: line.slice(0, separator),
      // "Merged PR 1234: Add keyboard navigation" → "Add keyboard navigation"
      title: line.slice(separator + 1).replace(/^Merged PR \d+:\s*/, ''),
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Confluence
// ═══════════════════════════════════════════════════════════════════════════

// The token from server/.env:  CONFLUENCE_TOKEN=<your token>
function readToken(): string {
  const match = /^CONFLUENCE_TOKEN=(.*)$/m.exec(fs.readFileSync(ENV_FILE, 'utf8'));
  return match ? match[1].trim() : '';
}

// Calls Confluence's REST API and returns its JSON answer.
async function callConfluence(method: string, apiPath: string, body?: object): Promise<any> {
  const response = await fetch(config.confluenceBaseUrl + apiPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + readToken(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.message || `Confluence answered HTTP ${response.status}`);
  return answer;
}

// Creates a page under the parent page, in the parent's space. Returns the new page's address.
async function createConfluencePage(title: string, parentPageId: string, content: string): Promise<string> {
  const parent = await callConfluence('GET', `/rest/api/content/${parentPageId}?expand=space`);
  const page = await callConfluence('POST', '/rest/api/content', {
    type: 'page',
    title,
    space: { key: parent.space.key },
    ancestors: [{ id: parentPageId }],                               // the new page goes under this page
    body: { storage: { value: content, representation: 'storage' } }, // "storage" = Confluence's page HTML
  });
  return page._links.base + page._links.webui;
}

// The page: a summary line and a table with one row per PR.
function releasePageContent(version: string, date: string, from: string, to: string, pullRequests: PullRequest[]): string {
  const rows = pullRequests.map(pr => `<tr><td>${pr.author}</td><td>${pr.title}</td></tr>`).join('');
  return `<p><strong>Version:</strong> ${version} · <strong>Release date:</strong> ${date}`
    + ` · <strong>Tags:</strong> ${from} → ${to}</p>`
    + `<table><tbody><tr><th>Author</th><th>Pull request</th></tr>${rows}</tbody></table>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// The server
// ═══════════════════════════════════════════════════════════════════════════

async function createRelease(body: any): Promise<{ pageUrl: string; pullRequestCount: number }> {
  const { app, from, to, version, date } = body;
  const pullRequests = listMergedPullRequests(app, from, to);
  const pageUrl = await createConfluencePage(
    `Rel of ${app} - ${date}`,
    config.parentPageIds[app],
    releasePageContent(version, date, from, to, pullRequests),
  );
  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  return { pageUrl, pullRequestCount: pullRequests.length };
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

http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(fs.readFileSync(INDEX_HTML));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/release') {
      sendJson(response, 200, { ok: true, ...await createRelease(await readJsonBody(request)) });
      return;
    }

    sendJson(response, 404, { ok: false, message: `No ${request.method} ${request.url}` });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: (error as Error).message });
  }
}).listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}/ (repo: ${config.repo})`);
});
