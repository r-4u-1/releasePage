import type { IncomingMessage } from 'node:http';
import { PORT } from './settings.ts';

const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

export function isFromOwnPage(request: IncomingMessage): boolean {
  const { host, origin } = request.headers;
  return host !== undefined && OWN_HOSTS.includes(host) && (!origin || origin === `http://${host}`);
}
