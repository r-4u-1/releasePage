# Release page creator · v-7

A small local web app that creates the **Confluence release page** for one app in the monorepo.

You pick an app, two git tags, a version and a release date. The server:

1. reads the **merged PRs** of that app between the two tags from git,
2. builds a table of them (author + PR title, plus **isVerified** and **Note** for some apps),
3. creates the page `Rel of <app> - <release date>` under the app's parent page in Confluence,
4. opens the new page in your browser.

```
 Form (public/)               Local server (server/)                 Outside
┌──────────────────┐        ┌──────────────────────────────┐
│ Token status     │◀──────│ check .env token ─────────────┼──▶ Confluence
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
- [Versions](#versions)

---

## Setup

Requirements: **Node.js 22.18 or newer** (or 23.6+) and **git**. Nothing to install: the code is TypeScript, and Node runs it as it is by removing the types. The server only uses Node's built-in modules, so there's no `package.json` and no `node_modules`.

**1. Put the tool anywhere.** It doesn't need to be inside the monorepo: you enter the monorepo's absolute path in the form, and the server lists its top-level folders as apps:

```
monorepo/
├── web-app/             ← listed (matches *-app)
├── admin-app/           ← listed
└── docs/                ← not listed
```

**2. Set the Confluence address.** In [`server/config.json`](server/config.json), replace the example `confluenceBaseUrl` with yours. Use `https://`, so the token is encrypted on its way.

**3. Add each app's parent page.** In `parentPageIds`, map each app to the Confluence page its release pages go under. The page ID is in the page's address (`…pageId=123456`) or under **••• → Page information**.

**4. List the apps that need verification** in `appsWithVerification`. See [The release page](#the-release-page).

**5. Get a Confluence personal access token.** In Confluence: **your profile picture → Settings → Personal Access Tokens → Create token**.

**6. Add the token to `server/.env`** (create the file if it doesn't exist):

```
CONFLUENCE_TOKEN=<your token>
```

`server/.gitignore` already lists `.env`, so the token is never committed. See [The token](#the-token).

**7. Start the server** in the `server` folder and open **http://localhost:3000/**.

```bash
node server.ts
```

---

## Walking through the form

### 1. Absolute path to monorepo
The full path to the monorepo's folder, e.g. `C:\git\monorepo`. When you leave the field, the server checks that it's a folder in a git repository. The field then turns green and shows the repo's root folder (a folder inside the monorepo, e.g. `C:\git\monorepo\web-app`, becomes `C:\git\monorepo`), and the apps load. Otherwise it shows **There's no folder …**, **… isn't in a git repository** or **Enter the absolute path to the monorepo**.

All git commands run in that folder. The browser remembers it, so it's filled in and checked again next time.

### 2. Confluence token
There's no token field. At the top of the form you see whether the server found a working token in `server/.env`:

- **● Confluence token found in .env · Authenticated as &lt;you&gt;** (green): ready.
- **● No Confluence token found. Add the line CONFLUENCE_TOKEN=&lt;your token&gt; to …\.env** (red): add it, then click **Check again**. No restart needed.
- **● Confluence rejected the token in …\.env** (red): the token is wrong or expired. Replace it, then click **Check again**.

**Create page** doesn't run until the token works.

### 3. App
A list of the top-level folders in the monorepo, loaded once the path checks out. Picking an app loads its git tags into **From tag** and **To tag**.

### 4. Version and Date
Shown on the page; the date is also in the page title. You can type the date as numbers (dashes are added for you) or pick it from the calendar.

### 5. From tag (OLD) and To tag (NEW)
Filled with the app's tags. The newest `OLD` / `NEW` pair is picked for you.

### 6. Create page
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
│ │ Alice  │ Add …        │            │      │     │ ╰──────────────╯ │
│ └────────┴──────────────┴────────────┴──────┘     │                  │
└───────────────────────────────────────────────────┴──────────────────┘
```

- **isVerified** and **Note** are empty, for people to fill in on the page.
- The info box is Confluence's own **Info** panel, which has rounded corners. Confluence doesn't allow custom styles in page content, so its look is Confluence's.

---

## How apps, tags and PRs are found

**Apps** are the top-level folders of the monorepo whose name matches `appPattern` in `config.json`. The default is `*-app`, so `web-app` and `admin-app` are apps, but `docs`, `shared-lib` or `app-web` are not. `*` matches anything.

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

The server reads the token from **`server/.env`**, from this line:

```
CONFLUENCE_TOKEN=<your token>
```

Quotes around the token are fine. The file is read again on every check, so adding or changing the token works without restarting the server.

The token **never reaches the page**: the form only learns whether it works and whose it is. The tool never writes to `.env`.

### Keeping the token safe
- **Kept out of git:** `server/.gitignore` lists `.env`.
- **Only this tool reads it:** a token in the monorepo's root `.env` could be loaded by other tools there (dev servers, Docker Compose, build tools). In `server/.env`, only this server sees it.
- **The server only accepts requests from this computer:** it listens on `127.0.0.1` only.
- **And only from its own page:** requests from other websites, or addressed to it under any other name than `localhost` or `127.0.0.1`, are refused.
- **And only from a page it served:** each start makes a new random page token, puts it in the page, and refuses API calls that don't send it back as `X-Token`.

Anything else running on your computer can still reach it, so don't keep the token in `.env` on a shared machine.

---

## Configuration

Everything is in [`server/config.json`](server/config.json).

| Setting | Meaning |
|---|---|
| `port` | Port the server listens on. The `PORT` environment variable overrides it. |
| `appPattern` | Which top-level folders are apps, e.g. `*-app`. `*` matches anything. |
| `confluenceBaseUrl` | Confluence address. Cloud: `https://<site>.atlassian.net/wiki`. |
| `confluenceEmail` | Empty for Data Center (the token is sent as `Bearer`). For Cloud, the Atlassian account email that owns the API token. |
| `parentPageIds` | For each app, the ID of the Confluence page its release pages are created under. |
| `appsWithVerification` | Apps whose page gets the **isVerified** and **Note** columns and the info box. |
| `verificationInfo` | The text in the info box. |

A change to `config.json` or the server's `.ts` files needs a restart; `node --watch server.ts` restarts it by itself when a server file changes. A change to `client/` or `public/` only needs a page reload.

---

## Files

```
README.md               This file
client/                 The form's scripts, in TypeScript. Served as /form.js and /effects.js, types removed
├── form.ts             The form: field checks, apps → tags, creating the page
├── effects.ts          The hyperspeed intro, the heading letters and the Sith figure
└── tsconfig.json       How the editor checks them
public/                 The form, served at http://localhost:3000/
├── index.html          The page's markup
└── style.css           All styles and CSS animations
server/
├── server.ts           What each API path does, and which path runs what
├── lib/                The details server.ts uses
│   ├── settings.ts     config.json, the port, the paths and Confluence's address
│   ├── helpers.ts      fail() and other small helpers
│   ├── git.ts          Apps, tags and merged PRs
│   ├── token.ts        Reads the token from .env
│   ├── confluence.ts   Checks the token, creates the page
│   ├── release-page-content.ts  The page's table and info box
│   ├── browser.ts      Opens the new page in the browser
│   └── web.ts          Who may call the server, reading requests, sending answers
├── tsconfig.json       How the editor checks the server
├── config.json         Settings
└── .env                Your Confluence token (you create it; gitignored)
```

---

## API

All answers are JSON with `ok: true/false`. Errors come with a `message` and a matching HTTP status.

Every API call needs the `X-Token` header: a random page token the server makes each time it starts and puts in `index.html`. Without it (or after a restart, until the page is reloaded) the answer is `403`.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/folder?path=…` | Checks that the absolute path is a folder in a git repository. Returns `folder`: the repo's root, which the form sends with every later request. |
| `GET` | `/api/token` | Checks the token in `server/.env` with Confluence. Returns `message` ("Authenticated as …"), or an error saying the token is missing or rejected. Never returns the token. |
| `GET` | `/api/apps?repo=…` | The app names in that repo. |
| `GET` | `/api/tags?repo=…&app=…` | The app's `OLD` / `NEW` tag names, highest number first. |
| `POST` | `/api/release` | `{ repo, app, from, to, version, date }`: creates the release page, opens it, and returns `pageUrl` and `pullRequestCount`. |

---

## Versions

| Version | What was added |
|---|---|
| v-1 | The bare minimum: one server file and a plain form. You type an app and two tags, and it lists the merged PRs from git. The monorepo folder is set in `config.json`. |
| v-2 | Creates the Confluence page (a table of the PRs) with the token from `server/.env`, and shows a link to it. |
| v-3 | A monorepo path field, and lists of apps and tags to pick from. The server is split into `lib/`. First styles. |
| v-4 | The real PR author, isVerified and Note columns plus an info box for some apps, the token status line, and the new page opens by itself. |
| v-5 | Every feature of the final app: TypeScript form, field checks, calendar, intro animations, Confluence Cloud. Few safety checks. |
| v-6 | Safe input: git runs without a shell, every value is checked, HTML is escaped, requests are size-limited, internal errors stay in the terminal. |
| v-7 | Locked to this computer: listens on 127.0.0.1 only, refuses other websites, needs a random page token, and serves only known files. Confluence calls time out. |
