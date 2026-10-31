import fs from 'node:fs';
import path from 'node:path';

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

export const SERVER_DIR = path.join(import.meta.dirname, '..');

export const config: Config = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'config.json'), 'utf8'));

export const PORT = Number(process.env.PORT) || config.port;

export const PUBLIC_DIR = path.join(SERVER_DIR, '..', 'public');

export const ENV_FILE = path.join(SERVER_DIR, '.env');

export const CONFLUENCE_URL = config.confluenceBaseUrl.replace(/\/+$/, '');
