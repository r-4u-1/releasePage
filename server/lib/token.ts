import fs from 'node:fs';
import { ENV_FILE } from './settings.ts';
import { fail } from './helpers.ts';

const TOKEN_LINE = /^\s*CONFLUENCE_TOKEN\s*=\s*['"]?(.*?)['"]?\s*$/;

function readToken(): string {
  if (!fs.existsSync(ENV_FILE)) return '';

  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = TOKEN_LINE.exec(line);
    if (match && match[1]) return match[1];
  }
  return '';
}

export function requireToken(): string {
  const token = readToken();
  if (!token) {
    fail(400, `No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to ${ENV_FILE}`);
  }
  return token;
}
