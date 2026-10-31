// Release page creator: creates the Confluence release page for one app in the monorepo.
//
// Everything is in this one file. Put it anywhere in the monorepo, then run:
//
//   node release-page.ts
//
// and open http://localhost:3000/. Needs Node.js 22.18+ (or 23.6+) and git. Nothing to install:
// Node runs this TypeScript as it is, and only Node's built-in modules are used.
//
// The Confluence token goes in a .env file next to this file:  CONFLUENCE_TOKEN=<your token>
// Make sure .env is in .gitignore, so the token is never committed. The server warns when it isn't.
//
// What happens:
//   1. The server serves the form page (HTML, CSS and the browser scripts are all at the bottom of this file).
//   2. It answers the form's questions: which apps exist, which tags they have, is there a working token.
//   3. It creates the release page in Confluence:
//        - reads the "Merged PR" commits of the app between the two tags,
//        - builds a table of them (author + PR title, plus empty isVerified and Note columns for some apps),
//        - creates the page under the app's parent page,
//        - opens the new page in the browser.
//
// The API:
//   GET  /api/token            is there a working token in .env?
//   GET  /api/apps             the app names
//   GET  /api/tags?app=web-app the app's OLD / NEW tags
//   POST /api/release          create the release page
//
// Every answer to the form is JSON: { ok: true, ... } or { ok: false, message: "what went wrong" }.
//
// The file, from top to bottom:
//   SETTINGS        what to change for your monorepo
//   HELPERS         fail() and other small helpers
//   GIT             apps, tags and merged PRs
//   TOKEN           the Confluence token from .env
//   CONFLUENCE      Confluence's REST API: checking the token, creating a page
//   PAGE CONTENT    the release page's table and info box
//   BROWSER         opening the new page in the browser
//   WEB             who may call the server, reading requests, sending answers
//   API             what each API path does
//   SERVER          handleRequest() picks one by its path
//   THE FORM PAGE   HTML, CSS and the browser scripts
//   START

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS — change these for your monorepo. A change needs a restart.
// ═══════════════════════════════════════════════════════════════════════════

const config = {
  // Port the server listens on. The PORT environment variable overrides it.
  port: 3000,

  // Which top-level folders of the monorepo are apps. * matches anything:
  // "*-app" matches "web-app" and "admin-app", but not "docs" or "app-web".
  appPattern: '*-app',

  // Monorepo root, relative to the folder this file is in. Empty means "the git repo this file is in".
  repoRoot: '',

  // Confluence's address. Use https://, so the token is encrypted on its way.
  // Cloud: https://<site>.atlassian.net/wiki
  confluenceBaseUrl: 'https://confluence.example.com',

  // Empty for Data Center (the token is sent as "Bearer").
  // For Cloud, the Atlassian account email that owns the API token.
  confluenceEmail: '',

  // For each app, the ID of the Confluence page its release pages are created under.
  // The ID is in the page's address (…pageId=123456) or under ••• → Page information.
  parentPageIds: {
    'a-app': '100001',
    'b-app': '100002',
  } as Record<string, string>,

  // Apps whose page gets the isVerified and Note columns and the info box.
  appsWithVerification: ['a-app', 'b-app'],

  // The text in the info box.
  verificationInfo: 'This app needs every PR verified before the release. Tick isVerified once a PR is tested, and add a Note if something needs attention.',
};

// The folder this file is in.
const TOOL_DIR = import.meta.dirname;

// Where the settings are, for error messages, e.g. "the settings at the top of release-page.ts".
const SETTINGS = `the settings at the top of ${path.basename(import.meta.filename)}`;

// The PORT environment variable wins over the settings.
const PORT = Number(process.env.PORT) || config.port;

// The file the Confluence token is read from. Keep it in .gitignore, so the token is never committed.
const ENV_FILE = path.join(TOOL_DIR, '.env');

// Confluence's address, without a trailing slash.
const CONFLUENCE_URL = config.confluenceBaseUrl.replace(/\/+$/, '');

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// An error the form should see: { ok: false, message } with this HTTP status.
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Stops the current request with an error. The form gets { ok: false, message } with this HTTP status.
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

// A form value as trimmed text, or '' if it isn't text at all.
function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Makes text safe to put inside a regular expression, e.g. "web.app" matches only "web.app", not "webXapp".
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Makes text safe to put inside the page's HTML, e.g. a PR title "Fix <input> & more".
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════
// GIT — the apps (top-level folders), their release tags, and the PRs merged between two tags
// ═══════════════════════════════════════════════════════════════════════════

// One merged PR on the release page.
interface PullRequest {
  title: string;
  author: string;
}

// Runs a git command in the given folder and returns what it printed.
function runGit(args: string[], folder: string): string {
  try {
    return execFileSync('git', args, {
      cwd: folder,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === 'ENOENT') {
      fail(500, 'Git isn\'t installed, or isn\'t on the PATH. Install git and restart the server.');
    }
    const firstErrorLine = String(error.stderr || error.message).trim().split('\n')[0];
    fail(500, `"git ${args[0]}" failed in ${folder}: ${firstErrorLine}`);
  }
}

// The monorepo root: from the settings (relative to this file's folder), or else the git repo this file is in.
const REPO_ROOT = config.repoRoot
  ? path.resolve(TOOL_DIR, config.repoRoot)
  : runGit(['rev-parse', '--show-toplevel'], TOOL_DIR).trim();

// The top-level folder this file is in, e.g. "tools". It's never listed as an app.
// '' when this file is in the monorepo root itself.
const OWN_FOLDER = path.relative(REPO_ROOT, TOOL_DIR).split(path.sep)[0];

// appPattern as a regular expression. Only * is special and means "anything":
//   "*-app"  →  /^.*-app$/   matches "web-app" and "admin-app", but not "docs"
const APP_NAME_PATTERN = new RegExp(
  '^' + config.appPattern.split('*').map(escapeForRegExp).join('.*') + '$'
);

// The app names: top-level folders of the monorepo that match appPattern.
// Only matters for broad patterns like "*": hidden folders, node_modules and this file's own folder are left out.
function listApps(): string[] {
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
function listTags(app: string): string[] {
  if (!listApps().includes(app)) {
    fail(404, `Unknown app "${app}"`);
  }

  // <app>-<number>-OLD or <app>-<number>-NEW. The number is captured as group 1.
  const tagPattern = new RegExp(`^${escapeForRegExp(app)}-(\\d+)-(OLD|NEW)$`);
  const tagNumber = (tag: string) => Number(tagPattern.exec(tag)![1]); // only called on tags that match

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
function listMergedPullRequests(app: string, fromTag: string, toTag: string): PullRequest[] {
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
      prBranchTip: parents.split(' ')[1] as string | undefined,
      mergedBy,
      // "Merged PR 1234: Add keyboard navigation" → "Add keyboard navigation"
      title: subject.replace(/^Merged PR \d+:\s*/, ''),
    };
  });

  const authors = authorsOfCommits(commits.map(commit => commit.prBranchTip).filter(hash => hash !== undefined));

  // The person who opened the PR: the author of the PR branch's last commit.
  // For a squashed PR there's no branch left, so it's the author of the squashed commit.
  return commits.map(commit => ({
    title: commit.title,
    author: (commit.prBranchTip && authors[commit.prBranchTip]) || commit.mergedBy,
  }));
}

// The author of each commit, in one git call: { '<hash>': 'Alice', ... }
function authorsOfCommits(hashes: string[]): Record<string, string> {
  if (hashes.length === 0) return {};

  const output = runGit(['show', '--no-patch', '--format=%H%x1f%an', ...hashes], REPO_ROOT);
  const authors: Record<string, string> = {};
  for (const line of output.split('\n').filter(Boolean)) {
    const [hash, author] = line.split(FIELD_SEPARATOR);
    authors[hash] = author;
  }
  return authors;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN — read from .env next to this file:  CONFLUENCE_TOKEN=<your token>
// ═══════════════════════════════════════════════════════════════════════════

// The token line in .env, e.g.  CONFLUENCE_TOKEN=abc123  or  CONFLUENCE_TOKEN="abc123"
// The token itself (without quotes) is captured as group 1.
const TOKEN_LINE = /^\s*CONFLUENCE_TOKEN\s*=\s*['"]?(.*?)['"]?\s*$/;

// The token from .env, or '' if the file or the line is missing.
// Read every time, so adding the token works without restarting the server.
function readToken(): string {
  if (!fs.existsSync(ENV_FILE)) return '';

  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = TOKEN_LINE.exec(line);
    if (match && match[1]) return match[1];
  }
  return '';
}

// The token from .env, or fails with a message that says how to add it.
function requireToken(): string {
  const token = readToken();
  if (!token) {
    fail(400, `No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to ${ENV_FILE}`);
  }
  return token;
}

// Whether git would commit .env. Checked once at start, so a token is never committed by accident.
function envFileIsGitIgnored(): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', ENV_FILE], { cwd: TOOL_DIR, stdio: 'ignore' });
    return true;
  } catch {
    return false; // exit code 1: not ignored (or git can't tell)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFLUENCE — its REST API: checking the token and creating a page
// ═══════════════════════════════════════════════════════════════════════════

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

interface NewPage {
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

// Why Confluence couldn't be reached at all, in words someone can act on.
// error.cause.code is Node's reason, e.g. ENOTFOUND (no such address) or SELF_SIGNED_CERT_IN_CHAIN.
function cannotReachConfluence(caught: unknown): string {
  const error = caught as Error & { cause?: { code?: string } };
  const reason = error.cause?.code || error.name;
  const where = `Confluence at ${CONFLUENCE_URL}`;
  const checkUrl = `Check confluenceBaseUrl in ${SETTINGS}`;

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
function tokenRejectedMessage(): string {
  return `Confluence rejected the token in ${ENV_FILE}. It's wrong or expired: create a new one in Confluence `
    + '(profile picture → Settings → Personal Access Tokens) and replace it.';
}

// Calls Confluence's REST API and returns its JSON answer, or fails with a readable message.
//   method:  'GET' or 'POST'
//   apiPath: e.g. '/rest/api/user/current'
//   body:    sent as JSON (POST only)
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
      redirect: 'manual',                  // a redirect means a login page, not an answer
      signal: AbortSignal.timeout(30_000), // give up after 30 seconds
    });
  } catch (error) {
    fail(502, cannotReachConfluence(error));
  }

  const answer: unknown = await response.json().catch(() => ({}));
  if (response.ok) return answer as Answer;

  const status = response.status;
  const { message } = answer as { message?: string };
  const checkUrl = `Check confluenceBaseUrl in ${SETTINGS} (for Confluence Cloud it ends in /wiki).`;

  if (status === 401) {
    fail(401, tokenRejectedMessage());
  }
  if (status === 403) {
    fail(403, 'Your Confluence account isn\'t allowed to do this' + (message ? `: ${message}` : '.')
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
  fail(status, message
    ? `Confluence said: ${message}`
    : `Confluence refused the request (HTTP ${status}) without saying why.`);
}

// Asks Confluence who the token belongs to. Returns that person's name, or fails.
async function checkTokenWithConfluence(token: string): Promise<string> {
  const user = await callConfluence<ConfluenceUser>(token, 'GET', '/rest/api/user/current');
  // Cloud answers a bad token with an "anonymous" user instead of 401.
  if (user.type === 'anonymous') fail(401, tokenRejectedMessage());
  return user.displayName || user.username || 'user';
}

// Creates a page under the parent page, in the parent's space. Returns the new page's address.
async function createConfluencePage(token: string, { title, parentPageId, content }: NewPage): Promise<string> {
  let parent: ConfluencePage;
  try {
    parent = await callConfluence<ConfluencePage>(token, 'GET', `/rest/api/content/${encodeURIComponent(parentPageId)}?expand=space`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      fail(400, `There's no Confluence page with ID ${parentPageId}, or your account can't see it. `
        + `Check parentPageIds in ${SETTINGS}: the ID is in the page's address (…pageId=123456).`);
    }
    throw error;
  }

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

// ═══════════════════════════════════════════════════════════════════════════
// PAGE CONTENT — the release page in Confluence's "storage format":
// HTML plus Confluence's own <ac:...> tags for things like info boxes (macros) and column layouts.
// ═══════════════════════════════════════════════════════════════════════════

interface Release {
  app: string;
  version: string;
  date: string;
  from: string;
  to: string;
  pullRequests: PullRequest[];
}

// The table of PRs. Apps that need verification get two extra, empty columns for people to fill in: isVerified and Note.
function pullRequestTable(pullRequests: PullRequest[], withVerification: boolean): string {
  const headers = ['Author', 'Pull request'];
  if (withVerification) headers.push('isVerified', 'Note');

  const headerRow = '<tr>' + headers.map(header => `<th>${header}</th>`).join('') + '</tr>';

  const rows = pullRequests.map(pullRequest => {
    let cells = `<td>${escapeHtml(pullRequest.author)}</td><td>${escapeHtml(pullRequest.title)}</td>`;
    if (withVerification) {
      cells += '<td></td><td></td>';
    }
    return `<tr>${cells}</tr>`;
  });

  return `<table><tbody>${headerRow}${rows.join('')}</tbody></table>`;
}

// The rounded info box shown beside the table, for apps that need verification.
// "info" is Confluence's built-in info panel macro.
function verificationInfoBox(): string {
  return '<ac:structured-macro ac:name="info">'
    + '<ac:parameter ac:name="title">Verification</ac:parameter>'
    + `<ac:rich-text-body><p>${escapeHtml(config.verificationInfo)}</p></ac:rich-text-body>`
    + '</ac:structured-macro>';
}

// The whole page: a summary line and the PR table.
// Apps that need verification get a two-column layout: the table on the left, the info box on the right.
function releasePageContent({ app, version, date, from, to, pullRequests }: Release): string {
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

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER — opens an address in this computer's default browser
// ═══════════════════════════════════════════════════════════════════════════

function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
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
// WEB — who may call the server, reading what the form sent, and sending answers back
// ═══════════════════════════════════════════════════════════════════════════

// The only addresses the page is opened from. Anything else is refused,
// so no other website (and no other host name) can use the token in .env.
const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

function isFromOwnPage(request: http.IncomingMessage): boolean {
  const { host, origin } = request.headers;
  // Browsers send "origin" when a page calls the server; it must be our own page.
  return host !== undefined && OWN_HOSTS.includes(host) && (!origin || origin === `http://${host}`);
}

function sendJson(response: http.ServerResponse, status: number, data: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// Reads the JSON object the form sent. At most 100 KB.
async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.startsWith('application/json')) {
    fail(415, 'Requests to the release server must be sent as JSON.');
  }

  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 100_000) fail(413, 'The request is too large (over 100 KB).');
  }

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    fail(400, 'The request isn\'t valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(400, 'The request must be a JSON object, e.g. { "app": "web-app", ... }.');
  }
  return body as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/token
// Is there a working token in .env? Never sends the token itself.
async function checkToken(): Promise<{ message: string }> {
  const token = requireToken();
  const userName = await checkTokenWithConfluence(token);
  return { message: `Authenticated as ${userName}` };
}

// POST /api/release
// Body: { app, from, to, version, date }
// Checks the form, reads the merged PRs, creates the release page and opens it.
async function createRelease(body: Record<string, unknown>): Promise<{ pageUrl: string; pullRequestCount: number }> {
  const token = requireToken();

  // 1. Check what the form sent.
  const app = textValue(body.app);
  const from = textValue(body.from);
  const to = textValue(body.to);
  const version = textValue(body.version);
  const date = textValue(body.date);

  if (!version || version.length > 50) {
    fail(400, 'Enter a version, e.g. 1.4.0 (at most 50 characters).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { // YYYY-MM-DD
    fail(400, 'Enter the release date as YYYY-MM-DD, e.g. 2026-10-30.');
  }

  const appTags = listTags(app); // also refuses unknown apps
  if (!appTags.includes(from) || !appTags.includes(to)) {
    fail(400, `"${from}" and "${to}" aren't both tags of ${app}. Pick the app again to reload its tags.`);
  }

  const parentPageId = config.parentPageIds[app];
  if (!parentPageId) {
    fail(400, `${app} has no parent page yet. Add '${app}': '<page ID>' to parentPageIds in ${SETTINGS}.`);
  }

  // 2. Read the merged PRs between the two tags.
  const pullRequests = listMergedPullRequests(app, from, to);
  if (pullRequests.length === 0) {
    fail(400, `No merged PRs in ${app} between ${from} and ${to}: no commit there has "Merged PR" in its message `
      + `and changes the ${app} folder. Check that "From tag" is the older tag and "To tag" the newer one.`);
  }

  // 3. Create the page in Confluence.
  const pageUrl = await createConfluencePage(token, {
    title: `Rel of ${app} - ${date}`,
    parentPageId,
    content: releasePageContent({ app, version, date, from, to, pullRequests }),
  });

  // 4. Open it.
  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  openInBrowser(pageUrl);
  return { pageUrl, pullRequestCount: pullRequests.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER — every request goes through here
// ═══════════════════════════════════════════════════════════════════════════

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    // Only this computer's own page may use the server.
    if (!isFromOwnPage(request)) {
      fail(403, `This server only answers its own page. Open it as http://localhost:${PORT}/ or http://127.0.0.1:${PORT}/.`);
    }

    const method = request.method ?? 'GET';
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');

    // The form page, with its styles and scripts inside.
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(FORM_PAGE);
      return;
    }

    // Everything else is the API.
    let answer: object;
    if (method === 'GET' && pathname === '/api/token') {
      answer = await checkToken();
    } else if (method === 'GET' && pathname === '/api/apps') {
      answer = { apps: listApps() };
    } else if (method === 'GET' && pathname === '/api/tags') {
      answer = { tags: listTags(searchParams.get('app') ?? '') };
    } else if (method === 'POST' && pathname === '/api/release') {
      answer = await createRelease(await readJsonBody(request));
    } else {
      fail(404, `The release server has no "${method} ${pathname}".`);
    }

    sendJson(response, 200, { ok: true, ...answer });
  } catch (error) {
    // Our own errors (from fail) have a status. Anything else is unexpected.
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('[server]', error instanceof Error ? error.message : error);

    // Unexpected errors may contain internals, so the form only gets a pointer to the terminal.
    const message = error instanceof HttpError
      ? error.message
      : 'Something went wrong in the release server. The terminal it runs in shows the details.';
    sendJson(response, status, { ok: false, message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE FORM PAGE — served at http://localhost:3000/, with its styles and scripts inside
//
// The browser scripts are written as functions here, so they're checked as TypeScript too. They never run
// in Node: the page gets their source, String(formScript), which Node has already stripped of types.
// So they may only use what's inside them and the browser's own globals, nothing else from this file.
// ═══════════════════════════════════════════════════════════════════════════

// The form: checks each field, loads apps and tags, and creates the release page.
function formScript(): void {
  // The element with this id. Pass the element type when it matters, e.g. $<HTMLInputElement>('version').
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

  // What to do when the page can't talk to the release server.
  const START_SERVER = 'Start the server with "node release-page.ts", then open the address it prints (http://localhost:3000/).';

  // An error from api(). notConnected is set when the page can't talk to the release server at all,
  // so the fields can show a short note instead of repeating the whole message.
  type ApiError = Error & { notConnected?: boolean };

  function notConnectedError(message: string): ApiError {
    return Object.assign(new Error(message + ' ' + START_SERVER), { notConnected: true });
  }

  // What the release server answers. Every answer has "ok"; a failed one has a "message".
  interface TokenAnswer { message: string }
  interface AppsAnswer { apps: string[] }
  interface TagsAnswer { tags: string[] }
  interface ReleaseAnswer { pageUrl: string; pullRequestCount: number }

  // What the form sends to POST /api/release.
  interface ReleaseRequest { app: string; version: string; date: string; from: string; to: string }

  // Calls the release server. GET without a body, POST with one.
  // Returns the JSON answer, or throws an Error with a message a person can act on.
  async function api<Answer>(url: string, body?: object, signal?: AbortSignal): Promise<Answer> {
    const options: RequestInit = body === undefined ? { signal } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    };

    if (location.protocol === 'file:') {
      throw notConnectedError('This page was opened as a file, so it can\'t reach the release server.');
    }

    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw notConnectedError(`Can't reach the release server at ${location.origin}: it isn't running.`);
    }

    // The release server always answers JSON with "ok". Anything else means this page was opened
    // from a different server, e.g. VS Code's Live Server, which doesn't know the release server's API.
    const data = await res.json().catch(() => null);
    if (!data || typeof data.ok !== 'boolean') {
      throw notConnectedError(`This page isn't connected to the release server: ${location.host} answered "${url}" with HTTP ${res.status}.`);
    }
    if (!data.ok) {
      throw new Error(data.message || `The release server answered HTTP ${res.status} without saying why. Its terminal may show more.`);
    }
    return data as Answer;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     FIELD STATES
     Plain fields: is-valid (green check) or has-error (red message).
  ═══════════════════════════════════════════════════════════════════════════ */

  // A field with a value keeps its label floated above it.
  function setFilled(input: HTMLInputElement | HTMLSelectElement) {
    input.closest('.field')?.classList.toggle('filled', input.value.trim() !== '');
  }
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(input => {
    input.addEventListener('input', () => setFilled(input));
    input.addEventListener('change', () => setFilled(input));
  });

  function showValid(id: string) {
    $('f-' + id).classList.remove('has-error');
    $('f-' + id).classList.add('is-valid');
    $('e-' + id).textContent = '';
  }

  function showError(id: string, message: string) {
    $('f-' + id).classList.remove('is-valid');
    $('f-' + id).classList.add('has-error');
    $('e-' + id).textContent = message;
  }

  function showNeutral(id: string) {
    $('f-' + id).classList.remove('has-error', 'is-valid');
    $('e-' + id).textContent = '';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     VERSION
  ═══════════════════════════════════════════════════════════════════════════ */
  const versionInput = $<HTMLInputElement>('version');

  function checkVersion() {
    const ok = versionInput.value.trim() !== '';
    if (ok) showValid('version');
    else showError('version', 'Version is required');
    return ok;
  }

  versionInput.addEventListener('blur', checkVersion);
  versionInput.addEventListener('input', () => {
    if ($('f-version').classList.contains('has-error')) checkVersion();
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     DATE — typed as YYYY-MM-DD (dashes added for you) or picked in the calendar
  ═══════════════════════════════════════════════════════════════════════════ */
  const dateInput = $<HTMLInputElement>('eventdate');

  (function dateField() {
    const input = dateInput, popup = $('cal-pop'), button = $('date-btn');
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
    const today = new Date();
    let shown = { year: today.getFullYear(), month: today.getMonth() }; // month the calendar shows

    const isoDate = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const ISO = /^\d{4}-\d{2}-\d{2}$/;

    function checkDate() {
      const value = input.value.trim();
      if (!value) return showNeutral('eventdate');
      if (!ISO.test(value)) return showError('eventdate', 'Format must be YYYY-MM-DD');
      const [y, m, d] = value.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const real = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
      if (!real || y < 1900 || y > 2100) return showError('eventdate', 'Please enter a valid date');
      showValid('eventdate');
    }

    // Typing "20261014" becomes "2026-10-14".
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 8);
      const masked = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6)].filter(Boolean).join('-');
      if (input.value !== masked) {
        input.value = masked;
        input.setSelectionRange(masked.length, masked.length);
      }
      if (masked.length < 10) showNeutral('eventdate');
      else checkDate();
    });
    input.addEventListener('blur', () => { if (input.value.trim()) checkDate(); });

    // One day button. `month` may be -1 or 12: Date rolls it into the next or previous year.
    function dayButton(year: number, month: number, day: number, otherMonth: boolean) {
      const date = new Date(year, month, day);
      const value = isoDate(date.getFullYear(), date.getMonth(), date.getDate());
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cal-day';
      button.textContent = String(date.getDate());
      if (otherMonth) button.classList.add('dim');
      if (value === isoDate(today.getFullYear(), today.getMonth(), today.getDate())) button.classList.add('today');
      if (value === input.value.trim()) button.classList.add('sel');
      button.addEventListener('click', () => {
        input.value = value;
        setFilled(input);
        checkDate();
        closeCalendar();
        input.focus();
      });
      return button;
    }

    // Weeks start on Monday. Days from the months around fill the first and last week.
    function render() {
      const { year, month } = shown;
      $('cal-lbl').textContent = `${MONTHS[month]} ${year}`;
      const leading = (new Date(year, month, 1).getDay() + 6) % 7;
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const daysInPrevious = new Date(year, month, 0).getDate();
      const trailing = (7 - (leading + daysInMonth) % 7) % 7;

      const buttons: HTMLButtonElement[] = [];
      for (let i = leading - 1; i >= 0; i--) buttons.push(dayButton(year, month - 1, daysInPrevious - i, true));
      for (let d = 1; d <= daysInMonth; d++) buttons.push(dayButton(year, month, d, false));
      for (let d = 1; d <= trailing; d++) buttons.push(dayButton(year, month + 1, d, true));
      $('cal-days').replaceChildren(...buttons);
    }

    function showMonth(year: number, month: number) {
      shown = { year: year + Math.floor(month / 12), month: (month + 12) % 12 };
      render();
    }

    function openCalendar() {
      if (ISO.test(input.value)) {
        const [y, m] = input.value.split('-').map(Number);
        shown = { year: y, month: m - 1 };
      } else {
        shown = { year: today.getFullYear(), month: today.getMonth() };
      }
      render();
      popup.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    }

    function closeCalendar() {
      popup.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }

    const onClick = (id: string, action: (event: MouseEvent) => void) =>
      $(id).addEventListener('click', event => { event.preventDefault(); action(event); });
    onClick('date-btn', event => { event.stopPropagation(); popup.hidden ? openCalendar() : closeCalendar(); });
    onClick('cal-prev', () => showMonth(shown.year, shown.month - 1));
    onClick('cal-next', () => showMonth(shown.year, shown.month + 1));
    onClick('cal-lbl', () => showMonth(today.getFullYear(), today.getMonth()));
    onClick('cal-today', () => showMonth(today.getFullYear(), today.getMonth()));
    document.addEventListener('click', event => { if (!$('f-eventdate').contains(event.target as Node)) closeCalendar(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCalendar(); });
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     TOKEN — read by the server from .env next to release-page.ts
     The page never sees the token. It only shows whether the server found one that works.
  ═══════════════════════════════════════════════════════════════════════════ */
  let tokenWorks = false;

  // Shows the token status line: a green dot when the token works, a red one with the reason when not.
  function showTokenStatus(works: boolean, text: string) {
    tokenWorks = works;
    $('token-status').classList.remove('checking');
    $('token-status').classList.toggle('bad', !works);
    $('token-status-text').textContent = text;
    $('token-recheck').hidden = works;
  }

  async function checkToken() {
    $('token-status').classList.add('checking');
    $('token-status-text').textContent = 'Checking the Confluence token…';
    try {
      const result = await api<TokenAnswer>('/api/token');
      showTokenStatus(true, 'Confluence token found in .env · ' + result.message);
    } catch (err) {
      // e.g. "No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to C:\monorepo\tools\.env"
      showTokenStatus(false, (err as ApiError).message);
    }
  }

  // After adding the token to .env, "Check again" picks it up. No restart needed.
  $('token-recheck').addEventListener('click', checkToken);
  checkToken();

  /* ═══════════════════════════════════════════════════════════════════════════
     APP → TAGS
  ═══════════════════════════════════════════════════════════════════════════ */
  const appSelect = $<HTMLSelectElement>('app'), fromSelect = $<HTMLSelectElement>('tagfrom'), toSelect = $<HTMLSelectElement>('tagto');

  function fillSelect(select: HTMLSelectElement, values: string[], placeholder: string) {
    select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));
  }

  async function loadApps() {
    try {
      const { apps } = await api<AppsAnswer>('/api/apps');
      fillSelect(appSelect, apps, apps.length ? '— Select app —' : 'No apps found');
    } catch (err) {
      const error = err as ApiError;
      fillSelect(appSelect, [], 'Could not load apps');
      // The token line above already explains a missing connection in full.
      showError('app', error.notConnected ? 'Could not load the apps: the page isn\'t connected to the release server (see above).' : error.message);
    }
  }

  async function loadTags(app: string) {
    for (const select of [fromSelect, toSelect]) {
      select.disabled = true;
      fillSelect(select, [], app ? 'Loading tags…' : 'Select an app first');
    }
    if (!app) return;
    try {
      const { tags } = await api<TagsAnswer>(`/api/tags?app=${encodeURIComponent(app)}`);
      if (!tags.length) return showError('app', `No ${app}-<n>-OLD / -NEW tags found`);
      showValid('app');
      // Tags come highest number first, so the newest OLD/NEW pair is picked by default.
      const olds = tags.filter(tag => tag.endsWith('-OLD'));
      const news = tags.filter(tag => tag.endsWith('-NEW'));
      fillSelect(fromSelect, olds, '— Select —');
      fillSelect(toSelect, news, '— Select —');
      fromSelect.value = olds[0] || '';
      toSelect.value = news[0] || '';
      fromSelect.disabled = toSelect.disabled = false;
    } catch (err) {
      showError('app', (err as ApiError).message);
    }
  }

  appSelect.addEventListener('change', () => loadTags(appSelect.value));
  loadApps();

  /* ═══════════════════════════════════════════════════════════════════════════
     CREATE PAGE — the server creates the Confluence page from these values
  ═══════════════════════════════════════════════════════════════════════════ */

  // Marks every missing or unchecked field. True when everything is ready.
  function checkAll() {
    let ok = checkVersion();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value.trim())) {
      showError('eventdate', 'Date is required (YYYY-MM-DD)');
      ok = false;
    }
    const selects: [HTMLSelectElement, string][] = [
      [appSelect, 'Select an app'], [fromSelect, 'Select the OLD tag'], [toSelect, 'Select the NEW tag'],
    ];
    for (const [select, message] of selects) {
      if (!select.value) { showError(select.id, message); ok = false; }
    }
    if (!tokenWorks) {
      $('token-status').classList.add('shake');
      setTimeout(() => $('token-status').classList.remove('shake'), 450);
      ok = false;
    }
    return ok;
  }

  $<HTMLFormElement>('mainForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!checkAll()) return;

    const release: ReleaseRequest = {
      app: appSelect.value,
      version: versionInput.value.trim(),
      date: dateInput.value.trim(),
      from: fromSelect.value,
      to: toSelect.value,
    };
    const button = $<HTMLButtonElement>('submitBtn'), status = $('statusMsg');
    button.disabled = true;
    button.classList.add('loading');
    status.textContent = 'Creating the release page…';
    status.className = 'status-msg';

    try {
      // The server also opens the new page in the browser; this link is in case that didn't work.
      const { pageUrl, pullRequestCount } = await api<ReleaseAnswer>('/api/release', release);
      const link = Object.assign(document.createElement('a'), {
        href: pageUrl, target: '_blank', rel: 'noopener', textContent: 'open in Confluence',
      });
      status.replaceChildren(`Release page created with ${pullRequestCount} PRs — `, link);
      status.classList.add('ok');
    } catch (err) {
      status.textContent = (err as ApiError).message;
      status.classList.add('err');
    } finally {
      button.disabled = false;
      button.classList.remove('loading');
    }
  });
}

// The page's animations, in the order they play:
//   1. Hyperspeed intro — stars rush out from the centre, then the overlay fades away
//   2. Heading — letters rise in one by one, then slide into place; the text below fades in
//   3. Sith figure — transforms (CSS), grows a lightsaber, then flashes lightning forever
function effectsScript(): void {
  /* ═══════════════════════════════════════════════════════════════════════════
     1. HYPERSPEED INTRO
     Speeds up (accel), holds, flashes red, slows down (decel), then fades out
     and fires the "intro-done" event.
  ═══════════════════════════════════════════════════════════════════════════ */
  (function hyperspeedIntro() {
    const overlay = document.getElementById('intro') as HTMLElement;
    const canvas = document.getElementById('introCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

    const STAR_COUNT = 380;
    const MAX_SPEED = 38;
    const ACCEL_RATE = 1.062;          // speed is multiplied by this every frame while speeding up
    const ACCEL_MS = 1400, HOLD_MS = 300, DECEL_MS = 420, FADE_MS = 750;
    const COLORS = ['#ffffff', '#ffffff', '#ffcccc', '#FF4444', '#CC0011', '#FF1A2E', '#FF6633', '#AA0008'];

    interface Star {
      x: number; y: number;
      prevX: number; prevY: number;
      angle: number;
      speed: number;
      width: number;
      color: string;
    }

    let width = 0, height = 0, centerX = 0, centerY = 0;
    let speed = 0.8;
    let phase: 'accel' | 'hold' | 'decel' = 'accel';
    let flashAlpha = 0;
    let flashed = false;
    let startTime = 0, frameId = 0;

    function resize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      centerX = width / 2;
      centerY = height / 2;
    }

    const random = (min: number, max: number) => min + Math.random() * (max - min);

    // A star moving straight out from the centre. New stars start near the centre.
    function makeStar(nearCenter: boolean): Star {
      const angle = Math.random() * Math.PI * 2;
      const distance = nearCenter ? Math.random() * 6 : Math.random() * Math.min(width, height) * 0.5;
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;
      return {
        x, y,
        prevX: x, prevY: y,
        angle,
        speed: nearCenter ? speed * random(0.2, 0.8) : speed * random(0.5, 1.5),
        width: random(0.35, 1.45),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      };
    }

    resize();
    const stars = Array.from({ length: STAR_COUNT }, (_, i) => makeStar(i < STAR_COUNT * 0.55));

    // A red glow in the centre that grows with the speed.
    function drawGlow() {
      const strength = Math.min(1, speed / MAX_SPEED);
      if (strength < 0.05) return;
      const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 20 + strength * 260);
      glow.addColorStop(0, `rgba(255,20,40,${strength * 0.65})`);
      glow.addColorStop(0.35, `rgba(192,0,20,${strength * 0.4})`);
      glow.addColorStop(0.7, `rgba(120,0,10,${strength * 0.2})`);
      glow.addColorStop(1, 'transparent');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    // The red flash at top speed, fading a little every frame.
    function drawFlash() {
      if (flashAlpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = flashAlpha;
      ctx.fillStyle = '#CC0011';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    function moveStar(star: Star) {
      star.prevX = star.x;
      star.prevY = star.y;
      if (phase === 'accel') star.speed = Math.min(star.speed * ACCEL_RATE, MAX_SPEED * 2.8);
      else if (phase === 'decel') star.speed = Math.max(star.speed * 0.88, 0.3);
      star.x += Math.cos(star.angle) * star.speed;
      star.y += Math.sin(star.angle) * star.speed;

      // Off screen: start again near the centre.
      if (star.x < -60 || star.x > width + 60 || star.y < -60 || star.y > height + 60) {
        Object.assign(star, makeStar(true), { speed: speed * (phase === 'decel' ? 0.15 : 0.25) });
        return;
      }

      // A streak from where it was to where it is: faster = brighter and thicker.
      ctx.beginPath();
      ctx.strokeStyle = star.color;
      ctx.lineWidth = star.width * Math.max(1, star.speed / 12);
      ctx.globalAlpha = Math.min(0.95, star.speed / 9);
      ctx.moveTo(star.prevX, star.prevY);
      ctx.lineTo(star.x, star.y);
      ctx.stroke();
    }

    function frame(now: number) {
      const elapsed = now - startTime;
      if (phase === 'accel' && elapsed >= ACCEL_MS) phase = 'hold';
      if (phase === 'hold' && elapsed >= ACCEL_MS + HOLD_MS) {
        phase = 'decel';
        if (!flashed) { flashed = true; flashAlpha = 0.55; }
      }
      if (phase === 'decel' && elapsed >= ACCEL_MS + HOLD_MS + DECEL_MS) {
        overlay.classList.add('fading');
        setTimeout(() => {
          overlay.style.display = 'none';
          window.dispatchEvent(new Event('intro-done'));
        }, FADE_MS);
        cancelAnimationFrame(frameId);
        return;
      }

      if (phase === 'accel') speed = Math.min(speed * ACCEL_RATE, MAX_SPEED);
      else if (phase === 'decel') speed = Math.max(speed * 0.9, 0.5);
      flashAlpha = Math.max(0, flashAlpha - 0.04);

      // A see-through black fill leaves the trails behind the stars.
      ctx.fillStyle = phase === 'decel' ? 'rgba(0,0,0,0.48)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(0, 0, width, height);
      stars.forEach(moveStar);
      ctx.globalAlpha = 1;
      drawGlow();
      drawFlash();
      frameId = requestAnimationFrame(frame);
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    startTime = performance.now();
    frameId = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     2. HEADING — starts when the intro is done
  ═══════════════════════════════════════════════════════════════════════════ */
  (function heading() {
    const RISE = { stagger: 52, duration: 580 };  // each letter starts 52 ms after the previous one
    const SLIDE = { stagger: 16, duration: 460 };
    const PAUSE = 52;                             // between rising and sliding

    // Splits the text into letters; they rise in one by one, then the line slides into place.
    function animateLine(line: HTMLElement, text: string) {
      const letters = [...text].map(char => {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = char;
        return span;
      });
      line.append(...letters);
      type Timing = { stagger: number; duration: number };
      const totalTime = ({ stagger, duration }: Timing) => (letters.length - 1) * stagger + duration;
      const play = (className: string, { stagger }: Timing) => letters.forEach((span, i) => {
        span.style.animationDelay = `${i * stagger}ms`;
        span.classList.add(className);
      });

      return new Promise<void>(resolve => {
        play('rising', RISE);
        setTimeout(() => {
          letters.forEach(span => { span.style.animationDelay = ''; span.classList.remove('rising'); });
          void line.offsetWidth; // lets the slide animation start fresh
          play('sliding', SLIDE);
          setTimeout(() => {
            letters.forEach(span => { span.style.animationDelay = ''; span.classList.replace('sliding', 'done'); });
            resolve();
          }, totalTime(SLIDE));
        }, totalTime(RISE) + PAUSE);
      });
    }

    const show = (id: string, delay = 0) => setTimeout(() => document.getElementById(id)!.classList.add('visible'), delay);

    window.addEventListener('intro-done', () => {
      document.getElementById('textReveal')!.classList.add('revealed');
      show('eyebrow');
      show('sithFigure');
      setTimeout(async () => {
        await Promise.all([
          animateLine(document.getElementById('line1')!, 'System Online'),
          animateLine(document.getElementById('line2')!, 'Ready for input'),
        ]);
        show('heroDivider');
        show('heroBody', 130);
      }, 150);
    }, { once: true });
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     3. SITH FIGURE — the colour change is CSS; the saber and lightning are here
  ═══════════════════════════════════════════════════════════════════════════ */
  (function sith() {
    const SABER_DELAY = 5200, SABER_GROW = 1800; // ms after page load
    const HILT_TOP = 88;                         // the blade grows up from here
    const rect = (id: string) => document.getElementById(id) as unknown as SVGRectElement;
    const blades: [SVGRectElement, number, number][] = [ // [element, full height, opacity]: glow, middle, core
      [rect('sx-so'), 70, 0.4],
      [rect('sx-sm'), 66, 0.75],
      [rect('sx-sc'), 62, 1],
    ];
    let firstFrame: number | null = null;

    function growSaber(now: number) {
      firstFrame ??= now;
      const elapsed = now - firstFrame;
      const progress = Math.max(0, Math.min(1, (elapsed - SABER_DELAY) / SABER_GROW));
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress; // ease in-out
      for (const [blade, fullHeight, opacity] of blades) {
        const height = fullHeight * eased;
        blade.setAttribute('height', String(height));
        blade.setAttribute('y', String(HILT_TOP - height));
        if (progress > 0) blade.style.opacity = String(opacity);
      }
      if (elapsed < SABER_DELAY + SABER_GROW + 300) requestAnimationFrame(growSaber);
    }
    requestAnimationFrame(growSaber);

    // A bolt flickers on and off, then flickers again after a random wait, forever.
    function flashBolt(bolt: SVGElement, minWait: number, maxWait: number) {
      setTimeout(() => {
        const flicker: [number, string][] = [[0, '1'], [80, '0.25'], [140, '1'], [200, '0.6'], [260, '1'], [340, '0']];
        for (const [at, opacity] of flicker) setTimeout(() => { bolt.style.opacity = opacity; }, at);
        flashBolt(bolt, minWait, maxWait);
      }, minWait + Math.random() * (maxWait - minWait));
    }

    setTimeout(() => {
      const bolt = (id: string) => document.getElementById(id) as unknown as SVGElement;
      flashBolt(bolt('sx-b1'), 1200, 3500);
      setTimeout(() => flashBolt(bolt('sx-b2'), 1800, 4200), 700);
    }, 7000);
  })();
}

// All styles and CSS animations.
const STYLE = `/* ═══════════════════════════════════════════════════════════════════════════
   STYLES FOR THE RELEASE FORM

   Part 1 — the page itself, in the order things appear on screen:
     1. Colours and basics
     2. Page layout (left panel + right panel)
     3. Left panel text
     4. Form card
     5. Form fields
     6. Field states (error, valid)
     7. Date field and calendar
     8. Token status line
     9. Create page button and result message
    10. Small screens

   Part 2 — advanced: animations and effects (at the bottom)
    11. Hyperspeed intro
    12. Left panel reveal (fade-ins and the letter-by-letter heading)
    13. Sith figure
    14. Small animations (form card, calendar, shake, spinner)
═══════════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════════
   PART 1 — THE PAGE
═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   1. COLOURS AND BASICS
───────────────────────────────────────────────────────────────────────── */

/* Every element's size includes its padding and border, and nothing gets default spacing. */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  /* Reds */
  --red:          #C0001A;  /* main red: button, lines, selected day */
  --red-hot:      #FF1A2E;  /* brighter red: hover */

  /* Status colours */
  --ok:           #22C55E;  /* green: valid field, working token */
  --err:          #FF3333;  /* red border of a field with an error */
  --err-label:    #FF5555;  /* red text of an error */

  /* Backgrounds, from the page to the inputs */
  --bg-body:      #0B0004;  /* the whole page */
  --bg-card:      #0E0007;  /* the form card */
  --bg-input:     #160009;  /* an input */
  --bg-input-f:   #1E000D;  /* an input while you type in it ("f" = focused) */

  /* Text and borders */
  --white:        #FFFFFF;
  --text-input:   rgba(255, 220, 220, 0.92);  /* text you type */
  --label:        rgba(255, 160, 160, 0.62);  /* a label inside an empty field */
  --label-f:      rgba(220, 50, 70, 0.95);    /* a label above a filled or focused field */
  --border:       rgba(192, 0, 26, 0.22);     /* a field's border */
  --border-f:     rgba(192, 0, 26, 0.75);     /* a field's border while you type in it */
}

html,
body {
  height: 100%;
  background: var(--bg-body);
  color: var(--white);
  font-family: 'DM Sans', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}


/* ─────────────────────────────────────────────────────────────────────────
   2. PAGE LAYOUT
   Two columns: the heading on the left (56%), the form on the right (44%).
───────────────────────────────────────────────────────────────────────── */

.hero {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 56% 44%;
}

/* Left panel: its text sits at the bottom. */
.hero-left {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 3.75rem 3.75rem 3.75rem 4rem;
}

/* Right panel: the form card, centred vertically. */
.hero-right {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 3rem 2.75rem;
  overflow-y: auto;
}

/* The thin line between the two panels. */
.hero-right::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--border);
}


/* ─────────────────────────────────────────────────────────────────────────
   3. LEFT PANEL TEXT
   "System status", the two heading lines, a short line, and the body text.
───────────────────────────────────────────────────────────────────────── */

.hero-left-content {
  position: relative;
  z-index: 3; /* above the Sith figure */
}

/* The short red line above "System status". */
.hero-left-content::before {
  content: '';
  display: block;
  width: 32px;
  height: 2px;
  margin-bottom: 1.1rem;
  border-radius: 2px;
  background: var(--red);
}

/* "System status" */
.eyebrow {
  margin-bottom: 1rem;
  font-size: 0.6rem;
  font-weight: 500;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: rgba(220, 30, 50, 0.85);
  text-shadow: 0 0 12px rgba(255, 0, 30, 0.5);
}

/* The two heading lines. Each letter is its own <span class="char">, so it can be animated. */
.line {
  display: flex;
  flex-wrap: wrap;
  line-height: 1;
}

.line + .line {
  margin-top: 0.08em;
}

/* One letter of the first line, "System Online". */
.char {
  display: inline-block;
  white-space: pre; /* keeps a letter that is just a space from shrinking to nothing */
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(2.6rem, 4.5vw, 4.25rem); /* grows with the window, between 2.6rem and 4.25rem */
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--white);
  text-shadow: 0 0 40px rgba(220, 0, 20, 0.55), 0 0 90px rgba(180, 0, 10, 0.3);
}

/* One letter of the second line, "Ready for input": lighter, italic and smaller. */
#line2 .char {
  font-size: clamp(2rem, 3.5vw, 3.25rem);
  font-weight: 400;
  font-style: italic;
  color: rgba(255, 180, 180, 0.72);
  text-shadow: 0 0 40px rgba(200, 0, 15, 0.4), 0 0 80px rgba(150, 0, 10, 0.2);
}

/* The short red line under the heading. */
.hero-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.5rem 0;
}

.hero-divider::before {
  content: '';
  display: block;
  width: 40px;
  height: 1px;
  background: var(--red);
}

.hero-body-text {
  max-width: 38ch; /* about 38 characters per line */
  font-size: 0.9375rem;
  font-weight: 300;
  line-height: 1.72;
  letter-spacing: 0.015em;
  color: rgba(255, 210, 210, 0.72);
}


/* ─────────────────────────────────────────────────────────────────────────
   4. FORM CARD
   The box with "Release notes", the title, the description and the form.
───────────────────────────────────────────────────────────────────────── */

.form-card {
  position: relative;
  overflow: hidden;
  padding: 2.25rem 2.25rem 2rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-card);
}

/* The red line along the top of the card. */
.form-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--red);
}

/* "Release notes" */
.form-tag {
  display: block;
  margin-bottom: 0.55rem;
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: #FF3A52;
  text-shadow: 0 0 10px rgba(220, 0, 30, 0.5);
}

/* "Create a release page" */
.form-title {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 1.9rem;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.025em;
  color: var(--white);
  text-shadow: 0 0 30px rgba(200, 0, 20, 0.25);
}

/* The description under the title. */
.form-sub {
  margin-top: 0.3rem;
  font-size: 0.8rem;
  font-weight: 300;
  line-height: 1.55;
  letter-spacing: 0.01em;
  color: rgba(255, 190, 190, 0.62);
}

/* The line between the description and the fields. */
.form-rule {
  height: 1px;
  margin: 1.4rem 0 1.65rem;
  background: rgba(192, 0, 26, 0.18);
}


/* ─────────────────────────────────────────────────────────────────────────
   5. FORM FIELDS
   Two columns of fields. Each label sits inside its empty field, and moves
   up onto the border once the field has a value or you click into it.
───────────────────────────────────────────────────────────────────────── */

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  row-gap: 0;          /* the fields' own bottom margin spaces the rows */
  column-gap: 1.25rem;
}

.field {
  position: relative;
  margin-bottom: 1.4rem;
}

/* A field that spans both columns, e.g. App. */
.field.full-width {
  grid-column: 1 / -1;
}

/* The label, inside the empty field. */
label {
  position: absolute;
  top: 0.72rem;
  left: 0.85rem;
  z-index: 1;
  padding: 0 0.2rem;
  font-size: 0.8125rem;
  font-weight: 400;
  white-space: nowrap;
  color: var(--label);
  background: transparent;
  pointer-events: none; /* clicks go through to the input */
  transition:
    top 0.18s cubic-bezier(0.22, 1, 0.36, 1),
    font-size 0.18s cubic-bezier(0.22, 1, 0.36, 1),
    color 0.18s ease,
    font-weight 0.18s ease;
}

/* The label, moved up onto the border: when you're typing in the field, or it has a value. */
.field:focus-within label,
.field.filled label {
  top: -0.52rem;
  font-size: 0.635rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--label-f);
  background: var(--bg-card); /* hides the border line behind the label */
}

/* Text inputs and dropdowns. */
select,
input[type="text"] {
  width: 100%;
  padding: 0.72rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.875rem;
  font-weight: 400;
  color: var(--text-input);
  background: var(--bg-input);
  appearance: none; /* no browser-specific look */
  -webkit-appearance: none;
  transition:
    border-color 0.18s ease,
    box-shadow 0.2s ease,
    background 0.18s ease;
}

/* No placeholder text: the label does that job. */
input::placeholder {
  color: transparent;
}

/* Dropdowns: a small arrow on the right (an SVG image), and room for the label above the value. */
select {
  height: 2.85rem;
  padding-top: 1.15rem;
  padding-right: 2.25rem;
  padding-bottom: 0.3rem;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='rgba(200%2C80%2C80%2C0.6)' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.85rem center;
  cursor: pointer;
}

/* A dropdown always shows a value, so its label always sits on the border. */
.field:has(select) label {
  top: -0.52rem;
  font-size: 0.635rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--label-f);
  background: var(--bg-card);
}

select option {
  color: #FFD0D0;
  background: #1A0008;
}

select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* While you type in a field: a stronger border and a soft red ring. */
select:focus,
input[type="text"]:focus {
  border-color: var(--border-f);
  background: var(--bg-input-f);
  box-shadow: 0 0 0 3px rgba(192, 0, 26, 0.12), 0 0 16px rgba(192, 0, 26, 0.08);
}


/* ─────────────────────────────────────────────────────────────────────────
   6. FIELD STATES
   form.js adds .has-error (with a message) or .is-valid (with a green check) to a field.
───────────────────────────────────────────────────────────────────────── */

/* The error message under a field. A long one wraps onto more lines and pushes the next field down. */
.err-msg {
  display: block;
  margin-top: 0.3rem;
  font-size: 0.66rem;
  font-weight: 400;
  line-height: 1.4;
  color: var(--err-label);
  overflow-wrap: anywhere; /* long words like addresses can break anywhere */
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

/* No message: no empty space either. */
.err-msg:empty {
  display: none;
}

/* A field with an error: the message shows, and the label and border turn red. */
.field.has-error .err-msg {
  opacity: 1;
  transform: translateY(0);
}

.field.has-error label {
  color: var(--err-label);
}

.field.has-error select,
.field.has-error input {
  border-color: var(--err);
  background: rgba(255, 0, 0, 0.06);
  box-shadow: 0 0 0 3px rgba(255, 0, 0, 0.08);
}

/* A valid field: a green circle with a white check on the right (an SVG image). */
.field.is-valid::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 0.75rem;
  z-index: 2;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--ok) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6l2.5 2.5 4.5-5' stroke='white' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat center;
  transform: translateY(-50%); /* centred vertically */
  pointer-events: none;
}

/* Fields marked .no-badge (e.g. Date) show their state differently, so no check. */
.field.is-valid.no-badge::after {
  display: none;
}

.field.is-valid select,
.field.is-valid input {
  border-color: rgba(192, 0, 26, 0.6);
  background: rgba(192, 0, 26, 0.08);
}


/* ─────────────────────────────────────────────────────────────────────────
   7. DATE FIELD AND CALENDAR
───────────────────────────────────────────────────────────────────────── */

.date-wrap {
  position: relative;
}

.date-wrap input[type="text"] {
  padding-right: 2.6rem;        /* room for the calendar button */
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums; /* all digits the same width */
}

/* "YYYY-MM-DD" next to the label. */
.date-fmt {
  margin-left: 0.35rem;
  font-size: 0.57rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  color: rgba(192, 0, 26, 0.45);
}

/* The calendar button inside the date field. */
.date-btn {
  position: absolute;
  top: 50%;
  right: 0.55rem;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 4px;
  color: rgba(192, 0, 26, 0.6);
  background: none;
  transform: translateY(-50%); /* centred vertically */
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.date-btn:hover {
  color: rgba(255, 80, 80, 0.95);
  background: rgba(192, 0, 26, 0.1);
}

.date-btn svg {
  display: block;
  width: 15px;
  height: 15px;
  pointer-events: none;
}

/* The calendar icon turns green or red with the field. */
.field.is-valid .date-btn {
  color: rgba(34, 197, 94, 0.85);
}

.field.has-error .date-btn {
  color: rgba(255, 50, 50, 0.85);
}

/* The calendar that opens under the date field. */
.cal-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 999; /* above everything else on the form */
  width: 256px;
  padding: 10px;
  border: 1px solid rgba(192, 0, 26, 0.35);
  border-radius: 6px;
  background: #110007;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 40px rgba(192, 0, 26, 0.08);
}

.cal-pop[hidden] {
  display: none;
}

/* Calendar header: ‹  October 2026  › */
.cal-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

/* The ‹ and › buttons. */
.cal-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 4px;
  font-size: 1.3rem;
  line-height: 1;
  color: rgba(192, 0, 26, 0.7);
  background: none;
  cursor: pointer;
  transition:
    color 0.12s,
    background 0.12s;
}

.cal-nav:hover {
  color: #FF3333;
  background: rgba(192, 0, 26, 0.1);
}

/* The month name. Clicking it goes back to this month. */
.cal-lbl {
  padding: 3px 6px;
  border: none;
  border-radius: 4px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: rgba(255, 200, 200, 0.9);
  background: none;
  cursor: pointer;
  transition: background 0.12s;
}

.cal-lbl:hover {
  background: rgba(192, 0, 26, 0.1);
}

/* Mo Tu We Th Fr Sa Su */
.cal-wdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}

.cal-wdays span {
  padding: 3px 0;
  text-align: center;
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  color: rgba(192, 0, 26, 0.6);
}

/* The days: 7 columns. */
.cal-days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}

/* One day. */
.cal-day {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1; /* square */
  border: none;
  border-radius: 4px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.75rem;
  color: rgba(255, 210, 210, 0.8);
  background: none;
  cursor: pointer;
  transition:
    background 0.1s,
    color 0.1s;
}

.cal-day:hover {
  color: var(--white);
  background: rgba(192, 0, 26, 0.18);
}

/* A day from the month before or after. */
.cal-day.dim {
  color: rgba(255, 180, 180, 0.22);
}

.cal-day.today {
  border: 1px solid rgba(192, 0, 26, 0.5);
  font-weight: 600;
  color: #FF6666;
}

/* The picked day. */
.cal-day.sel {
  font-weight: 600;
  color: var(--white);
  background: var(--red);
  box-shadow: 0 0 10px rgba(192, 0, 26, 0.5);
}

.cal-day.sel:hover {
  background: var(--red-hot);
}

/* Calendar footer with the "Today" button. */
.cal-foot {
  display: flex;
  justify-content: center;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(192, 0, 26, 0.15);
}

.cal-today-btn {
  padding: 4px 14px;
  border: 1px solid rgba(192, 0, 26, 0.3);
  border-radius: 3px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  color: rgba(220, 60, 60, 0.85);
  background: none;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}

.cal-today-btn:hover {
  color: #FF4444;
  background: rgba(192, 0, 26, 0.12);
}


/* ─────────────────────────────────────────────────────────────────────────
   8. TOKEN STATUS LINE
   ● Confluence token found in .env · Authenticated as …
   The dot is green when the token works, red when it's missing or rejected, grey while checking.
   Two columns: the dot, then the text with the "Check again" button under it.
───────────────────────────────────────────────────────────────────────── */

.token-status {
  grid-column: 1 / -1; /* spans both form columns */
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  row-gap: 0.3rem;
  align-items: start;
  margin-bottom: 1.4rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--text-input);
  overflow-wrap: anywhere; /* long paths can break anywhere */
}

.token-status-dot {
  width: 8px;
  height: 8px;
  margin-top: 0.4em; /* lines the dot up with the first line of text */
  border-radius: 50%;
  background: var(--ok);
}

/* The text and the button both go in the second column. */
.token-status-text,
.token-status-btn {
  grid-column: 2;
  justify-self: start;
}

.token-status.bad .token-status-dot {
  background: var(--err);
}

.token-status.bad .token-status-text {
  color: var(--err-label);
}

.token-status.checking .token-status-dot {
  background: #666666;
}

/* "Check again": looks like a link. */
.token-status-btn {
  padding: 0;
  border: none;
  font: inherit;
  text-decoration: underline;
  color: var(--label-f);
  background: none;
  cursor: pointer;
}

.token-status-btn:hover {
  color: var(--red-hot);
}

.token-status-btn[hidden] {
  display: none;
}


/* ─────────────────────────────────────────────────────────────────────────
   9. CREATE PAGE BUTTON AND RESULT MESSAGE
───────────────────────────────────────────────────────────────────────── */

.submit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  margin-top: 0.4rem;
  padding-top: 1.4rem;
  border-top: 1px solid rgba(192, 0, 26, 0.18);
}

.btn-submit {
  position: relative; /* the spinner is placed inside it */
  overflow: hidden;
  flex-shrink: 0;
  padding: 0.8125rem 2.1rem;
  border: none;
  border-radius: 3px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--white);
  background: var(--red);
  cursor: pointer;
  transition:
    background 0.2s ease,
    transform 0.1s ease;
}

.btn-submit:hover {
  background: var(--red-hot);
}

/* Pressed: shrinks a little. */
.btn-submit:active {
  transform: scale(0.975);
}

/* While the page is being created. Comes after :hover, so it stays grey on hover. */
.btn-submit:disabled {
  background: #666666;
  cursor: not-allowed;
}

/* Room for the spinner while loading. */
.btn-submit.loading {
  padding-right: 2.6rem;
}

/* "Release page created with 3 PRs — open in Confluence", or an error. */
.status-msg {
  min-height: 1rem;
  font-size: 0.8rem;
  font-weight: 400;
  opacity: 0;
  transition: opacity 0.25s ease;
}

.status-msg.ok {
  color: #FF6B6B;
  opacity: 1;
}

.status-msg.err {
  color: #FF4444;
  opacity: 1;
}

.status-msg a {
  color: inherit;
  text-decoration: underline;
}


/* ─────────────────────────────────────────────────────────────────────────
   10. SMALL SCREENS
───────────────────────────────────────────────────────────────────────── */

/* Tablets and phones: the two panels stack, the heading on top of the form. */
@media (max-width: 820px) {
  .hero {
    grid-template-columns: 1fr;
    min-height: auto;
  }

  .hero-left {
    min-height: 55vw;
    padding: 2.5rem 1.75rem;
  }

  .hero-right {
    padding: 2rem 1.5rem 3rem;
  }

  .hero-right::before {
    display: none; /* no line between panels that are stacked */
  }
}

/* Phones: one field per row. */
@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   PART 2 — ADVANCED: ANIMATIONS AND EFFECTS

   How these work:
   - @keyframes name { from {...} to {...} } describes an animation: how styles change over time.
   - "animation: name 2s ease forwards" plays it: for 2 seconds, easing in and out,
     and "forwards" keeps the end state when it's done. "infinite" repeats it forever.
   - Many elements start hidden (opacity: 0). effects.js adds a class like .visible
     at the right moment, and a "transition" fades them in.
═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   11. HYPERSPEED INTRO
   A black layer over the whole page with a canvas that effects.js draws the stars on.
   When the intro is done, effects.js adds .fading and the layer fades out.
───────────────────────────────────────────────────────────────────────── */

#intro {
  position: fixed;
  inset: 0; /* covers the whole window */
  z-index: 9999;
  background: #000000;
  pointer-events: none;
}

#introCanvas {
  display: block;
  width: 100%;
  height: 100%;
}

#intro.fading {
  opacity: 0;
  transition: opacity 0.75s cubic-bezier(0.4, 0, 0.2, 1);
}


/* ─────────────────────────────────────────────────────────────────────────
   12. LEFT PANEL REVEAL
   After the intro, effects.js shows the left panel's parts one after another.
───────────────────────────────────────────────────────────────────────── */

/* The short red line: fades in when the text block gets .revealed. */
.hero-left-content::before {
  opacity: 0;
  transition: opacity 0.6s ease 0.1s;
}

.hero-left-content.revealed::before {
  opacity: 1;
}

/* "System status", the divider and the body text: fade in when they get .visible. */
.eyebrow,
.hero-divider {
  opacity: 0;
  transition: opacity 0.5s ease;
}

.eyebrow.visible,
.hero-divider.visible {
  opacity: 1;
}

/* The body text also moves up a little while it fades in. */
.hero-body {
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 640ms ease,
    transform 640ms ease;
}

.hero-body.visible {
  opacity: 1;
  transform: translateY(0);
}

/* The heading letters. Each letter goes through three steps (effects.js sets the class):
     .rising  — rises up from below, fading in, still shifted to the right
     .sliding — slides left into its place
     .done    — in place */
:root {
  --rise-start: 65px;   /* how far below its place a letter starts */
  --slide-start: 48px;  /* how far right of its place a letter starts */
  --rise-time: 580ms;
  --slide-time: 460ms;
}

.char {
  opacity: 0;
  transform: translateY(var(--rise-start)) translateX(var(--slide-start));
  will-change: transform, opacity; /* tells the browser these will animate, so it's smoother */
}

.char.rising {
  animation: rise var(--rise-time) cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.char.sliding {
  opacity: 1;
  transform: translateY(0) translateX(var(--slide-start));
  animation: slide var(--slide-time) cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.char.done {
  opacity: 1;
  transform: translateY(0) translateX(0);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(var(--rise-start)) translateX(var(--slide-start));
  }
  to {
    opacity: 1;
    transform: translateY(0) translateX(var(--slide-start));
  }
}

@keyframes slide {
  from {
    transform: translateY(0) translateX(var(--slide-start));
  }
  to {
    transform: translateY(0) translateX(0);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   13. SITH FIGURE
   An SVG avatar in the left panel. Over 8 seconds it turns into a hooded Sith:
   colours darken, a hood and tattoos appear, the eyes turn yellow and glow.
   effects.js adds the lightsaber and the lightning on top.
   All its class names start with "sx-" so they can't clash with the rest of the page.
───────────────────────────────────────────────────────────────────────── */

/* Position: centred in the left panel, a little above the middle. Fades in on .visible. */
.sith-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  width: clamp(180px, 34%, 270px);
  opacity: 0;
  transform: translate(-50%, -58%);
  filter: drop-shadow(0 0 40px rgba(200, 0, 20, 0.45)) drop-shadow(0 0 80px rgba(150, 0, 10, 0.25));
  pointer-events: none;
  transition: opacity 1.8s ease;
}

.sith-wrap.visible {
  opacity: 1;
}

.sith-wrap svg {
  display: block;
  width: 100%;
  height: auto;
}

/* Which part of the figure plays which animation. Most run once for 8 seconds;
   the "loop" ones start after 8 seconds (the second time value) and repeat forever. */
.sx-svg   { animation: sx-shadowGrow   8s forwards; }
.sx-bg    { animation: sx-bgTransform  8s forwards ease-in-out; }
.sx-skin  { animation: sx-skinFade     8s forwards ease-in-out; }
.sx-hair  { animation: sx-hairFade     8s forwards ease-in-out; }
.sx-eye   { animation: sx-eyeXform     8s forwards ease-in-out; }
.sx-mouth { animation: sx-mouthFade    8s forwards ease-in-out; }
.sx-dark  { animation: sx-darkOverlay  8s forwards ease-in-out; }
.sx-hood  { animation: sx-hoodAppear   8s forwards ease-in-out; }
.sx-tat   { animation: sx-tattooAppear 8s forwards ease-in-out; }
.sx-pupil { animation: sx-eyePupil     8s forwards; }
.sx-eglow { animation: sx-eyeGlowIn    8s forwards, sx-eyePulseLoop 2.5s 8s ease-in-out infinite; }
.sx-flash { animation: sx-flashIn      8s forwards; pointer-events: none; }
.sx-amb   { animation: sx-glowIn       8s forwards; }
.sx-aura  { animation: sx-auraIn       8s forwards, sx-auraLoop 4s 8s infinite; }
.sx-sbo   { animation: sx-saberPulse   1.8s 8s infinite; }  /* lightsaber glow */
.sx-sbc   { animation: sx-corePulse    2.3s 8s infinite; }  /* lightsaber core */
#sx-root  { animation: sx-float        4s 8.2s ease-in-out infinite; display: block; }  /* gentle floating */

/* The animations. The percentages are points in time: 60% of 8 seconds is 4.8 seconds. */

/* Colours: each part keeps its colour until a point, then darkens. */
@keyframes sx-bgTransform  { 0%, 60% { fill: #FF5630; } 100% { fill: #1A0000; } }   /* orange circle → near black */
@keyframes sx-skinFade     { 0%, 60% { fill: #FFE2D9; } 100% { fill: #1E0E0E; } }   /* skin → dark */
@keyframes sx-hairFade     { 0%, 55% { fill: #FFAB00; } 100% { fill: #110404; } }   /* yellow hair → dark */
@keyframes sx-eyeXform     { 0%, 55% { fill: #344563; } 85% { fill: #FFCC00; } 100% { fill: #FFAA00; } }  /* blue eyes → yellow */
@keyframes sx-mouthFade    { 0%, 60% { fill: #DE350B; } 100% { fill: #440000; } }   /* red mouth → dark red */

/* Layers that appear: invisible until a point, then fade in. */
@keyframes sx-darkOverlay  { 0%, 40% { opacity: 0; } 100% { opacity: 0.82; } }      /* dark shadow over the face */
@keyframes sx-hoodAppear   { 0%, 50% { opacity: 0; } 100% { opacity: 1; } }
@keyframes sx-tattooAppear { 0%, 65% { opacity: 0; } 100% { opacity: 0.75; } }
@keyframes sx-eyePupil     { 0%, 65% { opacity: 0; } 100% { opacity: 1; } }
@keyframes sx-eyeGlowIn    { 0%, 65% { opacity: 0; } 80% { opacity: 0.9; } 90% { opacity: 0.5; } 100% { opacity: 0.8; } }
@keyframes sx-glowIn       { 0%, 55% { opacity: 0; } 100% { opacity: 0.2; } }       /* red glow at the bottom */
@keyframes sx-auraIn       { 0%, 60% { opacity: 0; } 100% { opacity: 1; } }         /* red ring around the figure */
@keyframes sx-flashIn      { 0%, 58% { opacity: 0; } 62% { opacity: 0.7; } 66%, 100% { opacity: 0; } }  /* a quick white flash */
@keyframes sx-shadowGrow   { 0%, 55% { filter: none; } 100% { filter: drop-shadow(0 0 18px rgba(180, 0, 0, 0.7)) drop-shadow(0 0 36px rgba(100, 0, 0, 0.4)); } }

/* Loops, once the change is done. */
@keyframes sx-eyePulseLoop { 0%, 100% { opacity: 0.75; } 50% { opacity: 0.3; } }
@keyframes sx-auraLoop     { 0%, 100% { stroke-width: 2; opacity: 0.2; } 50% { stroke-width: 1; opacity: 0.06; } }
@keyframes sx-saberPulse   { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.65; } }
@keyframes sx-corePulse    { 0%, 100% { opacity: 1; } 92% { opacity: 0.85; } 96% { opacity: 1; } }  /* a tiny flicker */
@keyframes sx-float        { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }


/* ─────────────────────────────────────────────────────────────────────────
   14. SMALL ANIMATIONS
───────────────────────────────────────────────────────────────────────── */

/* The form card fades in and moves up a little when the page loads. */
.form-card {
  opacity: 0;
  transform: translateY(14px);
  animation: cardIn 0.75s cubic-bezier(0.22, 1, 0.36, 1) 0.15s forwards;
}

@keyframes cardIn {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* The calendar drops in when it opens. */
.cal-pop {
  animation: calDrop 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes calDrop {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* The token line shakes when "Create page" is clicked without a working token. */
.token-status.shake {
  animation: shake 0.42s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  15%      { transform: translateX(-6px); }
  30%      { transform: translateX(5px); }
  45%      { transform: translateX(-4px); }
  60%      { transform: translateX(3px); }
  75%      { transform: translateX(-2px); }
  90%      { transform: translateX(1px); }
}

/* The spinning circle in the "Create page" button while the page is being created. */
.btn-spinner {
  display: none;
  position: absolute;
  top: 50%;
  right: 0.8rem;
  width: 13px;
  height: 13px;
  border: 1.5px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--white); /* one bright edge, so you can see it turn */
  border-radius: 50%;
  transform: translateY(-50%);
  animation: spin 0.65s linear infinite;
}

.btn-submit.loading .btn-spinner {
  display: block;
}

@keyframes spin {
  to {
    transform: translateY(-50%) rotate(360deg);
  }
}
`;

const FORM_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Systemet</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,300;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap" rel="stylesheet"/>
  <style>
${STYLE}  </style>
</head>
<body>

<main class="hero">

  <!-- ═══════════════════════════════════════════════════════════════════════
       LEFT — Sith + heading
  ═══════════════════════════════════════════════════════════════════════════ -->
  <div class="hero-left">

    <!-- Sith figure -->
    <div class="sith-wrap" id="sithFigure" aria-hidden="true">
      <svg id="sx-root" class="sx-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" style="width:100%;height:auto;display:block;">
        <defs>
          <filter id="sx-sf"  x="-60%" y="-5%"   width="220%" height="110%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="sx-gr"  x="-40%" y="-40%"  width="180%" height="180%"><feGaussianBlur stdDeviation="2"   result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="sx-sb"                                                ><feGaussianBlur stdDeviation="1.5"/></filter>
          <filter id="sx-eg"  x="-80%" y="-80%"  width="260%" height="260%"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <linearGradient id="sx-cl" x1="0%" y1="0%" x2="60%" y2="100%"><stop offset="0%"   stop-color="#1c0808"/><stop offset="100%" stop-color="#060202"/></linearGradient>
          <linearGradient id="sx-hl" x1="0%" y1="0%" x2="40%" y2="100%"><stop offset="0%"   stop-color="#1a0606"/><stop offset="100%" stop-color="#060101"/></linearGradient>
        </defs>
        <!-- original avatar -->
        <path class="sx-bg"   d="M60 120C27 120 0 93 0 60S27 0 60 0s60 27 60 60-27 60-60 60z"/>
        <path class="sx-hair" d="M102.5 66c.5-3.5-1.5-7-4.5-9-1.5-1-2.5-3-1.5-4.5s1-3.5.5-5.5c-.5-3-3.5-5.5-7-6-4.5-12-16.5-20.5-30-20.5S35 29 30.5 41C27 41 24 43.5 23 47c-.5 2-.5 3.5.5 5.5.5 2 .5 3.5-1.5 4.5-3 2-5.5 5.5-5 9 .5 4 3 7 6.5 8.5v13c0 2 1.5 4 4 4h63c2.5 0 4.5-1.5 4-4V75c4.5-1 8-4 8-9z"/>
        <path class="sx-skin" d="M60 103c-16 0-29.5-13-29.5-29.5v-26H89V74c.5 16-13 29-29 29z"/>
        <path class="sx-hair" d="M74.5 44.5h-46v17H43c8.5 0 13.5-5.5 15.5-8.5.5-.5 2-.5 2.5 0 2.5 4 8.5 12 19.5 12h11V44l-17 .5z"/>
        <circle class="sx-eye"  cx="48"   cy="72.5" r="3.5"/>
        <circle class="sx-eye"  cx="70.5" cy="72.5" r="3.5"/>
        <path   class="sx-eye"  d="M60 96c5.5 0 9.5-3.5 11.5-8.5.5-2-.5-4-3-4h-17c-2.5 0-3.5 2-3 4 2 5 6 8.5 11.5 8.5z"/>
        <path   class="sx-mouth" d="M60 90c-3 0-5 2-6.5 4 2 1.5 4 2 6.5 2s4.5-.5 6.5-2c-1-2-3.5-4-6.5-4z"/>
        <!-- transformation layers -->
        <path class="sx-dark" d="M60 120C27 120 0 93 0 60S27 0 60 0s60 27 60 60-27 60-60 60z" fill="#000" opacity="0"/>
        <ellipse class="sx-amb" cx="60" cy="118" rx="50" ry="5" fill="#cc0000" opacity="0" filter="url(#sx-sb)"/>
        <circle  class="sx-aura" cx="60" cy="60" r="65" fill="none" stroke="#cc0000" stroke-width="2" opacity="0" filter="url(#sx-gr)"/>
        <g class="sx-hood" opacity="0">
          <path d="M18,72 C15,85 12,100 10,120 L110,120 C108,100 105,85 102,72 Z" fill="url(#sx-cl)" stroke="#1a0404" stroke-width="0.5"/>
          <path d="M38,74 C36,90 34,105 33,120" stroke="#0a0202" stroke-width="1" fill="none" opacity="0.5"/>
          <path d="M60,75 C60,92 60,107 60,120"  stroke="#0a0202" stroke-width="1" fill="none" opacity="0.5"/>
          <path d="M82,74 C84,90 86,105 87,120" stroke="#0a0202" stroke-width="1" fill="none" opacity="0.5"/>
          <ellipse cx="60" cy="52" rx="38" ry="42" fill="url(#sx-hl)"/>
          <ellipse cx="60" cy="48" rx="30" ry="34" fill="#080202" opacity="0.88"/>
          <path d="M22,38 C24,50 26,62 28,78 C31,65 34,52 38,44 Z" fill="#0d0303" opacity="0.9"/>
          <path d="M98,38 C96,50 94,62 92,78 C89,65 86,52 82,44 Z" fill="#0d0303" opacity="0.9"/>
          <path d="M38,22 C45,18 60,16 75,18 C83,20 88,26 90,30 C82,26 72,23 60,22 C48,23 38,26 30,30 Z" fill="#060101" opacity="0.95"/>
          <rect x="93" y="88" width="5.5" height="18" rx="1.5" fill="#1a1a1a" stroke="#333" stroke-width="0.4"/>
          <rect x="93.2" y="89.5" width="5" height="3" rx="0.8" fill="#2a2a2a"/>
          <circle cx="95.75" cy="101" r="1.5" fill="#550000" stroke="#880000" stroke-width="0.4"/>
          <rect x="92.5" y="104" width="6.5" height="1.5" rx="1" fill="#222"/>
        </g>
        <g class="sx-tat" opacity="0">
          <path d="M33,68 L40,67 M32,72 L39,72 M34,76 L40,75" stroke="#cc0000" stroke-width="0.8" fill="none"/>
          <path d="M87,68 L80,67 M88,72 L81,72 M86,76 L80,75" stroke="#cc0000" stroke-width="0.8" fill="none"/>
          <path d="M60,38 L63,42 L60,46 L57,42 Z"            stroke="#990000" stroke-width="0.7" fill="none"/>
          <path d="M60,39.5 L60,44.5 M57.5,42 L62.5,42"      stroke="#660000" stroke-width="0.5" fill="none"/>
        </g>
        <g class="sx-pupil" opacity="0">
          <ellipse cx="48"   cy="72.5" rx="7"   ry="5"   fill="#0a0000"/>
          <ellipse cx="70.5" cy="72.5" rx="7"   ry="5"   fill="#0a0000"/>
          <ellipse cx="48"   cy="72.5" rx="5.5" ry="4"   fill="#cc6600"/>
          <ellipse cx="70.5" cy="72.5" rx="5.5" ry="4"   fill="#cc6600"/>
          <ellipse cx="48"   cy="72.5" rx="4"   ry="2.8" fill="#ffcc00"/>
          <ellipse cx="70.5" cy="72.5" rx="4"   ry="2.8" fill="#ffcc00"/>
          <polygon points="48,69 49.2,72.5 48,76 46.8,72.5"     fill="#050000"/>
          <polygon points="70.5,69 71.7,72.5 70.5,76 69.3,72.5" fill="#050000"/>
          <line x1="42" y1="67.5" x2="52" y2="69.5" stroke="#1a0000" stroke-width="1.8" stroke-linecap="round"/>
          <line x1="65" y1="69.5" x2="75" y2="67.5" stroke="#1a0000" stroke-width="1.8" stroke-linecap="round"/>
          <ellipse cx="45.5" cy="71" rx="1" ry="0.7" fill="#fff8cc" opacity="0.6"/>
          <ellipse cx="68"   cy="71" rx="1" ry="0.7" fill="#fff8cc" opacity="0.6"/>
        </g>
        <g class="sx-eglow" opacity="0" filter="url(#sx-eg)">
          <ellipse cx="48"   cy="72.5" rx="8"   ry="6"   fill="#ff6600" opacity="0.18"/>
          <ellipse cx="70.5" cy="72.5" rx="8"   ry="6"   fill="#ff6600" opacity="0.18"/>
          <ellipse cx="48"   cy="72.5" rx="5.5" ry="4"   fill="none" stroke="#ffaa00" stroke-width="1.2"/>
          <ellipse cx="70.5" cy="72.5" rx="5.5" ry="4"   fill="none" stroke="#ffaa00" stroke-width="1.2"/>
        </g>
        <!-- saber -->
        <rect class="sx-sbo" id="sx-so" x="93.5" y="88" width="4.5" height="0" rx="2"   fill="#ff0000" opacity="0" filter="url(#sx-sf)"/>
        <rect class="sx-sbo" id="sx-sm" x="94"   y="88" width="3.5" height="0" rx="1.5" fill="#ff3333" opacity="0" filter="url(#sx-sf)"/>
        <rect class="sx-sbc" id="sx-sc" x="94.8" y="88" width="2"   height="0" rx="1"   fill="#ffffff" opacity="0"/>
        <!-- lightning -->
        <g id="sx-b1" opacity="0" filter="url(#sx-gr)">
          <polyline points="18,85 10,76 5,79 -2,68 -8,71 -14,61" stroke="#cc00ff" stroke-width="1.2" fill="none" stroke-linecap="round"/>
          <polyline points="18,85 12,74 7,77 2,66"                stroke="#ee88ff" stroke-width="0.7" fill="none" stroke-linecap="round"/>
          <polyline points="5,79 1,72 -2,75 -7,65"                stroke="#cc00ff" stroke-width="0.6" fill="none" stroke-linecap="round"/>
        </g>
        <g id="sx-b2" opacity="0" filter="url(#sx-gr)">
          <polyline points="102,85 110,76 115,79 122,68" stroke="#ff3388" stroke-width="1"   fill="none" stroke-linecap="round"/>
          <polyline points="110,76 114,70 118,73"         stroke="#ff88aa" stroke-width="0.6" fill="none" stroke-linecap="round"/>
        </g>
        <path class="sx-flash" d="M60 120C27 120 0 93 0 60S27 0 60 0s60 27 60 60-27 60-60 60z" fill="#fff" opacity="0"/>
      </svg>
    </div>

    <!-- Left text content -->
    <div class="hero-left-content" id="textReveal">
      <p class="eyebrow" id="eyebrow">System status</p>
      <div class="line" id="line1"></div>
      <div class="line" id="line2"></div>
      <div class="hero-divider" id="heroDivider"></div>
      <div class="hero-body" id="heroBody">
        <p class="hero-body-text">All systems are operational and standing by for your next command. Personal, thoughtful service — ready when you are.</p>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════════
       RIGHT — Form
  ═══════════════════════════════════════════════════════════════════════════ -->
  <div class="hero-right">
    <div class="form-card">
      <span class="form-tag">Release notes</span>
      <h1 class="form-title">Create a release page</h1>
      <p class="form-sub">Lists every merged change between two tags of an app and publishes it as a Confluence page.</p>
      <div class="form-rule"></div>

      <form id="mainForm" novalidate>
        <div class="form-grid">

          <!-- TOKEN — the server reads it from .env; the page only shows the status -->
          <div class="token-status checking" id="token-status" role="status" aria-live="polite">
            <span class="token-status-dot" aria-hidden="true"></span>
            <span class="token-status-text" id="token-status-text">Checking the Confluence token…</span>
            <button type="button" class="token-status-btn" id="token-recheck" hidden>Check again</button>
          </div>

          <!-- APP — top-level folder in the monorepo -->
          <div class="field full-width" id="f-app">
            <label for="app">App</label>
            <select id="app" name="app"><option value="">Loading apps…</option></select>
            <span class="err-msg" id="e-app"></span>
          </div>

          <!-- VERSION -->
          <div class="field" id="f-version">
            <label for="version">Version</label>
            <input type="text" id="version" name="version" maxlength="50" autocomplete="off" spellcheck="false"/>
            <span class="err-msg" id="e-version"></span>
          </div>
          <!-- DATE — custom calendar, no-badge (icon already turns green) -->
          <div class="field no-badge" id="f-eventdate">
            <label for="eventdate">Date <span class="date-fmt">YYYY-MM-DD</span></label>
            <div class="date-wrap">
              <input type="text" id="eventdate" name="eventdate" inputmode="numeric" maxlength="10" autocomplete="off" spellcheck="false"/>
              <button type="button" class="date-btn" id="date-btn" aria-label="Open calendar" aria-expanded="false">
                <svg viewBox="0 0 16 16" fill="none"><rect x="1" y="2.5" width="14" height="12.5" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M1 6.5h14" stroke="currentColor" stroke-width="1.2"/><path d="M5 1v3M11 1v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="4"  y="9" width="2" height="2" rx="0.4" fill="currentColor" opacity="0.6"/><rect x="7"  y="9" width="2" height="2" rx="0.4" fill="currentColor" opacity="0.6"/><rect x="10" y="9" width="2" height="2" rx="0.4" fill="currentColor" opacity="0.6"/></svg>
              </button>
              <div class="cal-pop" id="cal-pop" hidden>
                <div class="cal-hdr">
                  <button type="button" class="cal-nav" id="cal-prev">&#8249;</button>
                  <button type="button" class="cal-lbl" id="cal-lbl"></button>
                  <button type="button" class="cal-nav" id="cal-next">&#8250;</button>
                </div>
                <div class="cal-wdays"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div>
                <div class="cal-days" id="cal-days"></div>
                <div class="cal-foot"><button type="button" class="cal-today-btn" id="cal-today">Today</button></div>
              </div>
            </div>
            <span class="err-msg" id="e-eventdate"></span>
          </div>

          <!-- TAGS — the server reads the merged PRs between them -->
          <div class="field" id="f-tagfrom">
            <label for="tagfrom">From tag (OLD)</label>
            <select id="tagfrom" name="tagfrom" disabled><option value="">Select an app first</option></select>
            <span class="err-msg" id="e-tagfrom"></span>
          </div>
          <div class="field" id="f-tagto">
            <label for="tagto">To tag (NEW)</label>
            <select id="tagto" name="tagto" disabled><option value="">Select an app first</option></select>
            <span class="err-msg" id="e-tagto"></span>
          </div>

        </div><!-- /form-grid -->

        <div class="submit-row">
          <button type="submit" class="btn-submit" id="submitBtn">Create page<span class="btn-spinner"></span></button>
          <span class="status-msg" id="statusMsg" role="status" aria-live="polite"></span>
        </div>
      </form>
    </div>
  </div>

</main>

<div id="intro" aria-hidden="true"><canvas id="introCanvas"></canvas></div>

<script>(${formScript})();</script>
<script>(${effectsScript})();</script>
</body>
</html>
`;

// ═══════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════

if (!envFileIsGitIgnored()) {
  console.warn(`[token] git doesn't ignore ${ENV_FILE}, so it could commit your token. Add ".env" to .gitignore.`);
}

// 127.0.0.1: only this computer can reach the server.
http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
