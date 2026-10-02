// Fake environment: a fake monorepo (app-a, app-b) and a fake Confluence, used with `node server.js --fake`.
// Paths and the fake Confluence URL come from the "fake" entry in config.json.
// Add --reset to rebuild the fake data. Token for the fake Confluence: demo-token
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../web');

const TOKEN = 'demo-token';

// Fake parent pages, one per fake app.
const PARENT_PAGES = {
  '100001': { title: 'App A releases', space: 'APPA' },
  '100002': { title: 'App B releases', space: 'APPB' },
};
const FAKE_PARENTS = { 'app-a': '100001', 'app-b': '100002' };

// ── Fake monorepo ──────────────────────────────────────────────────────────

function createRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  const run = (author, ...args) => execFileSync('git', ['-c', `user.name=${author}`, '-c', `user.email=${author.toLowerCase()}@example.com`, ...args], { cwd: repo, stdio: 'pipe' });
  const write = (file, line) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.appendFileSync(path.join(repo, file), line + '\n'); };
  const commit = (author, file, msg) => { write(file, msg); run(author, 'add', '-A'); run(author, 'commit', '-q', '-m', msg); };
  // A PR merged with a merge commit, the way GitHub's "Create a merge commit" does it.
  const mergePr = (author, merger, n, branch, file, title) => {
    run(author, 'checkout', '-q', '-b', branch);
    commit(author, file, `wip: ${title}`);
    commit(author, file, `review fixes: ${title}`);
    run(author, 'checkout', '-q', 'main');
    run(merger, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from org/${branch}`, '-m', title);
  };
  const tag = name => run('Release Bot', 'tag', name);

  run('Release Bot', 'init', '-q', '-b', 'main');
  commit('Release Bot', 'app-a/index.js', 'Initial app-a');
  commit('Release Bot', 'app-b/index.js', 'Initial app-b');
  tag('app-a-1-OLD'); tag('app-b-1-OLD');

  mergePr('Alice', 'Bob', 101, 'feat/menu-keyboard', 'app-a/menu.js', 'Add keyboard navigation to the main menu');
  commit('Bob', 'app-a/button.css', 'Fix colour contrast on primary buttons (#102)');
  mergePr('Dave', 'Erin', 103, 'feat/icon-labels', 'app-b/icons.js', 'Add aria-labels to icon-only buttons');
  commit('Carol', 'app-a/package.json', 'Update dependencies');
  commit('Erin', 'app-b/search.js', 'Speed up search results when the list is very long and the user types quickly (#104)');
  tag('app-a-1-NEW'); tag('app-b-1-NEW');

  tag('app-a-2-OLD');
  mergePr('Frank', 'Alice', 105, 'feat/date-picker', 'app-a/date.js', 'New date picker with screen reader announcements');
  commit('Alice', 'app-a/form.js', 'Show validation errors next to each field (#106)');
  commit('Dave', 'app-b/api.js', 'Retry failed API calls (#107)');
  tag('app-a-2-NEW');
}

// ── Fake Confluence (Data Center REST API, only the calls the server makes) ──

function fakeConfluence(base) {
  const created = new Map(); // "SPACE/title" → page
  const app = createApp({ bodyLimit: 5 * 1024 * 1024 });

  const auth = (req, res, next) =>
    req.headers.authorization === `Bearer ${TOKEN}` ? next() : res.status(401).json({ message: 'Unauthorized' });

  app.get('/rest/api/user/current', auth, (req, res) => res.json({ type: 'known', displayName: 'Demo User' }));

  app.get('/rest/api/content/:id', auth, (req, res) => {
    const p = PARENT_PAGES[req.params.id];
    if (!p) return res.status(404).json({ message: `No content found with id ${req.params.id}` });
    res.json({ id: req.params.id, title: p.title, space: { key: p.space } });
  });

  app.post('/rest/api/content', auth, (req, res) => {
    const { title, space, ancestors, body } = req.body;
    const key = `${space.key}/${title}`;
    if (created.has(key)) return res.status(400).json({ message: `A page with this title already exists: ${title}` });
    const id = String(200000 + created.size + 1);
    const webui = `/display/${space.key}/${encodeURIComponent(title)}`;
    created.set(key, { id, title, parent: ancestors[0].id, html: body.storage.value });
    console.log(`[fake confluence] created "${title}" under ${ancestors[0].id}`);
    res.json({ id, title, _links: { base, webui } });
  });

  // Rough preview of a created page (checkbox macros shown as checkboxes).
  app.get('/display/:space/:title', (req, res) => {
    const page = created.get(`${req.params.space}/${req.params.title}`);
    if (!page) return res.status(404).send('Page not found (the fake Confluence forgets pages when it restarts).');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = page.html.replace(/<ac:task-list>[\s\S]*?<\/ac:task-list>/g, '<input type="checkbox">');
    res.send(`<!doctype html><meta charset="utf-8"><title>${esc(page.title)}</title>
<style>body{font:15px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.4rem .7rem;text-align:left}th{background:#f4f5f7}</style>
<p style="color:#666">Fake Confluence · ${esc(PARENT_PAGES[page.parent]?.title ?? page.parent)} › </p><h1>${esc(page.title)}</h1>${html}`);
  });

  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────

async function start(config) {
  const { repoRoot, parentsFile, envFile, confluenceBaseUrl } = config;
  if (!repoRoot) throw new Error('The fake environment needs a repoRoot in config.json');

  if (process.argv.includes('--reset')) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(parentsFile, { force: true });
    fs.rmSync(envFile, { force: true });
  }
  if (!fs.existsSync(repoRoot)) {
    console.log('[fake] creating fake monorepo with app-a and app-b…');
    createRepo(repoRoot);
  }
  if (!fs.existsSync(parentsFile)) {
    fs.mkdirSync(path.dirname(parentsFile), { recursive: true });
    fs.writeFileSync(parentsFile, JSON.stringify(FAKE_PARENTS, null, 2) + '\n');
  }

  // An empty .env, so saving the token can be tried out too.
  if (!fs.existsSync(envFile)) {
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, '# Fake environment — the fake token gets saved here\n');
  }

  const port = Number(new URL(confluenceBaseUrl).port) || 80;
  await new Promise((resolve, reject) => {
    fakeConfluence(confluenceBaseUrl).listen(port, resolve).on('error', reject);
  });
  console.log(`[fake] fake Confluence on ${confluenceBaseUrl} — token: ${TOKEN}`);
}

module.exports = { start };
