// Reads apps and tags from git.
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

module.exports = { repoRoot, listApps, listTags };
