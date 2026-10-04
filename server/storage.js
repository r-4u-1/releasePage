// The token in .env (path from config.json): CONFLUENCE_TOKEN=…
// Gitignored, and only written if you created the file.
const fs = require('node:fs');
const config = require('./config');

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

module.exports = { canSaveToken, readToken, saveToken };
