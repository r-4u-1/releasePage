// Small helpers used all over the server.

// An error the form should see: { ok: false, message } with this HTTP status.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Stops the current request with an error. The form gets { ok: false, message } with this HTTP status.
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

// A form value as trimmed text, or '' if it isn't text at all.
export function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Makes text safe to put inside a regular expression, e.g. "web.app" matches only "web.app", not "webXapp".
export function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Makes text safe to put inside the page's HTML, e.g. a PR title "Fix <input> & more".
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
