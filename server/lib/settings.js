// Settings from config.json, plus the paths the server uses.
const path = require('node:path');
const config = require('../config.json');

// The server folder (the one with server.js, config.json and .env).
const SERVER_DIR = path.join(__dirname, '..');

module.exports = {
  config,

  SERVER_DIR,

  // The PORT environment variable wins over config.json.
  PORT: Number(process.env.PORT) || config.port,

  // The folder with the form page. Only the files in it can be fetched, nothing else on disk.
  PUBLIC_DIR: path.join(SERVER_DIR, '..', 'public'),

  // The file the Confluence token is read from. It's in server/.gitignore, so the token is never committed.
  ENV_FILE: path.join(SERVER_DIR, '.env'),

  // Confluence's address, without a trailing slash.
  CONFLUENCE_URL: config.confluenceBaseUrl.replace(/\/+$/, ''),
};
