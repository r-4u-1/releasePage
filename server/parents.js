// app name → Confluence parent page ID, kept in the parentsFile from config.json.
// Commit the real one so everyone shares the same parents.
const fs = require('node:fs');
const config = require('./config');

const FILE = config.parentsFile;

function readParents() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveParent(app, pageId) {
  const parents = readParents();
  if (parents[app] === pageId) return;
  parents[app] = pageId;
  const sorted = Object.fromEntries(Object.entries(parents).sort(([a], [b]) => a.localeCompare(b)));
  // Write to a temp file first so a crash never leaves half a JSON file behind.
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(sorted, null, 2) + '\n');
  fs.renameSync(FILE + '.tmp', FILE);
}

module.exports = { readParents, saveParent };
