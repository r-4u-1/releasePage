// Settings from config.json: the top-level values, overridden by the chosen environment.
//   node server.js              → "real"
//   node server.js --fake       → "fake"
//   node server.js --env=<name> → any environment in config.json
const path = require('node:path');
const { environments, ...defaults } = require('./config.json');

const args = process.argv.slice(2);
const envArg = args.find(arg => arg.startsWith('--env='));
const name = envArg ? envArg.slice('--env='.length) : args.includes('--fake') ? 'fake' : 'real';

if (!environments[name]) {
  console.error(`Unknown environment "${name}". Pick one of: ${Object.keys(environments).join(', ')}`);
  process.exit(1);
}

const settings = { ...defaults, ...environments[name] };

// Paths in config.json are relative to this folder. An empty path stays empty.
const fromHere = file => (file ? path.resolve(__dirname, file) : '');

module.exports = {
  name,
  fake: Boolean(settings.fake),        // start the fake repo and fake Confluence first
  port: Number(process.env.PORT) || settings.port,
  host: settings.host,                 // 127.0.0.1 = only this computer can reach the server
  publicDir: fromHere(settings.publicDir),
  appPattern: settings.appPattern,     // which top-level folders are apps, e.g. "*-app"
  repoRoot: fromHere(settings.repoRoot), // empty = the git repo this tool is inside
  parentsFile: fromHere(settings.parentsFile),
  envFile: fromHere(settings.envFile),
  confluenceBaseUrl: settings.confluenceBaseUrl.replace(/\/+$/, ''),
  confluenceEmail: settings.confluenceEmail, // empty for Data Center; your Atlassian email for Cloud
};
