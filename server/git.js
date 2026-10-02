const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('./config');

const SEP = '\x1f'; // between fields
const END = '\x1e'; // between commits

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// Monorepo root: repoRoot from config.json, otherwise the repo this server lives in.
let rootPromise;
function repoRoot() {
  rootPromise ??= config.repoRoot
    ? Promise.resolve(config.repoRoot)
    : git(['rev-parse', '--show-toplevel'], __dirname).then(s => s.trim());
  return rootPromise;
}

// "*-app" → /^.*-app$/ (only * is special).
function globToRegExp(glob) {
  return new RegExp('^' + glob.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
const APP_RE = globToRegExp(config.appPattern);

// Apps = top-level folders of the repo whose name matches appPattern
// (minus dot-folders, node_modules and the folder this tool lives in).
async function listApps() {
  const root = await repoRoot();
  const ownFolder = path.relative(root, __dirname).split(path.sep)[0];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && APP_RE.test(d.name))
    .filter(d => !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== ownFolder)
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b));
}

async function isApp(app) {
  return typeof app === 'string' && (await listApps()).includes(app);
}

// Git commands run inside the app's folder (like `cd <app> && git ...`).
// Only call with names that passed isApp().
async function appDir(app) {
  return path.join(await repoRoot(), app);
}

// Tags named <app>-<number>-OLD / <app>-<number>-NEW, newest number first.
async function listTags(app) {
  const out = await git(['tag', '--list', `${app}-*`], await appDir(app));
  const re = new RegExp(`^${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)-(OLD|NEW)$`);
  return out.split('\n')
    .map(t => t.trim())
    .map(name => { const m = re.exec(name); return m && { name, number: Number(m[1]), kind: m[2] }; })
    .filter(Boolean)
    .sort((a, b) => b.number - a.number || a.kind.localeCompare(b.kind));
}

// Merge commits: GitHub/Bitbucket put the PR title in the body, GitLab too.
// Squash/direct commits: the subject is the title.
function prTitle(subject, body, isMerge) {
  if (isMerge) {
    const line = body.split('\n').map(s => s.trim()).find(Boolean);
    if (line) return line;
  }
  return subject;
}

function prNumber(subject) {
  const m = /pull request #(\d+)|\(#(\d+)\)\s*$|See merge request [^!]*!(\d+)/.exec(subject);
  return m ? Number(m[1] || m[2] || m[3]) : null;
}

// Mainline commits between two tags that touched the app folder ("-- ." from inside it).
// --first-parent keeps one row per merged PR instead of every commit inside it.
async function listChanges(app, from, to) {
  const cwd = await appDir(app);
  const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%b'].join(SEP) + END;
  const out = await git(['log', '--first-parent', `--format=${fmt}`, `${from}..${to}`, '--', '.'], cwd);

  const rows = out.split(END).map(s => s.replace(/^\n/, '')).filter(Boolean).map(rec => {
    const [hash, parents, author, email, date, subject, body = ''] = rec.split(SEP);
    const parentList = parents.split(' ').filter(Boolean);
    const isMerge = parentList.length > 1;
    return {
      hash, isMerge, author, email, date,
      // For merges, the PR author is whoever wrote the merged branch's tip, not the person who clicked merge.
      prHead: isMerge ? parentList[1] : null,
      title: prTitle(subject, body, isMerge).replace(/\s*\(#\d+\)\s*$/, ''),
      pr: prNumber(subject + '\n' + body),
    };
  });

  await Promise.all(rows.filter(r => r.prHead).map(async r => {
    const a = await git(['log', '-1', `--format=%an${SEP}%ae`, r.prHead], cwd);
    [r.author, r.email] = a.trim().split(SEP);
  }));

  return rows.map(({ prHead, ...r }) => r);
}

module.exports = { listApps, isApp, listTags, listChanges };
