// The web server: serves the form (public/) and the API the form calls.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { createApp, HttpError, sendFile } = require('./web');
const git = require('./git');
const confluence = require('./confluence');
const storage = require('./storage');

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

// The token typed in the form, or else the one saved in .env.
function tokenFrom(body) {
  const token = text(body?.token) || storage.readToken();
  if (!token) throw new HttpError(400, 'Token is required');
  return token;
}

function pageIdFrom(body) {
  const pageId = text(body?.pageId);
  if (!/^\d+$/.test(pageId)) throw new HttpError(400, 'Page ID must be a number');
  return pageId;
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
// A typed token that works is saved to .env.
app.post('/api/verify/token', async req => {
  const typed = text(req.body?.token);
  const user = await confluence.currentUser(tokenFrom(req.body));
  const saved = typed ? storage.saveToken(typed) : true;
  if (typed && saved) console.log(`[token] saved to ${config.envFile}`);
  return { ok: true, message: `Authenticated as ${user}`, saved };
});

// ── Parent page ────────────────────────────────────────────────────────────

// The parent page is fine if the token can open it.
app.post('/api/verify/page', async req => {
  const page = await confluence.getPage(pageIdFrom(req.body), tokenFrom(req.body));
  return { ok: true, title: page.title };
});

// ── Apps, tags, changes ────────────────────────────────────────────────────

app.get('/api/apps', () => {
  const parents = storage.readParents();
  const apps = git.listApps().map(name => ({ name, parentId: parents[name] || null }));
  return { ok: true, apps };
});

app.get('/api/apps/:app/tags', req => ({
  ok: true,
  tags: git.listTags(req.params.app),
}));

app.get('/api/apps/:app/changes', req => ({
  ok: true,
  changes: git.listChanges(req.params.app, req.query.from, req.query.to),
}));

// ── Create the release page ────────────────────────────────────────────────

// Reads the changes between the two tags (again, so the page always matches them),
// creates the page under the parent, and remembers the parent for the app.
app.post('/api/release', async req => {
  const body = req.body || {};
  const token = tokenFrom(body);
  const pageId = pageIdFrom(body);
  const version = text(body.version);
  const date = text(body.date);
  if (!version || version.length > 50) throw new HttpError(400, 'Version is required (max 50 characters)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');

  const { app: appName, from, to } = body;
  const changes = git.listChanges(appName, from, to); // also checks the app and the tags
  const parent = await confluence.getPage(pageId, token);
  const page = await confluence.createReleasePage({ token, parent, version, date, app: appName, from, to, changes });

  storage.saveParent(appName, pageId);
  console.log(`[release] created "${page.title}" (${changes.length} changes) under ${pageId}`);
  return { ok: true, ...page, changes: changes.length };
});

// ── Start ──────────────────────────────────────────────────────────────────

async function start() {
  if (config.fake) await require('./fake').start(config);
  if (!config.confluenceBaseUrl) console.warn(`[warn] No confluenceBaseUrl for "${config.name}" in config.json`);
  app.listen(config.port, config.host, () => {
    console.log(`Server running at http://localhost:${config.port}/ (${config.name}: ${config.confluenceBaseUrl})`);
  });
}

start();
