# Release page creator

A small local web app that creates the **Confluence release page** for one app in the monorepo.

You pick an app, two git tags, a version and a release date. The server:

1. reads the **merged PRs** of that app between the two tags from git,
2. builds a table of them (author + PR title, plus **isVerified** and **Note** for some apps),
3. creates the page `Rel of <app> - <release date>` under the app's parent page in Confluence,
4. opens the new page in your browser.

```
 Form (public/)               Local server (server/)                 Outside
┌──────────────────┐        ┌──────────────────────────────┐
│ Token            │──────▶│ check token ──────────────────┼──▶ Confluence
│ App              │──────▶│ list apps / tags ─────────────┼──▶ git (app folder)
│ Version, Date    │        │                              │
│ From / To tag    │        │                              │
│ [Create page]    │──────▶│ read merged PRs ──────────────┼──▶ git log
│                  │        │ create page ──────────────────┼──▶ Confluence
│                  │        │ open page ────────────────────┼──▶ your browser
└──────────────────┘        └──────────────────────────────┘
```

---

## Contents

- [Setup](#setup)
- [Walking through the form](#walking-through-the-form)
- [The release page](#the-release-page)
- [How apps, tags and PRs are found](#how-apps-tags-and-prs-are-found)
- [The token](#the-token)
- [Configuration](#configuration)
- [Files](#files)
- [API](#api)
- [Troubleshooting](#troubleshooting)

---

## Setup

Requirements: **Node.js 18.11 or newer** and **git**. Nothing to install: the server only uses Node's built-in modules.

**1. Put the tool in the monorepo.** The server lists the monorepo's top-level folders as apps:

```
monorepo/
├── web-app/             ← listed (matches *-app)
├── admin-app/           ← listed
├── docs/                ← not listed
└── release-page/        ← this tool (not listed)
    ├── public/
    └── server/
```

**2. Set the Confluence address.** In [`server/config.json`](server/config.json), replace the example `confluenceBaseUrl` with yours. Use `https://`, so the token is encrypted on its way.

**3. Add each app's parent page.** In `parentPageIds`, map each app to the Confluence page its release pages go under. The page ID is in the page's address (`…pageId=123456`) or under **••• → Page information**.

**4. List the apps that need verification** in `appsWithVerification`. See [The release page](#the-release-page).

**5. Get a Confluence personal access token.** In Confluence: **your profile picture → Settings → Personal Access Tokens → Create token**.

**6. (Optional) Let the tool remember the token.** Create an empty `.env` file in the `server` folder. See [The token](#the-token).

**7. Start the server** and open **http://localhost:3000/**.

```bash
npm run dev
```

---

## Walking through the form

### 1. Confluence token
Paste your personal access token. The server asks Confluence who the token belongs to. If it works, you see a green check, and the server keeps the token in memory for creating the page.

If a valid token is already saved in `.env`, this field is replaced by **● Using the token saved in .env**. Click **Use a different token** to type another one.

### 2. App
A list of the top-level folders in the monorepo. Picking an app loads its git tags into **From tag** and **To tag**.

### 3. Version and Date
Shown on the page; the date is also in the page title. You can type the date as numbers (dashes are added for you) or pick it from the calendar.

### 4. From tag (OLD) and To tag (NEW)
Filled with the app's tags. The newest `OLD` / `NEW` pair is picked for you.

### 5. Create page
Creates the release page and opens it in your browser. Under the button you see how many PRs it lists, and an **open in Confluence** link. If something goes wrong, the reason is shown instead.

---

## The release page

**Title:** `Rel of <app> - <release date>`, e.g. `Rel of web-app - 2026-10-30`. It's created under the app's page from `parentPageIds`, in the same space.

**Content:** a summary line (version, release date, tags, number of PRs) and a table with one row per merged PR:

| Author | Pull request |
|---|---|
| Alice | Add keyboard navigation to the main menu |

**Apps in `appsWithVerification`** get two more columns, and an info box beside the table with the text from `verificationInfo`:

```
┌───────────────────────────────────────────────────┬──────────────────┐
│ Version: 1.4.0 · Release date: 2026-10-30 · …     │ ╭──────────────╮ │
│ ┌────────┬──────────────┬────────────┬──────┐     │ │ ℹ Verification│ │
│ │ Author │ Pull request │ isVerified │ Note │     │ │ This app needs│ │
│ ├────────┼──────────────┼────────────┼──────┤     │ │ every PR …    │ │
│ │ Alice  │ Add …        │ ☐          │      │     │ ╰──────────────╯ │
│ └────────┴──────────────┴────────────┴──────┘     │                  │
└───────────────────────────────────────────────────┴──────────────────┘
```

- **isVerified** is a Confluence checkbox (a task), so people can tick it right on the page.
- **Note** is empty, for people to fill in.
- The info box is Confluence's own **Info** panel, which has rounded corners. Confluence doesn't allow custom styles in page content, so its look is Confluence's.

---

## How apps, tags and PRs are found

**Apps** are the top-level folders of the monorepo whose name matches `appPattern` in `config.json`. The default is `*-app`, so `web-app` and `admin-app` are apps, but `docs`, `shared-lib` or `app-web` are not. `*` matches anything. For broad patterns like `*`, folders starting with `.`, `node_modules`, and the folder this tool lives in are left out.

**Tags** must be named after the app folder:

```
<app>-<number>-OLD     e.g. web-app-12-OLD
<app>-<number>-NEW     e.g. web-app-12-NEW
```

**Merged PRs** are the commits between the two tags that:
- are on the main line (`--first-parent`), so not the commits inside each PR,
- have **Merged PR** in their message, e.g. `Merged PR 1234: Add keyboard navigation`,
- changed something in the app's folder.

The **Pull request** column is the commit's subject without the `Merged PR 1234: ` part.

The **Author** is the person who opened the PR. Git doesn't store that directly, so it's taken as:
- for a merge commit: the author of the PR branch's last commit,
- for a squashed PR: the author of the squashed commit.

If someone else pushed the last commit to a PR's branch, they're shown instead.

---

## The token

The token is **never saved by the page and never sent back to the browser**.

| Situation | What happens |
|---|---|
| `server/.env` doesn't exist | The token lives only in the server's memory until it stops. |
| `server/.env` exists, no token in it | After you paste a token and it passes the check, it's saved as `CONFLUENCE_TOKEN=…`. |
| `server/.env` has a valid token | It's loaded at start, and the token field is hidden. |
| `server/.env` has a token Confluence rejects | The field is shown again with a message. A new valid token replaces the old one. |

Creating `.env` is how you opt in. The tool never creates it. `.env` is in `.gitignore`, so it isn't committed. A wrong token is never saved.

### Keeping the saved token safe
Since the server can create pages with your token, it only accepts requests that are:
- **from this computer:** it listens on `127.0.0.1` only
- **from its own page:** requests from other websites, or addressed to it under any other name than `localhost` or `127.0.0.1`, are refused

Anything else running on your computer can still reach it, so on a shared machine, don't save the token.

---

## Configuration

Everything is in [`server/config.json`](server/config.json).

| Setting | Meaning |
|---|---|
| `port` | Port the server listens on. The `PORT` environment variable overrides it. |
| `appPattern` | Which top-level folders are apps, e.g. `*-app`. `*` matches anything. |
| `repoRoot` | Monorepo root, relative to the `server` folder. Empty means "the git repo this tool is inside". |
| `confluenceBaseUrl` | Confluence address. Cloud: `https://<site>.atlassian.net/wiki`. |
| `confluenceEmail` | Empty for Data Center (the token is sent as `Bearer`). For Cloud, the Atlassian account email that owns the API token. |
| `parentPageIds` | For each app, the ID of the Confluence page its release pages are created under. |
| `appsWithVerification` | Apps whose page gets the **isVerified** and **Note** columns and the info box. |
| `verificationInfo` | The text in the info box. |

`npm run dev` restarts the server when its files change; `npm start` doesn't.

---

## Files

```
README.md               This file
public/                 The form, served at http://localhost:3000/
├── index.html          The page's markup
├── style.css           All styles and CSS animations
├── form.js             The form: field checks, apps → tags, creating the page
└── effects.js          The hyperspeed intro, the heading letters and the Sith figure
server/
├── server.js           The whole server: the page, the API, git, the token and the Confluence page
├── config.json         Settings
└── .env                Your saved token (you create it; gitignored)
```

---

## API

All answers are JSON with `ok: true/false`. Errors come with a `message` and a matching HTTP status.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/token` | Whether a token is saved, and whether one can be saved. Never returns the token. |
| `POST` | `/api/verify/token` | `{ token? }`: checks the token, or the saved one when none is sent. A working token is kept for creating pages; a typed one is saved to `.env`. |
| `GET` | `/api/apps` | The app names. |
| `GET` | `/api/apps/:app/tags` | The app's `OLD` / `NEW` tag names, highest number first. |
| `POST` | `/api/release` | `{ token?, app, from, to, version, date }`: creates the release page, opens it, and returns `pageUrl` and `pullRequestCount`. |

---

## Troubleshooting

| You see | Try |
|---|---|
| **Token rejected by Confluence** | The token is wrong or expired. Create a new one. For Cloud, also set `confluenceEmail`. |
| **Could not reach Confluence** | Check `confluenceBaseUrl` in `config.json`, and that you're on the network or VPN that can reach Confluence. If the browser can open Confluence but the tool can't, your company may inspect HTTPS traffic: start Node with `NODE_EXTRA_CA_CERTS=<company-root.pem>`. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| **No parent page for &lt;app&gt;** | Add the app to `parentPageIds` in `config.json`. |
| **Parent page … not found** | The ID in `parentPageIds` is wrong, or your token can't see that page. |
| **No merged PRs in &lt;app&gt; between …** | No commit between the tags has `Merged PR` in its message and changes the app's folder. Check the tags are in the right order (OLD, then NEW). |
| **A page with this title already exists** | A release page for this app and date already exists in the space. Rename or delete it in Confluence. |
| App list says **No apps found** | No top-level folder matches `appPattern`. Check the folder names, or `repoRoot` in `config.json`. |
| **No app-x-&lt;n&gt;-OLD / -NEW tags found** | The app has no tags named like `app-x-12-OLD`. Fetch them with `git fetch --tags`. |
| Page shows **Forbidden** | Open the page as `http://localhost:3000/` or `http://127.0.0.1:3000/`. |
| `EADDRINUSE` when starting | Port 3000 is in use. Stop the other program, or start with a different `PORT`. |
| The new page doesn't open by itself | Use the **open in Confluence** link under the button. |
