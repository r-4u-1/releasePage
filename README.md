# Release page creator · v-4

A small local web app that creates the **Confluence release page** for one app in the monorepo.

You enter the monorepo's path, pick an app, two git tags, a version and a release date. The server:

1. reads the **merged PRs** of that app between the two tags from git,
2. builds a table of them (author + PR title, plus **isVerified** and **Note** for some apps),
3. creates the page `Rel of <app> - <release date>` under the app's parent page in Confluence,
4. opens the new page in your browser.

New in this version:
- **The real PR author**: the person who opened the PR, not the one who merged it.
- **Verification**: some apps get isVerified and Note columns and an info box beside the table.
- **Token status**: the form shows whether the token in `server/.env` works, and whose it is.
- **Opens the page**: the new page opens in your browser by itself.

## Setup

Requires **Node.js 22.18 or newer** (it runs the TypeScript as it is) and **git**.

1. In [`server/config.json`](server/config.json), set:
   - `confluenceBaseUrl`: your Confluence's address,
   - `parentPageIds`: for each app, the ID of the page its release pages go under (it's in the page's address, `…pageId=123456`),
   - `appPattern`: which top-level folders are apps. The default `*-app` lists `web-app` and `admin-app`, but not `docs`,
   - `appsWithVerification` and `verificationInfo`: see [The release page](#the-release-page).
2. Create a Confluence personal access token (**profile picture → Settings → Personal Access Tokens**) and put it in `server/.env`:

```
CONFLUENCE_TOKEN=<your token>
```

   `server/.gitignore` lists `.env`, so the token is never committed. The file is read on every check, so adding the token works without a restart: click **Check again** in the form.

3. Start the server in the `server` folder and open **http://localhost:3000/**:

```bash
node server.ts
```

## The release page

**Title:** `Rel of <app> - <release date>`, created under the app's page from `parentPageIds`.

**Content:** a summary line (version, release date, tags, number of PRs) and a table with one row per merged PR.

**Apps in `appsWithVerification`** get two more, empty columns, **isVerified** and **Note**, for people to fill in on the page. Beside the table is Confluence's **Info** panel with the text from `verificationInfo`.

## How the PRs are found

A merged PR is a commit between the two tags that:
- is on the main line (`--first-parent`),
- has **Merged PR** in its message, e.g. `Merged PR 1234: Add keyboard navigation`,
- changed something in the app's folder.

The **Author** is the person who opened the PR:
- for a merge commit: the author of the PR branch's last commit,
- for a squashed PR: the author of the squashed commit.

## API

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/folder?path=…` | The git repo's root folder for that path. |
| `GET` | `/api/token` | Checks the token in `server/.env` with Confluence. Returns "Authenticated as …". |
| `GET` | `/api/apps?repo=…` | The app names in that repo. |
| `GET` | `/api/tags?repo=…&app=…` | The app's `OLD` / `NEW` tags, highest number first. |
| `POST` | `/api/release` | `{ repo, app, from, to, version, date }`: creates the page, opens it, and returns `pageUrl` and `pullRequestCount`. |

## Files

```
public/
├── index.html          The form
├── form.js             Its script: token status, apps → tags, creating the page
└── style.css           Its styles
server/
├── server.ts           Serves the form and answers the API
├── lib/
│   ├── settings.ts     config.json and the paths
│   ├── git.ts          Apps, tags and merged PRs
│   ├── confluence.ts   The token, checking it, creating a page
│   ├── release-page-content.ts  The page's table and info box
│   └── browser.ts      Opens the new page in the browser
├── config.json         Settings
└── .env                Your Confluence token (you create it; gitignored)
```

## Versions

| Version | What was added |
|---|---|
| v-1 | The bare minimum: one server file and a plain form. You type an app and two tags, and it lists the merged PRs from git. The monorepo folder is set in `config.json`. |
| v-2 | Creates the Confluence page (a table of the PRs) with the token from `server/.env`, and shows a link to it. |
| v-3 | A monorepo path field, and lists of apps and tags to pick from. The server is split into `lib/`. First styles. |
| v-4 | The real PR author, isVerified and Note columns plus an info box for some apps, the token status line, and the new page opens by itself. |
