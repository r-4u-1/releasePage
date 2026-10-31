// Opens an address in this computer's default browser.
const { execFile } = require('node:child_process');

function openInBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32';                          // Windows' own "open this address" helper
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';                              // macOS
    args = [url];
  } else {
    command = 'xdg-open';                          // Linux
    args = [url];
  }

  execFile(command, args, error => {
    if (error) console.warn(`[browser] could not open ${url}: ${error.message}`);
  });
}

module.exports = { openInBrowser };
