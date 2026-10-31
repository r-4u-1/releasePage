import { config } from './settings.ts';
import { escapeHtml } from './helpers.ts';
import type { PullRequest } from './git.ts';

export interface Release {
  app: string;
  version: string;
  date: string;
  from: string;
  to: string;
  pullRequests: PullRequest[];
}

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

function verificationInfoBox(): string {
  return '<ac:structured-macro ac:name="info">'
    + '<ac:parameter ac:name="title">Verification</ac:parameter>'
    + `<ac:rich-text-body><p>${escapeHtml(config.verificationInfo)}</p></ac:rich-text-body>`
    + '</ac:structured-macro>';
}

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

  return '<ac:layout><ac:layout-section ac:type="two_right_sidebar">'
    + `<ac:layout-cell>${summary}${table}</ac:layout-cell>`
    + `<ac:layout-cell>${verificationInfoBox()}</ac:layout-cell>`
    + '</ac:layout-section></ac:layout>';
}
