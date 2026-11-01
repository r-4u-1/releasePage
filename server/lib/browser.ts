// Opens an address in this computer's default browser.
import { execFile } from 'node:child_process';

export function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
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
