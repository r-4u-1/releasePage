// Small helpers used all over the server.

// Stops the current request with an error. The form gets { ok: false, message } with this HTTP status.
function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

// A form value as trimmed text, or '' if it isn't text at all.
function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Makes text safe to put inside a regular expression, e.g. "web.app" matches only "web.app", not "webXapp".
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Makes text safe to put inside the page's HTML, e.g. a PR title "Fix <input> & more".
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { fail, textValue, escapeForRegExp, escapeHtml };
