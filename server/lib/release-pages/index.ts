// The release page for an app: its own file in this folder if it has one, the base template if not.
//
// To give an app its own page: copy a-app.ts to <app>.ts, change it, and add it to appPages below.
import { type Release, type ReleasePage, basePage } from './base.ts';
import aApp from './a-app.ts';
import bApp from './b-app.ts';

export type { Release };

const appPages: Record<string, ReleasePage> = {
  'a-app': aApp,
  'b-app': bApp,
};

export function releasePageContent(release: Release): string {
  const page = appPages[release.app] ?? basePage;
  return page(release);
}
