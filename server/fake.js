// The fake environment for `node server.js --fake`:
//   • a fake monorepo with app-a and app-b, their commits and OLD/NEW tags
//   • a fake Confluence that prints what it gets and writes created pages as HTML files
// Paths come from the "fake" entry in config.json. Add --reset to rebuild the fake data.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp, sendFile } = require('./web');

// Parent page IDs filled in for the fake apps. The fake Confluence accepts any ID.
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
// Accepts any token and any page ID and prints what it was given.
// A created page is written as an HTML file to pagesDir and served at /pages/<id>.html.

function fakeConfluence(baseUrl, pagesDir) {
  const app = createApp({ bodyLimit: 5 * 1024 * 1024 });

  app.get('/rest/api/user/current', req => {
    console.log('[fake confluence] token:', req.headers.authorization);
    return {};
  });

  app.get('/rest/api/content/:id', req => {
    console.log('[fake confluence] page id:', req.params.id);
    return { id: req.params.id, title: `Fake page ${req.params.id}`, space: { key: 'FAKE' } };
  });

  app.post('/rest/api/content', req => {
    const { title, body } = req.body;
    const id = String(Date.now());
    const file = path.join(pagesDir, `${id}.html`);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><h1>${title}</h1>
${body.storage.value}
`);
    console.log('[fake confluence] created page:', file);
    return { id, _links: { base: baseUrl, webui: `/pages/${id}.html` } };
  });

  app.get('/pages/:file', (req, res) => sendFile(res, path.join(pagesDir, path.basename(req.params.file))));

  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────

async function start({ repoRoot, parentsFile, envFile, confluenceBaseUrl }) {
  if (process.argv.includes('--reset')) {
    fs.rmSync(path.dirname(parentsFile), { recursive: true, force: true });
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

  const pagesDir = path.join(path.dirname(parentsFile), 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });

  const port = Number(new URL(confluenceBaseUrl).port);
  await new Promise((resolve, reject) => {
    fakeConfluence(confluenceBaseUrl, pagesDir).listen(port, resolve).on('error', reject);
  });
  console.log(`[fake] fake Confluence on ${confluenceBaseUrl} — any token works`);
}

module.exports = { start };
