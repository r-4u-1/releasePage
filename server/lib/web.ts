// Who may call the server. Express does the rest of the web work: serving public/, reading JSON, sending answers.
import type { IncomingMessage } from 'node:http';
import { PORT } from './settings.ts';

// The only addresses the page is opened from. Anything else is refused,
// so no other website (and no other host name) can use the token in .env.
const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

export function isFromOwnPage(request: IncomingMessage): boolean {
  const { host, origin } = request.headers;
  // Browsers send "origin" when a page calls the server; it must be our own page.
  return host !== undefined && OWN_HOSTS.includes(host) && (!origin || origin === `http://${host}`);
}
