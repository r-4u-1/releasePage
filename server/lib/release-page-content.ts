// The release page's content, in Confluence's "storage format":
// HTML plus Confluence's own <ac:...> tags for things like info boxes (macros) and column layouts.
import { config } from './settings';
import { escapeHtml } from './helpers';
import type { PullRequest } from './git';

export interface Release {
  app: string;
  version: string;
  date: string;
  from: string;
  to: string;
  pullRequests: PullRequest[];
}

// The table of PRs. Apps that need verification get two extra, empty columns for people to fill in: isVerified and Note.
function pullRequestTable(pullRequests: PullRequest[], withVerification: boolean): string {
  const headers = ['Author', 'Pull request'];
  if (withVerification) headers.push('isVerified', 'Note');

  const headerRow = '<tr>' + headers.map(header => `<th>${header}</th>`).join('') + '</tr>';

  const rows = pullRequests.map(pullRequest => {
    let cells = `<td>${escapeHtml(pullRequest.author)}</td><td>${escapeHtml(pullRequest.title)}</td>`;
    if (withVerification) {
      cells += '<td></td><td></td>';
    }
    return `<tr>${cells}</tr>`;
  });

  return `<table><tbody>${headerRow}${rows.join('')}</tbody></table>`;
}

// The rounded info box shown beside the table, for apps that need verification.
// "info" is Confluence's built-in info panel macro.
function verificationInfoBox(): string {
  return '<ac:structured-macro ac:name="info">'
    + '<ac:parameter ac:name="title">Verification</ac:parameter>'
    + `<ac:rich-text-body><p>${escapeHtml(config.verificationInfo)}</p></ac:rich-text-body>`
    + '</ac:structured-macro>';
}

// The whole page: a summary line and the PR table.
// Apps that need verification get a two-column layout: the table on the left, the info box on the right.
export function releasePageContent({ app, version, date, from, to, pullRequests }: Release): string {
  const withVerification = config.appsWithVerification.includes(app);

  const summary = `<p><strong>Version:</strong> ${escapeHtml(version)}`
    + ` · <strong>Release date:</strong> ${escapeHtml(date)}`
    + ` · <strong>Tags:</strong> ${escapeHtml(from)} → ${escapeHtml(to)}`
    + ` · <strong>Pull requests:</strong> ${pullRequests.length}</p>`;
  const table = pullRequestTable(pullRequests, withVerification);

  if (!withVerification) {
    return summary + table;
  }

  // "two_right_sidebar": a wide column on the left and a narrow one on the right.
  return '<ac:layout><ac:layout-section ac:type="two_right_sidebar">'
    + `<ac:layout-cell>${summary}${table}</ac:layout-cell>`
    + `<ac:layout-cell>${verificationInfoBox()}</ac:layout-cell>`
    + '</ac:layout-section></ac:layout>';
}
