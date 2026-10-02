const { createApp } = require('./web');
const config = require('./config');
const git = require('./git');
const { readParents, saveParent } = require('./parents');
const { pageTitle, buildBody } = require('./releasePage');
const envFile = require('./envFile');

const BASE_URL = config.confluenceBaseUrl;
const EMAIL = config.confluenceEmail;
const TIMEOUT_MS = 10_000;

if (!BASE_URL) {
  console.warn(`[warn] confluenceBaseUrl is not set for "${config.name}" in config.json — Confluence calls will fail.`);
}

const app = createApp({ bodyLimit: 100 * 1024 });

// Only accept requests addressed to this server from its own page.
// Stops other websites (and DNS-rebinding tricks) from using the saved token.
const ALLOWED_HOSTS = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(req.headers.host) || (origin && origin !== `http://${req.headers.host}`)) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }
  next();
});

// Serve only the form page (not the whole monorepo), so the page and API share an origin (no CORS).
app.get('/', (req, res) => res.sendFile(config.pageFile));

// ── Confluence helpers ─────────────────────────────────────────────────────

function authHeader(token) {
  return EMAIL
    ? 'Basic ' + Buffer.from(`${EMAIL}:${token}`).toString('base64')
    : 'Bearer ' + token;
}

// Builds a URL on the Confluence host from a user-supplied path.
// Rejects anything that would point at a different host.
function confluenceUrl(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return null;
  try {
    const url = new URL(BASE_URL + p);
    return url.origin === new URL(BASE_URL).origin ? url : null;
  } catch {
    return null;
  }
}

async function confluenceGet(url, token) {
  return fetch(url, {
    headers: { Authorization: authHeader(token), Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function confluencePost(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(token),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Atlassian-Token': 'no-check', // skips Confluence's XSRF check for REST writes
    },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Confluence error bodies carry a readable "message" (e.g. a duplicate page title).
async function confluenceError(r) {
  const body = await r.json().catch(() => ({}));
  return body.message || statusMessage(r.status);
}

function statusMessage(status) {
  if (status === 401) return 'Token rejected by Confluence';
  if (status === 403) return 'Token has no access to this resource';
  if (status === 404) return 'Not found on Confluence';
  return `Confluence responded with HTTP ${status}`;
}

// The token from the request, or the one saved in .env when the page sends none.
function requireToken(req, res) {
  const t = req.body?.token;
  if (typeof t === 'string' && t.trim()) return t.trim();
  const saved = envFile.readToken();
  if (saved) return saved;
  res.status(400).json({ ok: false, message: 'Token is required' });
  return null;
}

function requireString(res, value, name) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  res.status(400).json({ ok: false, message: `${name} is required` });
  return null;
}

// ── Verify endpoints ───────────────────────────────────────────────────────

// Whether a token is saved, and whether a typed one can be saved. Never returns the token itself.
app.get('/api/token', (req, res) => {
  res.json({ ok: true, saved: !!envFile.readToken(), canSave: envFile.canSave() });
});

// Token is valid if Confluence tells us who it belongs to.
// With no token in the request, the saved one is checked. A typed token that passes is saved to .env.
app.post('/api/verify/token', async (req, res) => {
  const typed = typeof req.body?.token === 'string' && req.body.token.trim() !== '';
  const token = requireToken(req, res);
  if (!token) return;
  try {
    const r = await confluenceGet(confluenceUrl('/rest/api/user/current'), token);
    if (!r.ok) return res.json({ ok: false, message: statusMessage(r.status) });
    const user = await r.json();
    // Cloud returns anonymous for bad Basic creds in some setups
    if (user.type === 'anonymous') return res.json({ ok: false, message: 'Token rejected by Confluence' });
    const saved = typed ? envFile.saveToken(token) : true;
    if (typed && saved) console.log(`[token] saved to ${envFile.FILE}`);
    res.json({ ok: true, message: `Authenticated as ${user.displayName || user.username || 'user'}`, saved });
  } catch (err) {
    console.error('[verify/token]', err.message);
    res.status(502).json({ ok: false, message: 'Could not reach Confluence' });
  }
});

// Page ID is valid if the token can read that page (it becomes the parent of the release page).
app.post('/api/verify/page', async (req, res) => {
  const token = requireToken(req, res);
  if (!token) return;
  const pageId = requireString(res, req.body?.pageId, 'Page ID');
  if (!pageId) return;
  if (!/^\d+$/.test(pageId)) return res.json({ ok: false, message: 'Page ID must be a number' });
  try {
    const r = await confluenceGet(confluenceUrl(`/rest/api/content/${pageId}`), token);
    if (!r.ok) return res.json({ ok: false, message: statusMessage(r.status) });
    const page = await r.json();
    res.json({ ok: true, message: `Parent page: ${page.title}`, title: page.title });
  } catch (err) {
    console.error('[verify/page]', err.message);
    res.status(502).json({ ok: false, message: 'Could not reach Confluence' });
  }
});

// ── Git endpoints ──────────────────────────────────────────────────────────

app.get('/api/apps', async (req, res) => {
  try {
    const saved = readParents();
    const apps = (await git.listApps()).map(name => ({ name, parentId: saved[name] || null }));
    res.json({ ok: true, apps });
  } catch (err) {
    console.error('[apps]', err.message);
    res.status(500).json({ ok: false, message: 'Could not read the repo' });
  }
});

app.get('/api/apps/:app/tags', async (req, res) => {
  const { app: name } = req.params;
  if (!(await git.isApp(name))) return res.status(404).json({ ok: false, message: `Unknown app "${name}"` });
  try {
    res.json({ ok: true, tags: await git.listTags(name) });
  } catch (err) {
    console.error('[tags]', err.message);
    res.status(500).json({ ok: false, message: 'Could not read git tags' });
  }
});

app.get('/api/apps/:app/changes', async (req, res) => {
  const { app: name } = req.params;
  const { from, to } = req.query;
  if (!(await git.isApp(name))) return res.status(404).json({ ok: false, message: `Unknown app "${name}"` });
  // Only accept tags that belong to this app, so nothing else reaches the git command line.
  const tags = (await git.listTags(name)).map(t => t.name);
  if (!tags.includes(from) || !tags.includes(to)) {
    return res.status(400).json({ ok: false, message: `Pick two tags that belong to ${name}` });
  }
  try {
    res.json({ ok: true, changes: await git.listChanges(name, from, to) });
  } catch (err) {
    console.error('[changes]', err.message);
    res.status(500).json({ ok: false, message: 'Could not read the git log' });
  }
});

// ── Create release page ────────────────────────────────────────────────────

// Reads the changes between the two tags and creates "Release <version> <date>"
// as a child of the parent page. On success the parent is saved for the app.
app.post('/api/release', async (req, res) => {
  const b = req.body || {};
  const bad = message => res.status(400).json({ ok: false, message });

  const token = requireToken(req, res);
  if (!token) return;
  if (!(await git.isApp(b.app))) return bad('Unknown app');
  if (typeof b.pageId !== 'string' || !/^\d+$/.test(b.pageId)) return bad('Parent page ID must be a number');
  const version = typeof b.version === 'string' ? b.version.trim() : '';
  if (!version || version.length > 50) return bad('Version is required (max 50 characters)');
  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return bad('Date must be YYYY-MM-DD');
  const tags = (await git.listTags(b.app)).map(t => t.name);
  if (!tags.includes(b.from) || !tags.includes(b.to)) return bad(`Pick two tags that belong to ${b.app}`);

  let changes;
  try {
    changes = await git.listChanges(b.app, b.from, b.to);
  } catch (err) {
    console.error('[release] git:', err.message);
    return res.status(500).json({ ok: false, message: 'Could not read the git log' });
  }

  try {
    // The new page must be created in the parent's space.
    const pr = await confluenceGet(confluenceUrl(`/rest/api/content/${b.pageId}?expand=space`), token);
    if (!pr.ok) return res.json({ ok: false, message: 'Parent page: ' + await confluenceError(pr) });
    const parent = await pr.json();

    const title = pageTitle(version, b.date);
    const cr = await confluencePost(confluenceUrl('/rest/api/content'), token, {
      type: 'page',
      title,
      space: { key: parent.space.key },
      ancestors: [{ id: b.pageId }],
      body: { storage: { value: buildBody({ app: b.app, from: b.from, to: b.to, date: b.date, changes }), representation: 'storage' } },
    });
    if (!cr.ok) return res.json({ ok: false, message: await confluenceError(cr) });
    const page = await cr.json();

    saveParent(b.app, b.pageId);
    const url = (page._links?.base || BASE_URL) + (page._links?.webui || `/pages/viewpage.action?pageId=${page.id}`);
    console.log(`[release] created "${title}" (${changes.length} changes) under ${b.pageId}`);
    res.json({ ok: true, title, url, id: page.id, changes: changes.length });
  } catch (err) {
    console.error('[release] confluence:', err.message);
    res.status(502).json({ ok: false, message: 'Could not reach Confluence' });
  }
});

async function start() {
  // Fake environments get a fake monorepo and a fake Confluence before the server starts.
  if (config.fake) await require('./fake').start(config);
  app.listen(config.port, config.host, () => {
    console.log(`Server running at http://localhost:${config.port}/ (${config.name}: ${BASE_URL || 'no Confluence URL'})`);
  });
}

start();
