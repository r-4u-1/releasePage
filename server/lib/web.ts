// The web parts: reading what the form sent, and sending answers and files back.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PUBLIC_DIR, CLIENT_DIR } from './settings.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Sends the file the address asks for: "/" is index.html, "/style.css" is public/style.css,
// and a script like "/form.js" is client/form.ts with its types removed.
export function sendPublicFile(response: ServerResponse, pathname: string): void {
  const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);

  // A form script. Read on every request, so a change shows on reload.
  if (fileName.endsWith('.js')) {
    const typeScript = fs.readFileSync(path.join(CLIENT_DIR, fileName.replace(/\.js$/, '.ts')), 'utf8');
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.js'] });
    response.end(stripTypeScriptTypes(typeScript));
    return;
  }

  const contentType = CONTENT_TYPES[path.extname(fileName)] || 'application/octet-stream';
  const content = fs.readFileSync(path.join(PUBLIC_DIR, fileName)); // read first: a missing file fails before anything is sent
  response.writeHead(200, { 'Content-Type': contentType });
  response.end(content);
}

export function sendJson(response: ServerResponse, status: number, data: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// Reads the JSON object the form sent.
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, any>> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}
