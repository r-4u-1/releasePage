// Release page creator, first version: lists the merged PRs of an app between two git tags.
//
//   GET  /             the form (public/index.html)
//   POST /api/release  { app, from, to } → the merged PRs between the two tags
//
// The monorepo's folder is set in config.json. Start with "node server.ts" and open http://localhost:3000/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'config.json'), 'utf8'));
const INDEX_HTML = path.join(import.meta.dirname, '..', 'public', 'index.html');

interface PullRequest {
  title: string;
  author: string;
}

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
      const { app, from, to } = await readJsonBody(request);
      sendJson(response, 200, { ok: true, pullRequests: listMergedPullRequests(app, from, to) });
      return;
    }

    sendJson(response, 404, { ok: false, message: `No ${request.method} ${request.url}` });
  } catch (error) {
    sendJson(response, 500, { ok: false, message: (error as Error).message });
  }
}).listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}/ (repo: ${config.repo})`);
});
