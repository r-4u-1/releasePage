// Confluence's REST API: checking the token and creating a page.
const { config, CONFLUENCE_URL, ENV_FILE } = require('./settings');
const { fail } = require('./helpers');

// The Authorization header for Confluence.
//   Data Center: the personal access token, sent as "Bearer <token>".
//   Cloud:       your account email and the API token, sent as "Basic <base64 of email:token>".
function authorizationHeader(token) {
  if (!config.confluenceEmail) {
    return 'Bearer ' + token;
  }
  const emailAndToken = `${config.confluenceEmail}:${token}`;
  return 'Basic ' + Buffer.from(emailAndToken).toString('base64');
}

// Why Confluence couldn't be reached at all, in words someone can act on.
// error.cause.code is Node's reason, e.g. ENOTFOUND (no such address) or SELF_SIGNED_CERT_IN_CHAIN.
function cannotReachConfluence(error) {
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

// The message for a token Confluence doesn't accept.
function tokenRejectedMessage() {
  return `Confluence rejected the token in ${ENV_FILE}. It's wrong or expired: create a new one in Confluence `
    + '(profile picture → Settings → Personal Access Tokens) and replace it.';
}

// Calls Confluence's REST API and returns its JSON answer, or fails with a readable message.
//   method:  'GET' or 'POST'
//   apiPath: e.g. '/rest/api/user/current'
//   body:    sent as JSON (POST only)
async function callConfluence(token, method, apiPath, body) {
  let response;
  try {
    response = await fetch(CONFLUENCE_URL + apiPath, {
      method,
      headers: {
        Authorization: authorizationHeader(token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',                  // a redirect means a login page, not an answer
      signal: AbortSignal.timeout(30_000), // give up after 30 seconds
    });
  } catch (error) {
    fail(502, cannotReachConfluence(error));
  }

  const answer = await response.json().catch(() => ({}));
  if (response.ok) return answer;

  const status = response.status;
  const checkUrl = 'Check "confluenceBaseUrl" in server/config.json (for Confluence Cloud it ends in /wiki).';

  if (status === 401) {
    fail(401, tokenRejectedMessage());
  }
  if (status === 403) {
    fail(403, 'Your Confluence account isn\'t allowed to do this' + (answer.message ? `: ${answer.message}` : '.')
      + ' Check that it can see the parent page and add pages in its space.');
  }
  if (status >= 300 && status < 400) {
    // Usually a redirect to a login page: the address isn't Confluence's REST API.
    fail(502, `Confluence at ${CONFLUENCE_URL} sent the request somewhere else (HTTP ${status}), usually to a login page. ${checkUrl}`);
  }
  if (status === 404) {
    fail(404, `Confluence at ${CONFLUENCE_URL} has nothing at ${apiPath} (HTTP 404). ${checkUrl}`);
  }
  if (status >= 500) {
    fail(502, `Confluence had an internal problem (HTTP ${status}). Try again in a few minutes.`);
  }
  // Confluence explains most other problems itself, e.g. "A page with this title already exists".
  fail(status, answer.message
    ? `Confluence said: ${answer.message}`
    : `Confluence refused the request (HTTP ${status}) without saying why.`);
}

// Asks Confluence who the token belongs to. Returns that person's name, or fails.
async function checkTokenWithConfluence(token) {
  const user = await callConfluence(token, 'GET', '/rest/api/user/current');
  // Cloud answers a bad token with an "anonymous" user instead of 401.
  if (user.type === 'anonymous') fail(401, tokenRejectedMessage());
  return user.displayName || user.username || 'user';
}

// Creates a page under the parent page, in the parent's space. Returns the new page's address.
async function createConfluencePage(token, { title, parentPageId, content }) {
  let parent;
  try {
    parent = await callConfluence(token, 'GET', `/rest/api/content/${encodeURIComponent(parentPageId)}?expand=space`);
  } catch (error) {
    if (error.status === 404) {
      fail(400, `There's no Confluence page with ID ${parentPageId}, or your account can't see it. `
        + 'Check "parentPageIds" in server/config.json: the ID is in the page\'s address (…pageId=123456).');
    }
    throw error;
  }

  const page = await callConfluence(token, 'POST', '/rest/api/content', {
    type: 'page',
    title,
    space: { key: parent.space.key },
    ancestors: [{ id: parentPageId }],                          // the new page goes under this page
    body: { storage: { value: content, representation: 'storage' } }, // "storage" = Confluence's page HTML
  });

  // _links.base is Confluence's address, _links.webui the page's path, e.g. "/pages/viewpage.action?pageId=123".
  return (page._links.base || CONFLUENCE_URL) + page._links.webui;
}

module.exports = { checkTokenWithConfluence, createConfluencePage };
