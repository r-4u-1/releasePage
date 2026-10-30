// Local server for the release form.
//
// It does three things:
//   1. Serves the form page (the files in public/).
//   2. Answers the form's questions: which apps exist, which tags they have, does the token work.
//   3. Creates the release page in Confluence:
//        - reads the "Merged PR" commits of the app between the two tags,
//        - builds a table of them (author + PR title, plus isVerified and Note for some apps),
//        - creates the page under the app's parent page,
//        - opens the new page in the browser.
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const config = require('./config.json');

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

// The PORT environment variable wins over config.json.
const PORT = Number(process.env.PORT) || config.port;

// The folder with the form page. Only the files in it can be fetched, nothing else on disk.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_FILES = fs.readdirSync(PUBLIC_DIR);

// Where the token is saved. Only used if you created this file yourself.
const ENV_FILE = path.join(__dirname, '.env');

// Confluence's address, without a trailing slash.
const CONFLUENCE_URL = config.confluenceBaseUrl.replace(/\/+$/, '');

// The token that last passed the check with Confluence (or was loaded from .env at start).
// It's only kept in memory, and never sent back to the browser.
let activeToken = '';

// ═══════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════

// Stops the current request with an error. The form gets { ok: false, message } with this HTTP status.
function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

// A form value as trimmed text, or '' if it isn't text at all.
function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Makes text safe to put inside a regular expression, e.g. "web.app" matches only "web.app", not "webXapp".
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Makes text safe to put inside the page's HTML, e.g. a PR title "Fix <input> & more".
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════
// Git: apps, tags and merged PRs
// ═══════════════════════════════════════════════════════════════════════════

// Runs a git command in the given folder and returns what it printed.
function runGit(args, folder) {
  try {
    return execFileSync('git', args, {
      cwd: folder,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const firstErrorLine = String(error.stderr || error.message).trim().split('\n')[0];
    fail(500, `git failed: ${firstErrorLine}`);
  }
}

// The monorepo root: from config.json, or else the git repo this tool is inside.
const REPO_ROOT = config.repoRoot
  ? path.resolve(__dirname, config.repoRoot)
  : runGit(['rev-parse', '--show-toplevel'], __dirname).trim();

// The top-level folder this tool lives in, e.g. "release-page". It's never listed as an app.
const OWN_FOLDER = path.relative(REPO_ROOT, __dirname).split(path.sep)[0];

// appPattern as a regular expression. Only * is special and means "anything":
//   "*-app"  →  /^.*-app$/   matches "web-app" and "admin-app", but not "docs"
const APP_NAME_PATTERN = new RegExp(
  '^' + config.appPattern.split('*').map(escapeForRegExp).join('.*') + '$'
);

// The app names: top-level folders of the monorepo that match appPattern.
// Only matters for broad patterns like "*": hidden folders, node_modules and this tool's own folder are left out.
function listApps() {
  const folders = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  return folders
    .filter(name => APP_NAME_PATTERN.test(name))
    .filter(name => !name.startsWith('.') && name !== 'node_modules' && name !== OWN_FOLDER)
    .sort();
}

// The app's release tags, highest number first, e.g.
//   web-app-12-NEW, web-app-12-OLD, web-app-11-NEW, ...
// Unknown app names are refused here, so they never reach git.
function listTags(app) {
  if (!listApps().includes(app)) {
    fail(404, `Unknown app "${app}"`);
  }

  // <app>-<number>-OLD or <app>-<number>-NEW. The number is captured as group 1.
  const tagPattern = new RegExp(`^${escapeForRegExp(app)}-(\\d+)-(OLD|NEW)$`);
  const tagNumber = tag => Number(tagPattern.exec(tag)[1]);

  const allTags = runGit(['tag', '--list', `${app}-*`], path.join(REPO_ROOT, app))
    .split('\n')
    .map(tag => tag.trim());

  return allTags
    .filter(tag => tagPattern.test(tag))
    .sort((a, b) => tagNumber(b) - tagNumber(a) || a.localeCompare(b)); // a, b: two tags being compared
}

// git prints one line per commit. Between the fields of a line it puts this invisible
// "unit separator" character, which never appears in names or commit messages.
const FIELD_SEPARATOR = '\x1f';

// The PRs merged into the app between the two tags, newest first:
//   [{ title: 'Add keyboard navigation', author: 'Alice' }, ...]
// A merged PR is a commit whose message contains "Merged PR", e.g. "Merged PR 1234: Add keyboard navigation".
function listMergedPullRequests(app, fromTag, toTag) {
  const output = runGit([
    'log',
    '--first-parent',                  // only the commits made on the main line, not the commits inside each PR
    '--grep=Merged PR',                // only commits whose message contains "Merged PR"
    '--format=%H%x1f%P%x1f%an%x1f%s',  // hash, parent hashes, author, subject — separated by FIELD_SEPARATOR
    `${fromTag}..${toTag}`,            // everything after fromTag, up to and including toTag
    '--',
    '.',                               // only commits that changed this app's folder (git runs inside it)
  ], path.join(REPO_ROOT, app));

  const commits = output.split('\n').filter(Boolean).map(line => {
    const [hash, parents, mergedBy, subject] = line.split(FIELD_SEPARATOR);
    return {
      hash,
      // A merge commit has two parents: [main line, last commit of the PR's branch].
      // A squashed PR is a single commit with one parent.
      prBranchTip: parents.split(' ')[1],
      mergedBy,
      // "Merged PR 1234: Add keyboard navigation" → "Add keyboard navigation"
      title: subject.replace(/^Merged PR \d+:\s*/, ''),
    };
  });

  const authors = authorsOfCommits(commits.map(commit => commit.prBranchTip).filter(Boolean));

  // The person who opened the PR: the author of the PR branch's last commit.
  // For a squashed PR there's no branch left, so it's the author of the squashed commit.
  return commits.map(commit => ({
    title: commit.title,
    author: authors[commit.prBranchTip] || commit.mergedBy,
  }));
}

// The author of each commit, in one git call: { '<hash>': 'Alice', ... }
function authorsOfCommits(hashes) {
  if (hashes.length === 0) return {};

  const output = runGit(['show', '--no-patch', '--format=%H%x1f%an', ...hashes], REPO_ROOT);
  const authors = {};
  for (const line of output.split('\n').filter(Boolean)) {
    const [hash, author] = line.split(FIELD_SEPARATOR);
    authors[hash] = author;
  }
  return authors;
}

// ═══════════════════════════════════════════════════════════════════════════
// Token: saved in .env
// ═══════════════════════════════════════════════════════════════════════════

// The token line in .env, e.g.  CONFLUENCE_TOKEN=abc123  or  CONFLUENCE_TOKEN="abc123"
// The token itself (without quotes) is captured as group 1.
const TOKEN_LINE = /^\s*CONFLUENCE_TOKEN\s*=\s*['"]?(.*?)['"]?\s*$/;

// Creating .env is how you opt in to saving the token.
function canSaveToken() {
  return fs.existsSync(ENV_FILE);
}

function readEnvFileLines() {
  if (!canSaveToken()) return [];
  return fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
}

// The token saved in .env, or '' if there is none.
function readSavedToken() {
  for (const line of readEnvFileLines()) {
    const match = TOKEN_LINE.exec(line);
    if (match && match[1]) return match[1];
  }
  return '';
}

// Saves the token in .env: replaces the CONFLUENCE_TOKEN line and keeps every other line.
// Returns false if there is no .env (you didn't opt in).
function saveToken(token) {
  if (!canSaveToken()) return false;

  const otherLines = readEnvFileLines().filter(line => !TOKEN_LINE.test(line));
  const otherContent = otherLines.join('\n').trimEnd();
  const newContent = (otherContent ? otherContent + '\n' : '') + `CONFLUENCE_TOKEN=${token}\n`;

  fs.writeFileSync(ENV_FILE, newContent);
  return true;
}

// The token typed in the form, or else the one that's already verified or saved.
function tokenFromForm(body) {
  const token = textValue(body.token) || activeToken;
  if (!token) fail(400, 'Token is required');
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════
// Confluence
// ═══════════════════════════════════════════════════════════════════════════

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
  } catch {
    fail(502, 'Could not reach Confluence');
  }

  const answer = await response.json().catch(() => ({}));
  if (response.ok) return answer;

  if (response.status === 401) fail(401, 'Token rejected by Confluence');
  if (response.status === 403) fail(403, 'Token has no access to this on Confluence');
  // Confluence explains most other problems itself, e.g. "A page with this title already exists".
  const status = response.status >= 400 && response.status < 500 ? response.status : 502;
  fail(status, answer.message || `Confluence responded with HTTP ${response.status}`);
}

// Asks Confluence who the token belongs to. Returns that person's name, or fails.
async function checkTokenWithConfluence(token) {
  const user = await callConfluence(token, 'GET', '/rest/api/user/current');
  // Cloud answers a bad token with an "anonymous" user instead of 401.
  if (user.type === 'anonymous') fail(401, 'Token rejected by Confluence');
  return user.displayName || user.username || 'user';
}

// Creates a page under the parent page, in the parent's space. Returns the new page's address.
async function createConfluencePage(token, { title, parentPageId, content }) {
  let parent;
  try {
    parent = await callConfluence(token, 'GET', `/rest/api/content/${encodeURIComponent(parentPageId)}?expand=space`);
  } catch (error) {
    if (error.status === 404) fail(400, `Parent page ${parentPageId} not found on Confluence`);
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

// ═══════════════════════════════════════════════════════════════════════════
// The release page's content
// ═══════════════════════════════════════════════════════════════════════════
// Confluence pages are written in its "storage format": HTML plus Confluence's own <ac:...> tags
// for things like checkboxes (task lists), info boxes (macros) and column layouts.

// A checkbox people can tick on the page. Confluence numbers each one on the page with a task id.
function checkbox(taskId) {
  return '<ac:task-list><ac:task>'
    + `<ac:task-id>${taskId}</ac:task-id>`
    + '<ac:task-status>incomplete</ac:task-status>'
    + '<ac:task-body>&nbsp;</ac:task-body>'
    + '</ac:task></ac:task-list>';
}

// The table of PRs. Apps that need verification get two extra columns: isVerified (a checkbox) and Note (empty).
function pullRequestTable(pullRequests, withVerification) {
  const headers = ['Author', 'Pull request'];
  if (withVerification) headers.push('isVerified', 'Note');

  const headerRow = '<tr>' + headers.map(header => `<th>${header}</th>`).join('') + '</tr>';

  const rows = pullRequests.map((pullRequest, index) => {
    let cells = `<td>${escapeHtml(pullRequest.author)}</td><td>${escapeHtml(pullRequest.title)}</td>`;
    if (withVerification) {
      cells += `<td>${checkbox(index + 1)}</td><td></td>`;
    }
    return `<tr>${cells}</tr>`;
  });

  return `<table><tbody>${headerRow}${rows.join('')}</tbody></table>`;
}

// The rounded info box shown beside the table, for apps that need verification.
// "info" is Confluence's built-in info panel macro.
function verificationInfoBox() {
  return '<ac:structured-macro ac:name="info">'
    + '<ac:parameter ac:name="title">Verification</ac:parameter>'
    + `<ac:rich-text-body><p>${escapeHtml(config.verificationInfo)}</p></ac:rich-text-body>`
    + '</ac:structured-macro>';
}

// The whole page: a summary line and the PR table.
// Apps that need verification get a two-column layout: the table on the left, the info box on the right.
function releasePageContent({ app, version, date, from, to, pullRequests }) {
  const withVerification = config.appsWithVerification.includes(app);

  const summary = `<p><strong>Version:</strong> ${escapeHtml(version)}`
    + ` · <strong>Release date:</strong> ${escapeHtml(date)}`
    + ` · <strong>Tags:</strong> ${escapeHtml(from)} → ${escapeHtml(to)}`
    + ` · <strong>Pull requests:</strong> ${pullRequests.length}</p>`;
  const table = pullRequestTable(pullRequests, withVerification);

  if (!withVerification) {
    return summary + table;
  }

  // "two_right_sidebar": a wide column on the left and a narrow one on the right.
  return '<ac:layout><ac:layout-section ac:type="two_right_sidebar">'
    + `<ac:layout-cell>${summary}${table}</ac:layout-cell>`
    + `<ac:layout-cell>${verificationInfoBox()}</ac:layout-cell>`
    + '</ac:layout-section></ac:layout>';
}

// Opens the address in this computer's default browser.
function openInBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32';                          // Windows' own "open this address" helper
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';                              // macOS
    args = [url];
  } else {
    command = 'xdg-open';                          // Linux
    args = [url];
  }

  execFile(command, args, error => {
    if (error) console.warn(`[browser] could not open ${url}: ${error.message}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// API: what the form can ask
// ═══════════════════════════════════════════════════════════════════════════

// Whether a token is saved (never the token itself), and whether a typed one can be saved.
function getTokenStatus() {
  return {
    saved: Boolean(readSavedToken()),
    canSave: canSaveToken(),
  };
}

// Checks the typed token, or the saved one when none is typed.
// A working token is kept for creating the page. A typed one is also saved to .env.
async function verifyToken(body) {
  const token = tokenFromForm(body);
  const userName = await checkTokenWithConfluence(token);
  activeToken = token;

  const typedToken = textValue(body.token);
  const saved = typedToken ? saveToken(typedToken) : true;

  return { message: `Authenticated as ${userName}`, saved };
}

// Checks the form, reads the merged PRs, creates the release page and opens it.
async function createReleasePage(body) {
  const token = tokenFromForm(body);

  const { app, from, to } = body;
  const version = textValue(body.version);
  const date = textValue(body.date);

  if (!version || version.length > 50) {
    fail(400, 'Version is required (max 50 characters)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { // YYYY-MM-DD
    fail(400, 'Date must be YYYY-MM-DD');
  }

  const appTags = listTags(app); // also refuses unknown apps
  if (!appTags.includes(from) || !appTags.includes(to)) {
    fail(400, `Pick two tags that belong to ${app}`);
  }

  const parentPageId = config.parentPageIds[app];
  if (!parentPageId) {
    fail(400, `No parent page for ${app} — add it to "parentPageIds" in config.json`);
  }

  const pullRequests = listMergedPullRequests(app, from, to);
  if (pullRequests.length === 0) {
    fail(400, `No merged PRs in ${app} between ${from} and ${to}`);
  }

  const pageUrl = await createConfluencePage(token, {
    title: `Rel of ${app} - ${date}`,
    parentPageId,
    content: releasePageContent({ app, version, date, from, to, pullRequests }),
  });

  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  openInBrowser(pageUrl);
  return { pageUrl, pullRequestCount: pullRequests.length };
}

// Finds what to do for a request, e.g. "GET /api/apps".
async function answerApiRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/api/token') return getTokenStatus();
  if (method === 'POST' && pathname === '/api/verify/token') return verifyToken(body);
  if (method === 'GET' && pathname === '/api/apps') return { apps: listApps() };
  if (method === 'POST' && pathname === '/api/release') return createReleasePage(body);

  // GET /api/apps/<app>/tags  — the app name is captured as group 1.
  const tagsRequest = /^\/api\/apps\/([^/]+)\/tags$/.exec(pathname);
  if (method === 'GET' && tagsRequest) {
    const app = decodeURIComponent(tagsRequest[1]);
    return { tags: listTags(app) };
  }

  fail(404, 'Not found');
}

// Reads the JSON the form sent. At most 100 KB.
async function readJsonBody(request) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.startsWith('application/json')) {
    fail(415, 'Send JSON');
  }

  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 100_000) fail(413, 'Request body too large');
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    fail(400, 'Invalid JSON');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The web server
// ═══════════════════════════════════════════════════════════════════════════

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// The only addresses the page is opened from. Anything else is refused,
// so no other website (and no other host name) can use the saved token.
const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

function isFromOwnPage(request) {
  const { host, origin } = request.headers;
  // Browsers send "origin" when a page calls the server; it must be our own page.
  return OWN_HOSTS.includes(host) && (!origin || origin === `http://${host}`);
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function sendPublicFile(response, fileName) {
  const contentType = CONTENT_TYPES[path.extname(fileName)] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(path.join(PUBLIC_DIR, fileName)).pipe(response);
}

async function handleRequest(request, response) {
  try {
    if (!isFromOwnPage(request)) {
      fail(403, 'Forbidden');
    }

    const { pathname } = new URL(request.url, 'http://localhost');

    // The form page: "/" is index.html, "/style.css" is public/style.css, and so on.
    const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (request.method === 'GET' && PUBLIC_FILES.includes(fileName)) {
      sendPublicFile(response, fileName);
      return;
    }

    // Everything else is the API.
    const body = request.method === 'POST' ? await readJsonBody(request) : {};
    const answer = await answerApiRequest(request.method, pathname, body);
    sendJson(response, 200, { ok: true, ...answer });
  } catch (error) {
    // Our own errors (from fail) have a status. A URIError is a broken %-escape in the address.
    const status = error.status || (error instanceof URIError ? 400 : 500);
    if (status >= 500) console.error('[server]', error.message);

    // Unexpected errors may contain internals, so the form only gets "Server error".
    const message = error.status || status === 400 ? error.message : 'Server error';
    sendJson(response, status, { ok: false, message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════

// A token saved in .env is ready from the start.
activeToken = readSavedToken();

// 127.0.0.1: only this computer can reach the server.
http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
