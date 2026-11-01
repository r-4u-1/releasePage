// The web parts: who may call the server, reading what the form sent, and sending answers and files back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PORT, PUBLIC_DIR, CLIENT_DIR } from './settings.ts';
import { fail } from './helpers.ts';

// The files in public/. Only these can be fetched, nothing else on disk.
const PUBLIC_FILES = fs.readdirSync(PUBLIC_DIR);

// The form's scripts, e.g. "form.js" for client/form.ts. Only these can be fetched from client/.
const CLIENT_SCRIPTS = fs.readdirSync(CLIENT_DIR)
  .filter(name => name.endsWith('.ts'))
  .map(name => name.replace(/\.ts$/, '.js'));

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

// A new random page token every time the server starts. index.html gets it in place of {{PAGE_TOKEN}},
// and the form sends it back as the X-Token header with every API call, so only a page this server
// served can use the API. Not the Confluence token: that one stays in .env and never reaches the page.
const PAGE_TOKEN = crypto.randomBytes(32).toString('hex');

export function hasPageToken(request: IncomingMessage): boolean {
  const sent = Buffer.from(String(request.headers['x-token'] ?? ''));
  const expected = Buffer.from(PAGE_TOKEN);
  return sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
}

// Whether the address asks for one of the files in public/, e.g. "/style.css", or one of the form's scripts,
// e.g. "/form.js". "/" is index.html. Returns the file name, or '' if it's not one of them.
export function publicFileFor(pathname: string): string {
  const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
  return PUBLIC_FILES.includes(fileName) || CLIENT_SCRIPTS.includes(fileName) ? fileName : '';
}

export function sendPublicFile(response: ServerResponse, fileName: string): void {
  // A form script: client/<name>.ts with its types removed. Read on every request, so a change shows on reload.
  if (CLIENT_SCRIPTS.includes(fileName)) {
    const typeScript = fs.readFileSync(path.join(CLIENT_DIR, fileName.replace(/\.js$/, '.ts')), 'utf8');
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.js'] });
    response.end(stripTypeScriptTypes(typeScript));
    return;
  }

  // The form page, with this run's page token filled in. Not cached, so a reload after a restart gets the new one.
  if (fileName === 'index.html') {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, fileName), 'utf8');
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' });
    response.end(html.replace('{{PAGE_TOKEN}}', PAGE_TOKEN));
    return;
  }

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
