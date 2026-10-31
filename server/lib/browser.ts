import { execFile } from 'node:child_process';

export function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  execFile(command, args, error => {
    if (error) console.warn(`[browser] could not open ${url}: ${error.message}`);
  });
}
