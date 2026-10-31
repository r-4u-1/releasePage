# Release page creator

A small local web app that creates the **Confluence release page** for one app in the monorepo. Everything is in one file, [`release-page.ts`](release-page.ts).

You pick an app, two git tags, a version and a release date. The server reads the **merged PRs** of that app between the two tags, creates the page `Rel of <app> - <release date>` under the app's parent page in Confluence, and opens it in your browser.

## Setup

Requirements: **Node.js 22.18 or newer** and **git**. Nothing to install.

1. Put `release-page.ts` in its own folder of the monorepo, e.g. `release-page/`.
2. Fill in the **SETTINGS** at the top of the file (the comment above them explains each one):
   ```ts
   apps: {
     'web-app': { parentPageId: '123456', verification: true },
     'admin-app': { parentPageId: '234567' },
   },
   ```
3. Create `.env` next to the file, and keep it in `.gitignore`:
   ```
   CONFLUENCE_TOKEN=<your token>
   ```
   In Confluence: **your profile picture → Settings → Personal Access Tokens → Create token**.
4. Start it and open **http://localhost:3000/**:
   ```bash
   node release-page/release-page.ts
   ```

## How tags and PRs are found

- **Tags** are named `<app>-<number>-OLD` and `<app>-<number>-NEW`, e.g. `web-app-12-OLD`. The newest pair is picked for you.
- **Merged PRs** are the main-line commits between the two tags that have **Merged PR** in their message and changed the app's folder. The title is the commit subject without `Merged PR 1234: `.
- The **author** is the author of the PR branch's last commit, or of the squashed commit.
- Apps with `verification: true` get empty **isVerified** and **Note** columns and an info box with `verificationInfo`.

## Troubleshooting

| You see | Try |
|---|---|
| **ERR_UNKNOWN_FILE_EXTENSION ".ts"** | Your Node is older than 22.18. Update it, or run `node --experimental-strip-types release-page.ts`. |
| **No Confluence token found** | Add `CONFLUENCE_TOKEN=<your token>` to the `.env` the message names, then click **Check again**. |
| **Confluence rejected the token** | It's wrong or expired. For Confluence Cloud, also set `confluenceEmail`. |
| **Can't reach Confluence** | Check `confluenceUrl` (Cloud ends in `/wiki`) and your network or VPN. If your company inspects HTTPS, start Node with `NODE_EXTRA_CA_CERTS=<company-root.pem>`. |
| **Confluence answered HTTP 4xx** | Usually a wrong `parentPageId`, missing rights on its space, or a page with that title already existing. |
| **No merged PRs** | Check that **From tag** is the older tag and **To tag** the newer one. |
| **No tags found** | Fetch them with `git fetch --tags`. |
| `EADDRINUSE` | Port 3000 is in use. Start with a different `PORT` environment variable. |
