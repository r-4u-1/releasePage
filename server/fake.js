// The fake environment for `node server.js --fake`:
//   • a fake monorepo with app-a and app-b, their commits and OLD/NEW tags
//   • a fake Confluence that accepts any token (the token check is all the server asks it)
//   • fake-release.sh stands in for the real release script
// Paths come from the "fake" entry in config.json. Add --reset to rebuild the fake data.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('./web');

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
// Accepts any token and prints it.

function fakeConfluence() {
  const app = createApp();
  app.get('/rest/api/user/current', req => {
    console.log('[fake confluence] token:', req.headers.authorization);
    return {};
  });
  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────

async function start({ repoRoot, envFile, confluenceBaseUrl }) {
  if (process.argv.includes('--reset')) {
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
  }
  if (!fs.existsSync(repoRoot)) {
    console.log('[fake] creating fake monorepo with app-a and app-b…');
    createRepo(repoRoot);
  }
  // An empty .env, so saving the token can be tried out too.
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, '# Fake environment — the fake token gets saved here\n');
  }

  const port = Number(new URL(confluenceBaseUrl).port);
  await new Promise((resolve, reject) => {
    fakeConfluence().listen(port, resolve).on('error', reject);
  });
  console.log(`[fake] fake Confluence on ${confluenceBaseUrl} — any token works`);
}

module.exports = { start };
