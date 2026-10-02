// Reads apps, tags and changes from git.
// Every git command runs inside the app's folder, like `cd web-app && git ...`.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('./config');
const { HttpError } = require('./web');

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: 'pipe' });
  } catch (err) {
    const reason = String(err.stderr || err.message).trim().split('\n')[0];
    throw new HttpError(500, `git failed: ${reason}`);
  }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// appPattern "*-app" → /^.*-app$/  (only * is special)
const APP_NAME = new RegExp('^' + config.appPattern.split('*').map(escapeRegExp).join('.*') + '$');

let root;
function repoRoot() {
  root ??= config.repoRoot || git(['rev-parse', '--show-toplevel'], __dirname).trim();
  return root;
}

// Top-level folders whose name matches appPattern.
// Never hidden folders, node_modules, or the folder this tool lives in.
function listApps() {
  const ownFolder = path.relative(repoRoot(), __dirname).split(path.sep)[0];
  return fs.readdirSync(repoRoot(), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => APP_NAME.test(name) && !name.startsWith('.') && name !== 'node_modules' && name !== ownFolder)
    .sort();
}

// Unknown app names are refused here, so nothing else reaches git.
function appFolder(app) {
  if (!listApps().includes(app)) throw new HttpError(404, `Unknown app "${app}"`);
  return path.join(repoRoot(), app);
}

// The app's <app>-<number>-OLD / <app>-<number>-NEW tags, highest number first.
function listTags(app) {
  const tagName = new RegExp(`^${escapeRegExp(app)}-(\\d+)-(OLD|NEW)$`);
  const number = tag => Number(tagName.exec(tag)[1]);
  return git(['tag', '--list', `${app}-*`], appFolder(app))
    .split('\n')
    .map(tag => tag.trim())
    .filter(tag => tagName.test(tag))
    .sort((a, b) => number(b) - number(a) || a.localeCompare(b));
}

// Merge commits keep the PR title on the first line of the body (GitHub, GitLab, Bitbucket).
// Squash and direct commits use the subject. A trailing "(#123)" is dropped: the number is kept separately.
function prTitle(subject, body, isMerge) {
  const firstBodyLine = body.split('\n').map(line => line.trim()).find(Boolean);
  return ((isMerge && firstBodyLine) || subject).replace(/\s*\(#\d+\)\s*$/, '');
}

function prNumber(message) {
  const m = /pull request #(\d+)|\(#(\d+)\)\s*$|See merge request [^!]*!(\d+)/.exec(message);
  return m ? Number(m[1] || m[2] || m[3]) : null;
}

const FIELD = '\x1f';  // separates fields in the git log output
const COMMIT = '\x1e'; // separates commits

// The changes between two of the app's tags that touched its folder, one row per merged PR:
//   git log --first-parent <from>..<to> -- .
function listChanges(app, from, to) {
  const tags = listTags(app);
  if (!tags.includes(from) || !tags.includes(to)) throw new HttpError(400, `Pick two tags that belong to ${app}`);

  const folder = appFolder(app);
  const format = ['%P', '%an', '%s', '%b'].join(FIELD) + COMMIT;
  const log = git(['log', '--first-parent', `--format=${format}`, `${from}..${to}`, '--', '.'], folder);

  return log.split(COMMIT).map(commit => commit.trim()).filter(Boolean).map(commit => {
    const [parents, author, subject, body] = commit.split(FIELD);
    // A merge commit's second parent is the merged branch. Its author wrote the PR;
    // the merge commit's own author only clicked "merge".
    const mergedBranch = parents.split(' ')[1];
    return {
      author: mergedBranch ? git(['log', '-1', '--format=%an', mergedBranch], folder).trim() : author,
      title: prTitle(subject, body, Boolean(mergedBranch)),
      pr: prNumber(subject + '\n' + body),
    };
  });
}

module.exports = { listApps, listTags, listChanges };
