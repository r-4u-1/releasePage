// Talks to Confluence's REST API, and builds the release page.
const config = require('./config');
const { HttpError } = require('./web');

const BASE_URL = config.confluenceBaseUrl;

// Data Center: the token is a personal access token, sent as Bearer.
// Cloud: the token is sent together with the account email (Basic).
function authHeader(token) {
  if (!config.confluenceEmail) return 'Bearer ' + token;
  return 'Basic ' + Buffer.from(`${config.confluenceEmail}:${token}`).toString('base64');
}

const MESSAGES = {
  401: 'Token rejected by Confluence',
  403: 'Token has no access to this resource',
  404: 'Not found on Confluence',
};

// GETs a Confluence REST path, or POSTs `body` to it. Returns the JSON answer,
// or throws an HttpError with a readable message (e.g. "A page with this title already exists").
async function request(path, token, body) {
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: authHeader(token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Atlassian-Token': 'no-check', // lets REST writes past Confluence's XSRF check
      },
      body: body && JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Confluence');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const message = MESSAGES[res.status] || data.message || `Confluence responded with HTTP ${res.status}`;
  throw new HttpError(res.status >= 400 ? res.status : 502, message);
}

// The name of the token's owner — proof that the token works.
async function currentUser(token) {
  const user = await request('/rest/api/user/current', token);
  if (user.type === 'anonymous') throw new HttpError(401, MESSAGES[401]); // Cloud, with a bad token
  return user.displayName || user.username || 'user';
}

function getPage(pageId, token) {
  return request(`/rest/api/content/${pageId}?expand=space`, token);
}

// Creates "Release <version> <date>" under `parent`, in the parent's space.
async function createReleasePage({ token, parent, version, date, ...release }) {
  const title = `Release ${version} ${date}`;
  const page = await request('/rest/api/content', token, {
    type: 'page',
    title,
    space: { key: parent.space.key },
    ancestors: [{ id: parent.id }],
    body: { storage: { representation: 'storage', value: releaseBody({ date, ...release }) } },
  });
  const url = (page._links?.base || BASE_URL) + (page._links?.webui || `/pages/viewpage.action?pageId=${page.id}`);
  return { title, url, id: page.id };
}

// ── Page content (Confluence storage format, a kind of XHTML) ───────────────

const TITLE_MAX = 80;

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shorten(text) {
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text;
}

// An unticked Confluence checkbox. Task IDs must be unique within the page.
function checkbox(taskId) {
  return `<ac:task-list><ac:task><ac:task-id>${taskId}</ac:task-id>`
    + '<ac:task-status>incomplete</ac:task-status><ac:task-body></ac:task-body>'
    + '</ac:task></ac:task-list>';
}

function releaseBody({ app, from, to, date, changes }) {
  const intro = `<p><strong>App:</strong> ${escapeXml(app)}`
    + ` · <strong>Tags:</strong> <code>${escapeXml(from)}</code> → <code>${escapeXml(to)}</code>`
    + ` · <strong>Date:</strong> ${escapeXml(date)}</p>`;
  if (!changes.length) return intro + '<p>No changes in this release.</p>';

  const rows = changes.map((change, i) => {
    const title = escapeXml(shorten(change.title)) + (change.pr ? ` (#${change.pr})` : '');
    return `<tr><td>${escapeXml(change.author)}</td><td>${title}</td>`
      + `<td>${checkbox(2 * i + 1)}</td><td>${checkbox(2 * i + 2)}</td></tr>`;
  });

  return intro
    + '<table><tbody>'
    + '<tr><th>Author</th><th>PR</th><th>Affects a11y</th><th>No a11y impact</th></tr>'
    + rows.join('')
    + '</tbody></table>';
}

module.exports = { currentUser, getPage, createReleasePage };
