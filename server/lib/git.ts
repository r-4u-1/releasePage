// Git: the apps (top-level folders), their release tags, and the PRs merged between two tags.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { config } from './settings.ts';

// One merged PR on the release page.
export interface PullRequest {
  title: string;
  author: string;
}

// Runs a git command in the given folder and returns what it printed.
function runGit(command: string, folder: string): string {
  return execSync(`git ${command}`, { cwd: folder, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

// The monorepo's root folder, from the path typed in the form.
// A folder inside the monorepo works too: C:\git\monorepo\web-app → C:\git\monorepo.
export function findRepo(folder: string): string {
  return path.resolve(runGit('rev-parse --show-toplevel', folder).trim());
}

// appPattern as a regular expression: "*-app" → /^.*-app$/
const APP_NAME_PATTERN = new RegExp('^' + config.appPattern.replaceAll('*', '.*') + '$');

// The app names: top-level folders of the monorepo that match appPattern.
export function listApps(repo: string): string[] {
  return fs.readdirSync(repo, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && APP_NAME_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

// The app's release tags, highest number first, e.g.
//   web-app-12-NEW, web-app-12-OLD, web-app-11-NEW, ...
export function listTags(repo: string, app: string): string[] {
  const tagNumber = (tag: string) => Number(tag.split('-').at(-2)); // "web-app-12-NEW" → 12

  return runGit(`tag --list "${app}-*-OLD" "${app}-*-NEW"`, repo)
    .split('\n')
    .map(tag => tag.trim())
    .filter(Boolean)
    .sort((a, b) => tagNumber(b) - tagNumber(a) || a.localeCompare(b));
}

// git prints one line per commit. Between the fields of a line it puts this invisible
// "unit separator" character, which never appears in names or commit messages.
const FIELD_SEPARATOR = '\x1f';

// The PRs merged into the app between the two tags, newest first:
//   [{ title: 'Add keyboard navigation', author: 'Alice' }, ...]
// A merged PR is a commit whose message contains "Merged PR", e.g. "Merged PR 1234: Add keyboard navigation".
export function listMergedPullRequests(repo: string, app: string, from: string, to: string): PullRequest[] {
  // --first-parent: only the commits made on the main line, not the commits inside each PR.
  // The format is hash, parent hashes, author, subject, separated by FIELD_SEPARATOR.
  const output = runGit(
    `log --first-parent --grep="Merged PR" --format="%H%x1f%P%x1f%an%x1f%s" ${from}..${to} -- ${app}`,
    repo,
  );

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

  const authors = authorsOfCommits(repo, commits.map(commit => commit.prBranchTip).filter(hash => hash !== undefined));

  // The person who opened the PR: the author of the PR branch's last commit.
  // For a squashed PR there's no branch left, so it's the author of the squashed commit.
  return commits.map(commit => ({
    title: commit.title,
    author: (commit.prBranchTip && authors[commit.prBranchTip]) || commit.mergedBy,
  }));
}

// The author of each commit, in one git call: { '<hash>': 'Alice', ... }
function authorsOfCommits(repo: string, hashes: string[]): Record<string, string> {
  if (hashes.length === 0) return {};

  const output = runGit(`show --no-patch --format="%H%x1f%an" ${hashes.join(' ')}`, repo);
  const authors: Record<string, string> = {};
  for (const line of output.split('\n').filter(Boolean)) {
    const [hash, author] = line.split(FIELD_SEPARATOR);
    authors[hash] = author;
  }
  return authors;
}
