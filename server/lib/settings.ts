// Settings from config.json, plus the paths the server uses.
import fs from 'node:fs';
import path from 'node:path';

// The server folder (the one with server.ts, config.json and .env).
// This file is in lib/, one folder below it.
export const SERVER_DIR = path.join(import.meta.dirname, '..');

// Read when the server starts, so a change to config.json needs a restart.
export const config = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'config.json'), 'utf8'));

export const PORT = config.port;

// The folder with the form page.
export const PUBLIC_DIR = path.join(SERVER_DIR, '..', 'public');

// The file the Confluence token is read from.
export const ENV_FILE = path.join(SERVER_DIR, '.env');
