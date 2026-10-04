// Runs the release script, which reads the git log between the two tags and creates the Confluence page:
//   bash <releaseScript> <from> <to> <app> <version> <date>
// The token reaches the script as the CONFLUENCE_TOKEN environment variable, never as an argument.
const { execFile } = require('node:child_process');
const config = require('./config');
const git = require('./git');
const { HttpError } = require('./web');

const TIMEOUT = 5 * 60_000;

// Git Bash on Windows understands C:/x/y.sh, but not always C:\x\y.sh.
const scriptPath = config.releaseScript.replace(/\\/g, '/');

// Returns what the script printed. Fails with its last error line when it exits non-zero.
function runReleaseScript({ from, to, app, version, date }) {
  const args = [scriptPath, from, to, app, version, date];
  const env = {
    ...process.env, // CONFLUENCE_TOKEN is set here once a token is verified
    CONFLUENCE_BASE_URL: config.confluenceBaseUrl,
    CONFLUENCE_EMAIL: config.confluenceEmail,
  };
  console.log(`[release] ${config.bash} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    execFile(config.bash, args, { cwd: git.repoRoot(), env, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (!err) return resolve(stdout.trim());
        const lastLine = String(stderr || stdout).trim().split('\n').pop();
        const reason = err.code === 'ENOENT' ? `"${config.bash}" not found — set "bash" in config.json`
          : err.killed ? `timed out after ${TIMEOUT / 1000} s`
          : lastLine || `exit code ${err.code}`;
        reject(new HttpError(500, `Release script failed: ${reason}`));
      });
  });
}

module.exports = { runReleaseScript };
