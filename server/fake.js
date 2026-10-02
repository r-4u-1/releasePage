// The fake environment for `node server.js --fake`:
//   • a fake monorepo with app-a and app-b, their commits and OLD/NEW tags
//   • a fake Confluence that answers the few REST calls the server makes
// Paths come from the "fake" entry in config.json. Add --reset to rebuild the fake data.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp, HttpError } = require('./web');

const TOKEN = 'demo-token';

const PARENT_PAGES = {
  100001: { title: 'App A releases', space: 'APPA' },
  100002: { title: 'App B releases', space: 'APPB' },
};
const SAVED_PARENTS = { 'app-a': '100001', 'app-b': '100002' };

// ── Fake monorepo ──────────────────────────────────────────────────────────

function createRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });

  const git = (author, ...args) => execFileSync('git', [
    '-c', `user.name=${author}`, '-c', `user.email=${author.toLowerCase()}@example.com`, ...args,
  ], { cwd: repo, stdio: 'pipe' });

  const commit = (author, file, message) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.appendFileSync(path.join(repo, file), message + '\n');
    git(author, 'add', '-A');
    git(author, 'commit', '-q', '-m', message);
  };

  // A PR merged with a merge commit, like GitHub's "Create a merge commit".
  const mergePr = (author, merger, number, branch, file, title) => {
    git(author, 'checkout', '-q', '-b', branch);
    commit(author, file, `wip: ${title}`);
    commit(author, file, `review fixes: ${title}`);
    git(author, 'checkout', '-q', 'main');
    git(merger, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${number} from org/${branch}`, '-m', title);
  };

  const tag = name => git('Release Bot', 'tag', name);

  git('Release Bot', 'init', '-q', '-b', 'main');
  commit('Release Bot', 'app-a/index.js', 'Initial app-a');
  commit('Release Bot', 'app-b/index.js', 'Initial app-b');
  tag('app-a-1-OLD');
  tag('app-b-1-OLD');

  mergePr('Alice', 'Bob', 101, 'feat/menu-keyboard', 'app-a/menu.js', 'Add keyboard navigation to the main menu');
  commit('Bob', 'app-a/button.css', 'Fix colour contrast on primary buttons (#102)');
  mergePr('Dave', 'Erin', 103, 'feat/icon-labels', 'app-b/icons.js', 'Add aria-labels to icon-only buttons');
  commit('Carol', 'app-a/package.json', 'Update dependencies');
  commit('Erin', 'app-b/search.js', 'Speed up search results when the list is very long and the user types quickly (#104)');
  tag('app-a-1-NEW');
  tag('app-b-1-NEW');

  tag('app-a-2-OLD');
  mergePr('Frank', 'Alice', 105, 'feat/date-picker', 'app-a/date.js', 'New date picker with screen reader announcements');
  commit('Alice', 'app-a/form.js', 'Show validation errors next to each field (#106)');
  commit('Dave', 'app-b/api.js', 'Retry failed API calls (#107)');
  tag('app-a-2-NEW');
}

// ── Fake Confluence ────────────────────────────────────────────────────────

function fakeConfluence(baseUrl) {
  const app = createApp({ bodyLimit: 5 * 1024 * 1024 });
  const pages = new Map(); // "SPACE/title" → created page

  const checkToken = req => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) throw new HttpError(401, 'Unauthorized');
  };

  app.get('/rest/api/user/current', req => {
    checkToken(req);
    return { type: 'known', displayName: 'Demo User' };
  });

  app.get('/rest/api/content/:id', req => {
    checkToken(req);
    const parent = PARENT_PAGES[req.params.id];
    if (!parent) throw new HttpError(404, `No content found with id ${req.params.id}`);
    return { id: req.params.id, title: parent.title, space: { key: parent.space } };
  });

  app.post('/rest/api/content', req => {
    checkToken(req);
    const { title, space, ancestors, body } = req.body;
    const key = `${space.key}/${title}`;
    if (pages.has(key)) throw new HttpError(400, `A page with this title already exists: ${title}`);
    const id = String(200001 + pages.size);
    pages.set(key, { title, parentId: ancestors[0].id, html: body.storage.value });
    console.log(`[fake confluence] created "${title}" under ${ancestors[0].id}`);
    return { id, title, _links: { base: baseUrl, webui: `/display/${space.key}/${encodeURIComponent(title)}` } };
  });

  // A rough preview of a created page, with the checkbox macros shown as checkboxes.
  app.get('/display/:space/:title', (req, res) => {
    const page = pages.get(`${req.params.space}/${req.params.title}`);
    if (!page) {
      res.statusCode = 404;
      return 'Page not found (the fake Confluence forgets its pages when it restarts).';
    }
    const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parentTitle = PARENT_PAGES[page.parentId]?.title ?? page.parentId;
    const content = page.html.replace(/<ac:task-list>[\s\S]*?<\/ac:task-list>/g, '<input type="checkbox">');
    return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(page.title)}</title>
<style>
  body { font: 15px system-ui; margin: 2rem; max-width: 60rem; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: .4rem .7rem; text-align: left; }
  th { background: #f4f5f7; }
</style>
<p style="color:#666">Fake Confluence · ${escapeHtml(parentTitle)} ›</p>
<h1>${escapeHtml(page.title)}</h1>
${content}`;
  });

  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────

async function start({ repoRoot, parentsFile, envFile, confluenceBaseUrl }) {
  if (process.argv.includes('--reset')) {
    for (const file of [repoRoot, parentsFile, envFile]) fs.rmSync(file, { recursive: true, force: true });
  }
  if (!fs.existsSync(repoRoot)) {
    console.log('[fake] creating fake monorepo with app-a and app-b…');
    createRepo(repoRoot);
  }
  fs.mkdirSync(path.dirname(parentsFile), { recursive: true });
  if (!fs.existsSync(parentsFile)) {
    fs.writeFileSync(parentsFile, JSON.stringify(SAVED_PARENTS, null, 2) + '\n');
  }
  // An empty .env, so saving the token can be tried out too.
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, '# Fake environment — the fake token gets saved here\n');
  }

  const port = Number(new URL(confluenceBaseUrl).port);
  await new Promise((resolve, reject) => {
    fakeConfluence(confluenceBaseUrl).listen(port, resolve).on('error', reject);
  });
  console.log(`[fake] fake Confluence on ${confluenceBaseUrl} — token: ${TOKEN}`);
}

module.exports = { start };
