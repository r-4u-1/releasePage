// The two small files the server keeps (paths from config.json):
//   parents.json — app name → Confluence parent page ID. Commit it so the whole team shares it.
//   .env         — CONFLUENCE_TOKEN=… Gitignored, and only written if you created the file.
const fs = require('node:fs');
const config = require('./config');

// ── Parent pages ───────────────────────────────────────────────────────────

function readParents() {
  if (!fs.existsSync(config.parentsFile)) return {};
  return JSON.parse(fs.readFileSync(config.parentsFile, 'utf8'));
}

function saveParent(app, pageId) {
  const parents = { ...readParents(), [app]: pageId };
  const sorted = Object.fromEntries(Object.entries(parents).sort());
  fs.writeFileSync(config.parentsFile, JSON.stringify(sorted, null, 2) + '\n');
}

// ── Token ──────────────────────────────────────────────────────────────────

const TOKEN_LINE = /^\s*CONFLUENCE_TOKEN\s*=\s*(.*?)\s*$/;

// Creating the .env file is how you opt in to saving the token.
function canSaveToken() {
  return fs.existsSync(config.envFile);
}

function readEnvLines() {
  return fs.readFileSync(config.envFile, 'utf8').split(/\r?\n/);
}

function readToken() {
  if (!canSaveToken()) return null;
  const line = readEnvLines().find(l => TOKEN_LINE.test(l));
  const value = line && TOKEN_LINE.exec(line)[1].replace(/^(['"])(.*)\1$/, '$2'); // strip quotes
  return value || null;
}

// Replaces the CONFLUENCE_TOKEN line (or adds one) and keeps every other line.
function saveToken(token) {
  if (!canSaveToken()) return false;
  if (readToken() === token) return true;
  const lines = readEnvLines().filter(l => !TOKEN_LINE.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(`CONFLUENCE_TOKEN=${token}`);
  fs.writeFileSync(config.envFile, lines.join('\n') + '\n');
  return true;
}

module.exports = { readParents, saveParent, canSaveToken, readToken, saveToken };
