// The base template for every app's release page, and the pieces it's made of.
// The content is in Confluence's "storage format":
// HTML plus Confluence's own <ac:...> tags for things like info boxes (macros) and column layouts.
import type { PullRequest } from '../git.ts';

export interface Release {
  app: string;
  version: string;
  date: string;
  from: string;
  to: string;
  pullRequests: PullRequest[];
}

// What an app's file exports: the release in, the page's content out.
export type ReleasePage = (release: Release) => string;

// What an app can change in the base template.
export interface PageOptions {
  extraColumns?: string[]; // more table columns after Author and Pull request, left empty for people to fill in
  sidebar?: string;        // content for a narrow column beside the table, e.g. an infoBox()
}

// The line above the table: version, release date, tags and number of PRs.
export function summary({ version, date, from, to, pullRequests }: Release): string {
  return `<p><strong>Version:</strong> ${version}`
    + ` · <strong>Release date:</strong> ${date}`
    + ` · <strong>Tags:</strong> ${from} → ${to}`
    + ` · <strong>Pull requests:</strong> ${pullRequests.length}</p>`;
}

// The table of PRs: Author and Pull request, then the extra columns, empty.
export function pullRequestTable(pullRequests: PullRequest[], extraColumns: string[] = []): string {
  const headers = ['Author', 'Pull request', ...extraColumns];
  const headerRow = '<tr>' + headers.map(header => `<th>${header}</th>`).join('') + '</tr>';

  const emptyCells = '<td></td>'.repeat(extraColumns.length);
  const rows = pullRequests.map(pullRequest =>
    `<tr><td>${pullRequest.author}</td><td>${pullRequest.title}</td>${emptyCells}</tr>`);

  return `<table><tbody>${headerRow}${rows.join('')}</tbody></table>`;
}

// Confluence's rounded "info" panel (a built-in macro) with a title and one paragraph.
export function infoBox(title: string, text: string): string {
  return '<ac:structured-macro ac:name="info">'
    + `<ac:parameter ac:name="title">${title}</ac:parameter>`
    + `<ac:rich-text-body><p>${text}</p></ac:rich-text-body>`
    + '</ac:structured-macro>';
}

// Two columns: "two_right_sidebar" is a wide one on the left and a narrow one on the right.
export function withSidebar(main: string, sidebar: string): string {
  return '<ac:layout><ac:layout-section ac:type="two_right_sidebar">'
    + `<ac:layout-cell>${main}</ac:layout-cell>`
    + `<ac:layout-cell>${sidebar}</ac:layout-cell>`
    + '</ac:layout-section></ac:layout>';
}

// The base template: the summary line and the PR table, with a sidebar beside them if there is one.
// Apps without their own file get this as it is.
export function basePage(release: Release, { extraColumns = [], sidebar }: PageOptions = {}): string {
  const main = summary(release) + pullRequestTable(release.pullRequests, extraColumns);
  return sidebar ? withSidebar(main, sidebar) : main;
}
