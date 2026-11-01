// Confluence: the token from server/.env, checking it, and creating a page.
import fs from 'node:fs';
import { config, ENV_FILE } from './settings.ts';

// The token from server/.env:  CONFLUENCE_TOKEN=<your token>
// Read every time, so adding the token works without restarting the server.
function readToken(): string {
  if (!fs.existsSync(ENV_FILE)) return '';
  const match = /^CONFLUENCE_TOKEN=(.*)$/m.exec(fs.readFileSync(ENV_FILE, 'utf8'));
  return match ? match[1].trim() : '';
}

function requireToken(): string {
  const token = readToken();
  if (!token) throw new Error(`No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to ${ENV_FILE}`);
  return token;
}

// Calls Confluence's REST API and returns its JSON answer.
async function callConfluence(method: string, apiPath: string, body?: object): Promise<any> {
  const response = await fetch(config.confluenceBaseUrl + apiPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + requireToken(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error(`Confluence rejected the token in ${ENV_FILE}. It's wrong or expired.`);
  if (!response.ok) throw new Error(answer.message || `Confluence answered HTTP ${response.status}`);
  return answer;
}

// Asks Confluence who the token belongs to. Returns that person's name.
export async function checkToken(): Promise<string> {
  const user = await callConfluence('GET', '/rest/api/user/current');
  return user.displayName || user.username || 'user';
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
