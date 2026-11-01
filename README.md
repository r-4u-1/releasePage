# Release page creator · v-2

Creates the **Confluence release page** for one app in the monorepo.

You type an app, a version, a release date and two git tags. The server:

1. reads the **merged PRs** of that app between the two tags from git,
2. builds a table of them (author + PR title),
3. creates the page `Rel of <app> - <release date>` under the app's parent page in Confluence,
4. answers with the new page's address, which the form shows as a link.

## Setup

Requires **Node.js 22.18 or newer** (it runs the TypeScript as it is) and **git**.

1. In [`server/config.json`](server/config.json), set:
   - `repo`: the monorepo's folder,
   - `confluenceBaseUrl`: your Confluence's address,
   - `parentPageIds`: for each app, the ID of the page its release pages go under (it's in the page's address, `…pageId=123456`).
2. Create a Confluence personal access token (**profile picture → Settings → Personal Access Tokens**) and put it in `server/.env`:

```
CONFLUENCE_TOKEN=<your token>
```

   `server/.gitignore` lists `.env`, so the token is never committed.

3. Start the server in the `server` folder and open **http://localhost:3000/**:

```bash
node server.ts
```

## How the PRs are found

A merged PR is a commit between the two tags that:
- is on the main line (`--first-parent`),
- has **Merged PR** in its message, e.g. `Merged PR 1234: Add keyboard navigation`,
- changed something in the app's folder.

The table shows who made the merge commit and the PR's title.

## Files

```
public/index.html   The form, with its script inline
server/server.ts    Serves the form, reads git, creates the page in Confluence
server/config.json  Settings
server/.env         Your Confluence token (you create it; gitignored)
```

## Versions

| Version | What was added |
|---|---|
| v-1 | The bare minimum: one server file and a plain form. You type an app and two tags, and it lists the merged PRs from git. The monorepo folder is set in `config.json`. |
| v-2 | Creates the Confluence page (a table of the PRs) with the token from `server/.env`, and shows a link to it. |
