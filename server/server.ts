import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, PORT, PUBLIC_DIR, CONFLUENCE_URL } from './lib/settings.ts';
import { fail, textValue, HttpError } from './lib/helpers.ts';
import * as git from './lib/git.ts';
import { requireToken } from './lib/token.ts';
import * as confluence from './lib/confluence.ts';
import { releasePageContent } from './lib/release-page-content.ts';
import { openInBrowser } from './lib/browser.ts';
import { isFromOwnPage } from './lib/web.ts';

const server = express();
server.disable('x-powered-by');

server.use((request, _response, next) => {
  if (!isFromOwnPage(request)) {
    fail(403, `This server only answers its own page. Open it as http://localhost:${PORT}/ or http://127.0.0.1:${PORT}/.`);
  }
  next();
});

server.use(express.static(PUBLIC_DIR));

server.use(express.json({ limit: '100kb' }));

server.get('/api/token', async (_request, response) => {
  const token = requireToken();
  const userName = await confluence.checkTokenWithConfluence(token);
  response.json({ ok: true, message: `Authenticated as ${userName}` });
});

server.get('/api/apps', (_request, response) => {
  response.json({ ok: true, apps: git.listApps() });
});

server.get('/api/tags', (request, response) => {
  response.json({ ok: true, tags: git.listTags(textValue(request.query.app)) });
});

server.post('/api/release', async (request, response) => {
  const token = requireToken();

  if (!request.is('application/json')) {
    fail(415, 'Requests to the release server must be sent as JSON.');
  }
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(400, 'The request must be a JSON object, e.g. { "app": "web-app", ... }.');
  }
  const form = body as Record<string, unknown>;
  const app = textValue(form.app);
  const from = textValue(form.from);
  const to = textValue(form.to);
  const version = textValue(form.version);
  const date = textValue(form.date);

  if (!version || version.length > 50) {
    fail(400, 'Enter a version, e.g. 1.4.0 (at most 50 characters).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(400, 'Enter the release date as YYYY-MM-DD, e.g. 2026-10-30.');
  }

  const appTags = git.listTags(app);
  if (!appTags.includes(from) || !appTags.includes(to)) {
    fail(400, `"${from}" and "${to}" aren't both tags of ${app}. Pick the app again to reload its tags.`);
  }

  const parentPageId = config.parentPageIds[app];
  if (!parentPageId) {
    fail(400, `${app} has no parent page yet. Add "${app}": "<page ID>" to "parentPageIds" in server/config.json.`);
  }

  const pullRequests = git.listMergedPullRequests(app, from, to);
  if (pullRequests.length === 0) {
    fail(400, `No merged PRs in ${app} between ${from} and ${to}: no commit there has "Merged PR" in its message `
      + `and changes the ${app} folder. Check that "From tag" is the older tag and "To tag" the newer one.`);
  }

  const pageUrl = await confluence.createConfluencePage(token, {
    title: `Rel of ${app} - ${date}`,
    parentPageId,
    content: releasePageContent({ app, version, date, from, to, pullRequests }),
  });

  console.log(`[release] created ${pageUrl} with ${pullRequests.length} PRs`);
  openInBrowser(pageUrl);
  response.json({ ok: true, pageUrl, pullRequestCount: pullRequests.length });
});

server.use(request => {
  fail(404, `The release server has no "${request.method} ${request.path}".`);
});

server.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  let status = 500;
  let message = 'Something went wrong in the release server. The terminal it runs in shows the details.';

  const bodyError = (error as { type?: string }).type;

  if (error instanceof HttpError) {
    status = error.status;
    message = error.message;
  } else if (bodyError === 'entity.parse.failed') {
    status = 400;
    message = 'The request isn\'t valid JSON.';
  } else if (bodyError === 'entity.too.large') {
    status = 413;
    message = 'The request is too large (over 100 KB).';
  }

  if (status >= 500) console.error('[server]', error instanceof Error ? error.message : error);
  response.status(status).json({ ok: false, message });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://localhost:${PORT}/ (Confluence: ${CONFLUENCE_URL})`);
});
