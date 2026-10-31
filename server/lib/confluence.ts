import { config, CONFLUENCE_URL, ENV_FILE } from './settings.ts';
import { fail, HttpError } from './helpers.ts';

interface ConfluenceUser {
  type?: string;
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
  content: string;
}

function authorizationHeader(token: string): string {
  if (!config.confluenceEmail) {
    return 'Bearer ' + token;
  }
  const emailAndToken = `${config.confluenceEmail}:${token}`;
  return 'Basic ' + Buffer.from(emailAndToken).toString('base64');
}

function cannotReachConfluence(caught: unknown): string {
  const error = caught as Error & { cause?: { code?: string } };
  const reason = error.cause?.code || error.name;
  const where = `Confluence at ${CONFLUENCE_URL}`;
  const checkUrl = 'Check "confluenceBaseUrl" in server/config.json';

  if (reason === 'TimeoutError') {
    return `${where} didn't answer within 30 seconds. Check that you're on the network or VPN that can reach it.`;
  }
  if (reason === 'ENOTFOUND') {
    return `Can't find ${where}: that address doesn't exist. ${checkUrl}.`;
  }
  if (reason === 'ECONNREFUSED') {
    return `${where} refused the connection. ${checkUrl}, including the port.`;
  }
  if (/CERT|UNABLE_TO_VERIFY/.test(reason || '')) {
    return `Can't verify the security certificate of ${where} (${reason}). If your company inspects HTTPS traffic, `
      + 'start Node with NODE_EXTRA_CA_CERTS=<path to the company root certificate>.';
  }
  return `Can't reach ${where} (${reason || error.message}). ${checkUrl}, and that you're on the network or VPN that can reach it.`;
}

function tokenRejectedMessage(): string {
  return `Confluence rejected the token in ${ENV_FILE}. It's wrong or expired: create a new one in Confluence `
    + '(profile picture → Settings → Personal Access Tokens) and replace it.';
}

async function callConfluence<Answer>(token: string, method: 'GET' | 'POST', apiPath: string, body?: object): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(CONFLUENCE_URL + apiPath, {
      method,
      headers: {
        Authorization: authorizationHeader(token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(502, cannotReachConfluence(error));
  }

  const answer: unknown = await response.json().catch(() => ({}));
  if (response.ok) return answer as Answer;

  const status = response.status;
  const { message } = answer as { message?: string };
  const checkUrl = 'Check "confluenceBaseUrl" in server/config.json (for Confluence Cloud it ends in /wiki).';

  if (status === 401) {
    fail(401, tokenRejectedMessage());
  }
  if (status === 403) {
    fail(403, 'Your Confluence account isn\'t allowed to do this' + (message ? `: ${message}` : '.')
      + ' Check that it can see the parent page and add pages in its space.');
  }
  if (status >= 300 && status < 400) {
    fail(502, `Confluence at ${CONFLUENCE_URL} sent the request somewhere else (HTTP ${status}), usually to a login page. ${checkUrl}`);
  }
  if (status === 404) {
    fail(404, `Confluence at ${CONFLUENCE_URL} has nothing at ${apiPath} (HTTP 404). ${checkUrl}`);
  }
  if (status >= 500) {
    fail(502, `Confluence had an internal problem (HTTP ${status}). Try again in a few minutes.`);
  }
  fail(status, message
    ? `Confluence said: ${message}`
    : `Confluence refused the request (HTTP ${status}) without saying why.`);
}

export async function checkTokenWithConfluence(token: string): Promise<string> {
  const user = await callConfluence<ConfluenceUser>(token, 'GET', '/rest/api/user/current');
  if (user.type === 'anonymous') fail(401, tokenRejectedMessage());
  return user.displayName || user.username || 'user';
}

export async function createConfluencePage(token: string, { title, parentPageId, content }: NewPage): Promise<string> {
  let parent: ConfluencePage;
  try {
    parent = await callConfluence<ConfluencePage>(token, 'GET', `/rest/api/content/${encodeURIComponent(parentPageId)}?expand=space`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      fail(400, `There's no Confluence page with ID ${parentPageId}, or your account can't see it. `
        + 'Check "parentPageIds" in server/config.json: the ID is in the page\'s address (…pageId=123456).');
    }
    throw error;
  }

  const page = await callConfluence<ConfluencePage>(token, 'POST', '/rest/api/content', {
    type: 'page',
    title,
    space: { key: parent.space.key },
    ancestors: [{ id: parentPageId }],
    body: { storage: { value: content, representation: 'storage' } },
  });

  return (page._links.base || CONFLUENCE_URL) + page._links.webui;
}
