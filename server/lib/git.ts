import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, SERVER_DIR } from './settings.ts';
import { fail, escapeForRegExp } from './helpers.ts';

export interface PullRequest {
  title: string;
  author: string;
}

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

const REPO_ROOT = config.repoRoot
  ? path.resolve(SERVER_DIR, config.repoRoot)
  : runGit(['rev-parse', '--show-toplevel'], SERVER_DIR).trim();

const OWN_FOLDER = path.relative(REPO_ROOT, SERVER_DIR).split(path.sep)[0];

const APP_NAME_PATTERN = new RegExp(
  '^' + config.appPattern.split('*').map(escapeForRegExp).join('.*') + '$'
);

export function listApps(): string[] {
  const folders = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  return folders
    .filter(name => APP_NAME_PATTERN.test(name))
    .filter(name => !name.startsWith('.') && name !== 'node_modules' && name !== OWN_FOLDER)
    .sort();
}

export function listTags(app: string): string[] {
  if (!listApps().includes(app)) {
    fail(404, `Unknown app "${app}"`);
  }

  const tagPattern = new RegExp(`^${escapeForRegExp(app)}-(\\d+)-(OLD|NEW)$`);
  const tagNumber = (tag: string) => Number(tagPattern.exec(tag)![1]);

  const allTags = runGit(['tag', '--list', `${app}-*`], path.join(REPO_ROOT, app))
    .split('\n')
    .map(tag => tag.trim());

  return allTags
    .filter(tag => tagPattern.test(tag))
    .sort((a, b) => tagNumber(b) - tagNumber(a) || a.localeCompare(b));
}

const FIELD_SEPARATOR = '\x1f';

export function listMergedPullRequests(app: string, fromTag: string, toTag: string): PullRequest[] {
  const output = runGit([
    'log',
    '--first-parent',
    '--grep=Merged PR',
    '--format=%H%x1f%P%x1f%an%x1f%s',
    `${fromTag}..${toTag}`,
    '--',
    '.',
  ], path.join(REPO_ROOT, app));

  const commits = output.split('\n').filter(Boolean).map(line => {
    const [hash, parents, mergedBy, subject] = line.split(FIELD_SEPARATOR);
    return {
      hash,
      prBranchTip: parents.split(' ')[1] as string | undefined,
      mergedBy,
      title: subject.replace(/^Merged PR \d+:\s*/, ''),
    };
  });

  const authors = authorsOfCommits(commits.map(commit => commit.prBranchTip).filter(hash => hash !== undefined));

  return commits.map(commit => ({
    title: commit.title,
    author: (commit.prBranchTip && authors[commit.prBranchTip]) || commit.mergedBy,
  }));
}

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
