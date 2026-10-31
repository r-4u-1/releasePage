// Git: the apps (top-level folders), their release tags, and the PRs merged between two tags.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, SERVER_DIR } from './settings.ts';
import { fail, escapeForRegExp } from './helpers.ts';

// One merged PR on the release page.
export interface PullRequest {
  title: string;
  author: string;
}

// Runs a git command in the given folder and returns what it printed.
function runGit(args: string[], folder: string): string {
  try {
    return execFileSync('git', args, {
      cwd: folder,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === 'ENOENT') {
      fail(500, 'Git isn\'t installed, or isn\'t on the PATH. Install git and restart the server.');
    }
    const firstErrorLine = String(error.stderr || error.message).trim().split('\n')[0];
    fail(500, `"git ${args[0]}" failed in ${folder}: ${firstErrorLine}`);
  }
}

// The monorepo root: from config.json (relative to the server folder), or else the git repo this tool is inside.
const REPO_ROOT = config.repoRoot
  ? path.resolve(SERVER_DIR, config.repoRoot)
  : runGit(['rev-parse', '--show-toplevel'], SERVER_DIR).trim();

// The top-level folder this tool lives in, e.g. "release-page". It's never listed as an app.
const OWN_FOLDER = path.relative(REPO_ROOT, SERVER_DIR).split(path.sep)[0];

// appPattern as a regular expression. Only * is special and means "anything":
//   "*-app"  →  /^.*-app$/   matches "web-app" and "admin-app", but not "docs"
const APP_NAME_PATTERN = new RegExp(
  '^' + config.appPattern.split('*').map(escapeForRegExp).join('.*') + '$'
);

// The app names: top-level folders of the monorepo that match appPattern.
// Only matters for broad patterns like "*": hidden folders, node_modules and this tool's own folder are left out.
export function listApps(): string[] {
  const folders = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  return folders
    .filter(name => APP_NAME_PATTERN.test(name))
    .filter(name => !name.startsWith('.') && name !== 'node_modules' && name !== OWN_FOLDER)
    .sort();
}

// The app's release tags, highest number first, e.g.
//   web-app-12-NEW, web-app-12-OLD, web-app-11-NEW, ...
// Unknown app names are refused here, so they never reach git.
export function listTags(app: string): string[] {
  if (!listApps().includes(app)) {
    fail(404, `Unknown app "${app}"`);
  }

  // <app>-<number>-OLD or <app>-<number>-NEW. The number is captured as group 1.
  const tagPattern = new RegExp(`^${escapeForRegExp(app)}-(\\d+)-(OLD|NEW)$`);
  const tagNumber = (tag: string) => Number(tagPattern.exec(tag)![1]); // only called on tags that match

  const allTags = runGit(['tag', '--list', `${app}-*`], path.join(REPO_ROOT, app))
    .split('\n')
    .map(tag => tag.trim());

  return allTags
    .filter(tag => tagPattern.test(tag))
    .sort((a, b) => tagNumber(b) - tagNumber(a) || a.localeCompare(b)); // a, b: two tags being compared
}

// git prints one line per commit. Between the fields of a line it puts this invisible
// "unit separator" character, which never appears in names or commit messages.
const FIELD_SEPARATOR = '\x1f';

// The PRs merged into the app between the two tags, newest first:
//   [{ title: 'Add keyboard navigation', author: 'Alice' }, ...]
// A merged PR is a commit whose message contains "Merged PR", e.g. "Merged PR 1234: Add keyboard navigation".
export function listMergedPullRequests(app: string, fromTag: string, toTag: string): PullRequest[] {
  const output = runGit([
    'log',
    '--first-parent',                  // only the commits made on the main line, not the commits inside each PR
    '--grep=Merged PR',                // only commits whose message contains "Merged PR"
    '--format=%H%x1f%P%x1f%an%x1f%s',  // hash, parent hashes, author, subject — separated by FIELD_SEPARATOR
    `${fromTag}..${toTag}`,            // everything after fromTag, up to and including toTag
    '--',
    '.',                               // only commits that changed this app's folder (git runs inside it)
  ], path.join(REPO_ROOT, app));

  const commits = output.split('\n').filter(Boolean).map(line => {
    const [hash, parents, mergedBy, subject] = line.split(FIELD_SEPARATOR);
    return {
      hash,
      // A merge commit has two parents: [main line, last commit of the PR's branch].
      // A squashed PR is a single commit with one parent.
      prBranchTip: parents.split(' ')[1] as string | undefined,
      mergedBy,
      // "Merged PR 1234: Add keyboard navigation" → "Add keyboard navigation"
      title: subject.replace(/^Merged PR \d+:\s*/, ''),
    };
  });

  const authors = authorsOfCommits(commits.map(commit => commit.prBranchTip).filter(hash => hash !== undefined));

  // The person who opened the PR: the author of the PR branch's last commit.
  // For a squashed PR there's no branch left, so it's the author of the squashed commit.
  return commits.map(commit => ({
    title: commit.title,
    author: (commit.prBranchTip && authors[commit.prBranchTip]) || commit.mergedBy,
  }));
}

// The author of each commit, in one git call: { '<hash>': 'Alice', ... }
function authorsOfCommits(hashes: string[]): Record<string, string> {
  if (hashes.length === 0) return {};

  const output = runGit(['show', '--no-patch', '--format=%H%x1f%an', ...hashes], REPO_ROOT);
  const authors: Record<string, string> = {};
  for (const line of output.split('\n').filter(Boolean)) {
    const [hash, author] = line.split(FIELD_SEPARATOR);
    authors[hash] = author;
  }
  return authors;
}
