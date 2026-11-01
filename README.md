# Release page creator · v-3

A small local web app that creates the **Confluence release page** for one app in the monorepo.

You enter the monorepo's path, pick an app, two git tags, a version and a release date. The server:

1. reads the **merged PRs** of that app between the two tags from git,
2. builds a table of them (author + PR title),
3. creates the page `Rel of <app> - <release date>` under the app's parent page in Confluence,
4. answers with the new page's address, which the form shows as a link.

New in this version: no more typing app and tag names. The form lists the apps in the monorepo and the chosen app's tags.

## Setup

Requires **Node.js 22.18 or newer** (it runs the TypeScript as it is) and **git**.

1. In [`server/config.json`](server/config.json), set:
   - `confluenceBaseUrl`: your Confluence's address,
   - `parentPageIds`: for each app, the ID of the page its release pages go under (it's in the page's address, `…pageId=123456`),
   - `appPattern`: which top-level folders are apps. The default `*-app` lists `web-app` and `admin-app`, but not `docs`.
2. Create a Confluence personal access token (**profile picture → Settings → Personal Access Tokens**) and put it in `server/.env`:

```
CONFLUENCE_TOKEN=<your token>
```

   `server/.gitignore` lists `.env`, so the token is never committed.

3. Start the server in the `server` folder and open **http://localhost:3000/**:

```bash
node server.ts
```

## Using the form

1. **Path to monorepo**: e.g. `C:\git\monorepo`. A folder inside it works too. The browser remembers it.
2. **App**: the monorepo's top-level folders that match `appPattern`.
3. **From tag / To tag**: the app's tags, named `<app>-<number>-OLD` and `<app>-<number>-NEW`. The newest pair is picked for you.
4. **Version** and **Date**: shown on the page; the date is also in its title.

## How the PRs are found

A merged PR is a commit between the two tags that:
- is on the main line (`--first-parent`),
- has **Merged PR** in its message, e.g. `Merged PR 1234: Add keyboard navigation`,
- changed something in the app's folder.

The table shows who made the merge commit and the PR's title.

## API

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/folder?path=…` | The git repo's root folder for that path. |
| `GET` | `/api/apps?repo=…` | The app names in that repo. |
| `GET` | `/api/tags?repo=…&app=…` | The app's `OLD` / `NEW` tags, highest number first. |
| `POST` | `/api/release` | `{ repo, app, from, to, version, date }`: creates the page and returns `pageUrl` and `pullRequestCount`. |

## Files

```
public/
├── index.html          The form
├── form.js             Its script: apps → tags, creating the page
└── style.css           Its styles
server/
├── server.ts           Serves the form and answers the API
├── lib/
│   ├── settings.ts     config.json and the paths
│   ├── git.ts          Apps, tags and merged PRs
│   └── confluence.ts   The token, creating the page and its content
├── config.json         Settings
└── .env                Your Confluence token (you create it; gitignored)
```

## Versions

| Version | What was added |
|---|---|
| v-1 | The bare minimum: one server file and a plain form. You type an app and two tags, and it lists the merged PRs from git. The monorepo folder is set in `config.json`. |
| v-2 | Creates the Confluence page (a table of the PRs) with the token from `server/.env`, and shows a link to it. |
| v-3 | A monorepo path field, and lists of apps and tags to pick from. The server is split into `lib/`. First styles. |
