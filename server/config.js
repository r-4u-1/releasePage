// Loads config.json and picks one environment from the command line:
//   node server.js              → "real"
//   node server.js --fake       → "fake"
//   node server.js --env=<name> → any environment in config.json
// Paths in config.json are relative to this folder.
const path = require('node:path');
const file = require('./config.json');

function envName(argv) {
  const i = argv.findIndex(a => a === '--env' || a.startsWith('--env='));
  if (i !== -1) return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  return argv.includes('--fake') ? 'fake' : 'real';
}

const name = envName(process.argv.slice(2));
const env = file.environments[name];
if (!env) {
  console.error(`Unknown environment "${name}". Pick one of: ${Object.keys(file.environments).join(', ')}`);
  process.exit(1);
}

const rel = p => (p ? path.resolve(__dirname, p) : '');

module.exports = {
  name,
  fake: !!env.fake,
  port: Number(process.env.PORT) || env.port || file.port || 3000,
  // Only this machine can reach the server (it can use the saved token).
  host: env.host || file.host || '127.0.0.1',
  pageFile: rel(env.pageFile || file.pageFile),
  // Data Center: https://confluence.example.com · Cloud: https://<site>.atlassian.net/wiki
  confluenceBaseUrl: (env.confluenceBaseUrl || '').replace(/\/+$/, ''),
  // Empty for Data Center (Bearer PAT). Set for Cloud (Basic auth = email:api_token).
  confluenceEmail: env.confluenceEmail || '',
  // Empty = the git repo this server is inside.
  repoRoot: rel(env.repoRoot),
  // Which top-level folders count as apps. * matches anything, e.g. "*-app" → web-app, admin-app.
  appPattern: env.appPattern || file.appPattern || '*',
  parentsFile: rel(env.parentsFile || 'parents.json'),
  // Gitignored file holding CONFLUENCE_TOKEN. Only written to if it already exists.
  envFile: rel(env.envFile || '.env'),
};
