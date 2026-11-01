// Confluence's REST API: checking the token and creating a page.
import { config, CONFLUENCE_URL, ENV_FILE } from './settings.ts';

// The parts of Confluence's answers this server reads.
interface ConfluenceUser {
  type?: string;            // "anonymous" when Cloud doesn't accept the token
  displayName?: string;
  username?: string;
}

interface ConfluencePage {
  space: { key: string };
  _links: { base?: string; webui: string };
}

export interface NewPage {
  title: string;
  parentPageId: string;
  content: string;          // the page's HTML, in Confluence's storage format
}

// The Authorization header for Confluence.
//   Data Center: the personal access token, sent as "Bearer <token>".
//   Cloud:       your account email and the API token, sent as "Basic <base64 of email:token>".
function authorizationHeader(token: string): string {
  if (!config.confluenceEmail) {
    return 'Bearer ' + token;
  }
  const emailAndToken = `${config.confluenceEmail}:${token}`;
  return 'Basic ' + Buffer.from(emailAndToken).toString('base64');
}

function tokenRejectedMessage(): string {
  return `Confluence rejected the token in ${ENV_FILE}. It's wrong or expired.`;
}

// Calls Confluence's REST API and returns its JSON answer.
//   method:  'GET' or 'POST'
//   apiPath: e.g. '/rest/api/user/current'
//   body:    sent as JSON (POST only)
async function callConfluence<Answer>(token: string, method: 'GET' | 'POST', apiPath: string, body?: object): Promise<Answer> {
  const response = await fetch(CONFLUENCE_URL + apiPath, {
    method,
    headers: {
      Authorization: authorizationHeader(token),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const answer: unknown = await response.json().catch(() => ({}));
  if (response.ok) return answer as Answer;

  if (response.status === 401) throw new Error(tokenRejectedMessage());
  const { message } = answer as { message?: string };
  throw new Error(message ? `Confluence said: ${message}` : `Confluence answered HTTP ${response.status}`);
}

// Asks Confluence who the token belongs to. Returns that person's name.
export async function checkTokenWithConfluence(token: string): Promise<string> {
  const user = await callConfluence<ConfluenceUser>(token, 'GET', '/rest/api/user/current');
  // Cloud answers a bad token with an "anonymous" user instead of 401.
  if (user.type === 'anonymous') throw new Error(tokenRejectedMessage());
  return user.displayName || user.username || 'user';
}

// Creates a page under the parent page, in the parent's space. Returns the new page's address.
export async function createConfluencePage(token: string, { title, parentPageId, content }: NewPage): Promise<string> {
  const parent = await callConfluence<ConfluencePage>(token, 'GET', `/rest/api/content/${parentPageId}?expand=space`);

  const page = await callConfluence<ConfluencePage>(token, 'POST', '/rest/api/content', {
    type: 'page',
    title,
    space: { key: parent.space.key },
    ancestors: [{ id: parentPageId }],                          // the new page goes under this page
    body: { storage: { value: content, representation: 'storage' } }, // "storage" = Confluence's page HTML
  });

  // _links.base is Confluence's address, _links.webui the page's path, e.g. "/pages/viewpage.action?pageId=123".
  return (page._links.base || CONFLUENCE_URL) + page._links.webui;
}
