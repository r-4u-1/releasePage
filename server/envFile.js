// The Confluence token, kept in a gitignored .env file (envFile in config.json).
// The token is only saved if the file already exists — creating the file is how you opt in.
// The token is never sent back to the browser.
const fs = require('node:fs');
const config = require('./config');

const FILE = config.envFile;
const KEY = 'CONFLUENCE_TOKEN';

function readLines() {
  try {
    return fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function canSave() {
  return fs.existsSync(FILE);
}

function readToken() {
  for (const line of readLines() || []) {
    const m = /^\s*CONFLUENCE_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return null;
}

// Replaces the CONFLUENCE_TOKEN line (or adds one) and keeps every other line as it is.
function saveToken(token) {
  const lines = readLines();
  if (!lines) return false;
  if (readToken() === token) return true;
  const entry = `${KEY}=${token}`;
  const i = lines.findIndex(l => /^\s*CONFLUENCE_TOKEN\s*=/.test(l));
  if (i !== -1) lines[i] = entry;
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(entry);
  }
  fs.writeFileSync(FILE + '.tmp', lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
  return true;
}

module.exports = { canSave, readToken, saveToken, FILE };
