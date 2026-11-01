// The Confluence token, read from server/.env:  CONFLUENCE_TOKEN=<your token>
import fs from 'node:fs';
import { ENV_FILE } from './settings.ts';

// The token line in .env, e.g.  CONFLUENCE_TOKEN=abc123  or  CONFLUENCE_TOKEN="abc123"
// The token itself (without quotes) is captured as group 1.
const TOKEN_LINE = /^\s*CONFLUENCE_TOKEN\s*=\s*['"]?(.*?)['"]?\s*$/;

// The token from .env, or '' if the file or the line is missing.
// Read every time, so adding the token works without restarting the server.
function readToken(): string {
  if (!fs.existsSync(ENV_FILE)) return '';

  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = TOKEN_LINE.exec(line);
    if (match && match[1]) return match[1];
  }
  return '';
}

// The token from .env, or fails with a message that says how to add it.
export function requireToken(): string {
  const token = readToken();
  if (!token) {
    throw new Error(`No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to ${ENV_FILE}`);
  }
  return token;
}
