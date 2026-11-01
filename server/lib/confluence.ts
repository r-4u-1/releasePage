// Confluence: the token from server/.env, and creating the release page.
import fs from 'node:fs';
import { config, ENV_FILE } from './settings.ts';
import type { PullRequest } from './git.ts';

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
export async function createConfluencePage(title: string, parentPageId: string, content: string): Promise<string> {
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
export function releasePageContent(version: string, date: string, from: string, to: string, pullRequests: PullRequest[]): string {
  const rows = pullRequests.map(pr => `<tr><td>${pr.author}</td><td>${pr.title}</td></tr>`).join('');
  return `<p><strong>Version:</strong> ${version} · <strong>Release date:</strong> ${date}`
    + ` · <strong>Tags:</strong> ${from} → ${to} · <strong>Pull requests:</strong> ${pullRequests.length}</p>`
    + `<table><tbody><tr><th>Author</th><th>Pull request</th></tr>${rows}</tbody></table>`;
}
