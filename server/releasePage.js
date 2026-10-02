// Builds the release page in Confluence storage format (XHTML).
const TITLE_MAX = 80;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncate(s, max = TITLE_MAX) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function pageTitle(version, date) {
  return `Release ${version} ${date}`;
}

// An unticked Confluence checkbox. Task IDs must be unique within the page.
function checkbox(id) {
  return '<ac:task-list><ac:task>'
    + `<ac:task-id>${id}</ac:task-id>`
    + '<ac:task-status>incomplete</ac:task-status>'
    + '<ac:task-body></ac:task-body>'
    + '</ac:task></ac:task-list>';
}

function buildBody({ app, from, to, date, changes }) {
  const intro = `<p><strong>App:</strong> ${esc(app)}`
    + ` · <strong>Tags:</strong> <code>${esc(from)}</code> → <code>${esc(to)}</code>`
    + ` · <strong>Date:</strong> ${esc(date)}</p>`;

  if (!changes.length) return intro + '<p>No changes in this release.</p>';

  let taskId = 1;
  const rows = changes.map(c => {
    const title = esc(truncate(c.title)) + (c.pr ? ` (#${c.pr})` : '');
    return '<tr>'
      + `<td>${esc(c.author)}</td>`
      + `<td>${title}</td>`
      + `<td>${checkbox(taskId++)}</td>`
      + `<td>${checkbox(taskId++)}</td>`
      + '</tr>';
  }).join('');

  return intro
    + '<table><tbody>'
    + '<tr><th>Author</th><th>PR</th><th>Affects a11y</th><th>No a11y impact</th></tr>'
    + rows
    + '</tbody></table>';
}

module.exports = { pageTitle, buildBody };
