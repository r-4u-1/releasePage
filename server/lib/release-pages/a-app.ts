// a-app's release page.
// Every PR has to be verified before the release: the table gets isVerified and Note columns
// for people to fill in, with an info box beside it that says so.
import { config } from '../settings.ts';
import { type ReleasePage, basePage, infoBox } from './base.ts';

const page: ReleasePage = release => basePage(release, {
  extraColumns: ['isVerified', 'Note'],
  sidebar: infoBox('Verification', config.verificationInfo),
});

export default page;
