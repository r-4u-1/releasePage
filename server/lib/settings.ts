// Settings from config.json, plus the paths the server uses.
import fs from 'node:fs';
import path from 'node:path';

// What config.json holds. The README's "config.json" table explains each one.
export interface Config {
  port: number;
  appPattern: string;
  repoRoot: string;
  confluenceBaseUrl: string;
  confluenceEmail: string;
  parentPageIds: Record<string, string>;
  appsWithVerification: string[];
  verificationInfo: string;
}

// The server folder (the one with server.ts, config.json and .env).
// This file runs from dist/lib/, two folders below it.
export const SERVER_DIR = path.join(__dirname, '..', '..');

// Read when the server starts, so a change to config.json needs a restart.
export const config: Config = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'config.json'), 'utf8'));

// The PORT environment variable wins over config.json.
export const PORT = Number(process.env.PORT) || config.port;

// The folder with the form page. Only the files in it can be fetched, nothing else on disk.
export const PUBLIC_DIR = path.join(SERVER_DIR, '..', 'public');

// The file the Confluence token is read from. It's in server/.gitignore, so the token is never committed.
export const ENV_FILE = path.join(SERVER_DIR, '.env');

// Confluence's address, without a trailing slash.
export const CONFLUENCE_URL = config.confluenceBaseUrl.replace(/\/+$/, '');
