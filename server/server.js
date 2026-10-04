// The web server: serves the form (public/) and the API the form calls.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { createApp, HttpError, sendFile } = require('./web');
const git = require('./git');
const confluence = require('./confluence');
const storage = require('./storage');
const { runReleaseScript } = require('./release');

// Only answer this computer's own page: not other websites, not other host names.
// That way nobody else can use the token saved in .env.
const OWN_HOSTS = [`localhost:${config.port}`, `127.0.0.1:${config.port}`];

function onlyOwnPage(req) {
  const { host, origin } = req.headers;
  if (!OWN_HOSTS.includes(host) || (origin && origin !== `http://${host}`)) {
    throw new HttpError(403, 'Forbidden');
  }
}

const app = createApp({ before: onlyOwnPage });

// ── Input checks ───────────────────────────────────────────────────────────

const text = value => (typeof value === 'string' ? value.trim() : '');

// The token typed in the form, or else the verified/saved one.
function tokenFrom(body) {
  const token = text(body?.token) || process.env.CONFLUENCE_TOKEN;
  if (!token) throw new HttpError(400, 'Token is required');
  return token;
}

// ── The form page ──────────────────────────────────────────────────────────

// Only the files in public/ can be fetched, nothing else on disk.
const PUBLIC_FILES = fs.readdirSync(config.publicDir);

app.get('/', (req, res) => sendFile(res, path.join(config.publicDir, 'index.html')));

app.get('/:file', (req, res) => {
  if (!PUBLIC_FILES.includes(req.params.file)) throw new HttpError(404, 'Not found');
  sendFile(res, path.join(config.publicDir, req.params.file));
});

// ── Token ──────────────────────────────────────────────────────────────────

// Whether a token is saved (never the token itself), and whether a typed one can be saved.
app.get('/api/token', () => ({
  ok: true,
  saved: Boolean(storage.readToken()),
  canSave: storage.canSaveToken(),
}));

// Checks the typed token, or the saved one when none is sent.
// A token that works becomes CONFLUENCE_TOKEN for the release script. A typed one is saved to .env too.
app.post('/api/verify/token', async req => {
  const typed = text(req.body?.token);
  const token = tokenFrom(req.body);
  const user = await confluence.currentUser(token);
  process.env.CONFLUENCE_TOKEN = token;
  const saved = typed ? storage.saveToken(typed) : true;
  if (typed && saved) console.log(`[token] saved to ${config.envFile}`);
  return { ok: true, message: `Authenticated as ${user}`, saved };
});

// ── Apps and tags ──────────────────────────────────────────────────────────

app.get('/api/apps', () => ({
  ok: true,
  apps: git.listApps(),
}));

app.get('/api/apps/:app/tags', req => ({
  ok: true,
  tags: git.listTags(req.params.app),
}));

// ── Release ────────────────────────────────────────────────────────────────

// Runs the release script with the two tags, the app, the version and the date.
app.post('/api/release', async req => {
  const body = req.body || {};
  process.env.CONFLUENCE_TOKEN = tokenFrom(body);
  const version = text(body.version);
  const date = text(body.date);
  if (!version || version.length > 50) throw new HttpError(400, 'Version is required (max 50 characters)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');

  const { app: appName, from, to } = body;
  const tags = git.listTags(appName); // also checks the app
  if (!tags.includes(from) || !tags.includes(to)) throw new HttpError(400, `Pick two tags that belong to ${appName}`);

  const output = await runReleaseScript({ from, to, app: appName, version, date });
  return { ok: true, output };
});

// ── Start ──────────────────────────────────────────────────────────────────

async function start() {
  // A token saved in .env is ready for the release script from the start.
  const saved = storage.readToken();
  if (saved) process.env.CONFLUENCE_TOKEN = saved;
  if (config.fake) await require('./fake').start(config);
  if (!config.confluenceBaseUrl) console.warn(`[warn] No confluenceBaseUrl for "${config.name}" in config.json`);
  app.listen(config.port, config.host, () => {
    console.log(`Server running at http://localhost:${config.port}/ (${config.name}: ${config.confluenceBaseUrl})`);
  });
}

start();
