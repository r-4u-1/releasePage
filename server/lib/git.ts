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
  return execSync(`git ${command}`, { cwd: folder, encoding: 'utf8' });
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

// The "Merged PR" commits on the main line between the two tags that changed the app's folder, newest first.
export function listMergedPullRequests(repo: string, app: string, from: string, to: string): PullRequest[] {
  const output = runGit(`log --first-parent --grep="Merged PR" --format="%an|%s" ${from}..${to} -- ${app}`, repo);

  return output.split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('|');
    return {
      author: line.slice(0, separator),
      // "Merged PR 1234: Add keyboard navigation" → "Add keyboard navigation"
      title: line.slice(separator + 1).replace(/^Merged PR \d+:\s*/, ''),
    };
  });
}
