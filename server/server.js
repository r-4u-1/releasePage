// Local server for the release form.
//
// It does three things:
//   1. Serves the form page (the files in public/).
//   2. Answers the form's questions: which apps exist, which tags they have, does the token work.
//   3. Runs the release script:
//        bash <releaseScript> <from-tag> <to-tag> <app> <version> <date>
//      The Confluence token is given to the script as the CONFLUENCE_TOKEN environment variable.
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

// The release script. Git Bash on Windows understands C:/x/y.sh, but not always C:\x\y.sh.
const RELEASE_SCRIPT = path.resolve(__dirname, config.releaseScript).replace(/\\/g, '/');

// Confluence's address, without a trailing slash.
const CONFLUENCE_URL = config.confluenceBaseUrl.replace(/\/+$/, '');

// The release script may run for at most 5 minutes.
const RELEASE_TIMEOUT_MS = 5 * 60 * 1000;

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

// The last non-empty line of some output, e.g. the error message at the end of a script's stderr.
function lastLine(output) {
  return String(output).trim().split('\n').pop();
}

// ═══════════════════════════════════════════════════════════════════════════
// Git: apps and tags
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
// Hidden folders, node_modules and this tool's own folder are always left out.
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

// ═══════════════════════════════════════════════════════════════════════════
// Token: saved in .env, checked with Confluence
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

// Asks Confluence who the token belongs to. Returns that person's name, or fails.
async function checkTokenWithConfluence(token) {
  let response;
  try {
    response = await fetch(CONFLUENCE_URL + '/rest/api/user/current', {
      headers: { Authorization: authorizationHeader(token), Accept: 'application/json' },
      redirect: 'manual',                 // a redirect means a login page, not an answer
      signal: AbortSignal.timeout(10_000), // give up after 10 seconds
    });
  } catch {
    fail(502, 'Could not reach Confluence');
  }

  const user = await response.json().catch(() => ({}));

  // Cloud answers a bad token with an "anonymous" user instead of 401.
  if (response.status === 401 || user.type === 'anonymous') fail(401, 'Token rejected by Confluence');
  if (response.status === 403) fail(403, 'Token has no access to Confluence');
  if (!response.ok) fail(502, `Confluence responded with HTTP ${response.status}`);

  return user.displayName || user.username || 'user';
}

// The token typed in the form, or else the one that's already verified or saved.
function tokenFromForm(body) {
  const token = textValue(body.token) || process.env.CONFLUENCE_TOKEN;
  if (!token) fail(400, 'Token is required');
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════
// Release script
// ═══════════════════════════════════════════════════════════════════════════

// Runs the release script from the monorepo root. Returns what it printed.
// Fails with its last error line if it exits with anything other than 0.
function runReleaseScript({ from, to, app, version, date }) {
  const args = [RELEASE_SCRIPT, from, to, app, version, date];

  const environment = {
    ...process.env, // includes CONFLUENCE_TOKEN once a token is verified
    CONFLUENCE_BASE_URL: CONFLUENCE_URL,
    CONFLUENCE_EMAIL: config.confluenceEmail,
  };

  console.log(`[release] ${config.bash} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const options = {
      cwd: REPO_ROOT,
      env: environment,
      timeout: RELEASE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    };

    // stdout: what the script printed. stderr: what it printed as errors.
    execFile(config.bash, args, options, (error, stdout, stderr) => {
      process.stdout.write(stdout); // show the script's output in this terminal too
      process.stderr.write(stderr);

      if (!error) {
        resolve(stdout.trim());
        return;
      }

      let reason;
      if (error.code === 'ENOENT') {
        reason = `"${config.bash}" not found — set "bash" in config.json`;
      } else if (error.killed) {
        reason = 'timed out after 5 minutes';
      } else {
        reason = lastLine(stderr || stdout) || `exit code ${error.code}`;
      }

      const failure = new Error(`Release script failed: ${reason}`);
      failure.status = 500;
      reject(failure);
    });
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
// A working token becomes CONFLUENCE_TOKEN for the release script. A typed one is also saved to .env.
async function verifyToken(body) {
  const token = tokenFromForm(body);
  const userName = await checkTokenWithConfluence(token);
  process.env.CONFLUENCE_TOKEN = token;

  const typedToken = textValue(body.token);
  const saved = typedToken ? saveToken(typedToken) : true;

  return { message: `Authenticated as ${userName}`, saved };
}

// Checks the form and runs the release script.
async function startRelease(body) {
  process.env.CONFLUENCE_TOKEN = tokenFromForm(body);

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

  const output = await runReleaseScript({ from, to, app, version, date });
  return { output };
}

// Finds what to do for a request, e.g. "GET /api/apps".
async function answerApiRequest(method, pathname, body) {
  if (method === 'GET' && pathname === '/api/token') return getTokenStatus();
  if (method === 'POST' && pathname === '/api/verify/token') return verifyToken(body);
  if (method === 'GET' && pathname === '/api/apps') return { apps: listApps() };
  if (method === 'POST' && pathname === '/api/release') return startRelease(body);

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

// A token saved in .env is ready for the release script from the start.
const savedToken = readSavedToken();
if (savedToken) {
  process.env.CONFLUENCE_TOKEN = savedToken;
}

// 127.0.0.1: only this computer can reach the server.
http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
