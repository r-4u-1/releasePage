// The web parts: who may call the server, reading what the form sent, and sending answers and files back.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PORT, PUBLIC_DIR } from './settings';
import { fail } from './helpers';

// The files in public/. Only these can be fetched, nothing else on disk.
const PUBLIC_FILES = fs.readdirSync(PUBLIC_DIR);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// The only addresses the page is opened from. Anything else is refused,
// so no other website (and no other host name) can use the token in .env.
const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

export function isFromOwnPage(request: IncomingMessage): boolean {
  const { host, origin } = request.headers;
  // Browsers send "origin" when a page calls the server; it must be our own page.
  return host !== undefined && OWN_HOSTS.includes(host) && (!origin || origin === `http://${host}`);
}

// Whether the address asks for one of the files in public/, e.g. "/style.css". "/" is index.html.
// Returns the file name, or '' if it's not one of them.
export function publicFileFor(pathname: string): string {
  const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
  return PUBLIC_FILES.includes(fileName) ? fileName : '';
}

export function sendPublicFile(response: ServerResponse, fileName: string): void {
  const contentType = CONTENT_TYPES[path.extname(fileName)] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(path.join(PUBLIC_DIR, fileName)).pipe(response);
}

export function sendJson(response: ServerResponse, status: number, data: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// Reads the JSON object the form sent. At most 100 KB.
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.startsWith('application/json')) {
    fail(415, 'Requests to the release server must be sent as JSON.');
  }

  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 100_000) fail(413, 'The request is too large (over 100 KB).');
  }

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    fail(400, 'The request isn\'t valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(400, 'The request must be a JSON object, e.g. { "app": "web-app", ... }.');
  }
  return body as Record<string, unknown>;
}
