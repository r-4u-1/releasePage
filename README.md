# Release page creator

A small local web app that turns the git history of one app in the monorepo into a **release page in Confluence**.

You pick an app and two git tags. The app reads every change between those tags and creates a child page under that app's release page in Confluence, with a table of who did what and two checkbox columns for accessibility (a11y) review.

```
 Form (public/)               Local server (server/)                   Outside
┌──────────────────┐        ┌───────────────────────────────┐
│ Token            │──────▶│ check token ───────────────────┼──▶ Confluence
│ App              │──────▶│ list apps / tags ──────────────┼──▶ git (app folder)
│ Parent page ID   │──────▶│ check page ────────────────────┼──▶ Confluence
│ Version, Date    │        │                               │
│ From / To tag    │──────▶│ read git log ──────────────────┼──▶ git (app folder)
│ [Create page]    │──────▶│ build table, create page ──────┼──▶ Confluence
└──────────────────┘        └───────────────────────────────┘
```

---

## Contents

- [Quick start (fake mode)](#quick-start-fake-mode)
- [Using it for real](#using-it-for-real)
- [Walking through the form](#walking-through-the-form)
- [The page it creates](#the-page-it-creates)
- [How apps and tags are found](#how-apps-and-tags-are-found)
- [The token](#the-token)
- [Configuration](#configuration)
- [Real and fake mode](#real-and-fake-mode)
- [Files](#files)
- [API](#api)
- [Troubleshooting](#troubleshooting)

---

## Quick start (fake mode)

Fake mode needs no Confluence and no real repo. It creates a fake monorepo and runs a fake Confluence, so you can try the whole flow safely.

Requirements: **Node.js 18.11 or newer** (tested on 22) and **git**. Nothing else to install: the tool only uses Node's built-in modules, so there is no `npm install` and no `node_modules`.

```bash
cd server
npm run fake
```

Open **http://localhost:3000/** and:

1. Paste the token **`demo-token`**.
2. Pick **app-a** or **app-b**. The parent page ID fills in by itself.
3. Enter a **Version** (e.g. `1.0.0`) and a **Date**.
4. Check the list of changes, then click **Create page**.
5. Click **open in Confluence** to see the page the fake Confluence made.

| Fake app | Fake parent page ID | Tags |
|---|---|---|
| `app-a` | `100001` (App A releases) | `app-a-1-OLD` / `app-a-1-NEW`, `app-a-2-OLD` / `app-a-2-NEW` |
| `app-b` | `100002` (App B releases) | `app-b-1-OLD` / `app-b-1-NEW` |

All fake data lives in `server/.fake/`, which git ignores. To start again from fresh fake data:

```bash
npm run fake -- --reset
```

The fake Confluence keeps created pages only in memory, so they are gone after a restart.

---

## Using it for real

**1. Put the tool in the monorepo.** The server lists the monorepo's top-level folders as apps, so it should live inside the monorepo, for example:

```
monorepo/
├── web-app/             ← listed (matches *-app)
├── admin-app/           ← listed
├── docs/                ← not listed
└── release-page/        ← this tool (not listed)
    ├── public/
    └── server/
```

**2. Nothing to install.** No `npm install` is needed. You only need Node.js 18.11+ and git.

**3. Set the Confluence address.** In [`server/config.json`](server/config.json), under `environments.real`, replace the example URL with yours:

```json
"confluenceBaseUrl": "https://confluence.your-company.com"
```

Leave `confluenceEmail` empty for self-hosted Confluence (Data Center / Server).

**4. Get a Confluence personal access token.** In Confluence: **your profile picture → Settings → Personal Access Tokens → Create token**. The token can only do what your own Confluence user can do.

**5. (Optional) Let the tool remember the token.** Create an empty `.env` file in the `server` folder. See [The token](#the-token).

```bash
touch .env
```

**6. Start the server.**

```bash
npm run dev
```

The terminal shows which environment is running:

```
Server running at http://localhost:3000/ (real: https://confluence.your-company.com)
```

**7. Open http://localhost:3000/** and fill in the form. For the first real run, create a test page under a parent page you don't mind cluttering.

---

## Walking through the form

Fields are checked as you go: when you leave a field, and also about half a second after you stop typing in the token and page ID fields. A green check means the field is fine. A red message says what's wrong.

### 1. Confluence token
Paste your personal access token. The server asks Confluence who the token belongs to. If it works, you see a green check, and **Authenticated as &lt;your name&gt;** shows when the token comes from `.env`.

If a valid token is already saved in `.env`, this field is replaced by **● Using the token saved in .env**. Click **Use a different token** to type another one.

### 2. App
A list of the top-level folders in the monorepo. Picking an app:
- fills in its saved **Parent page ID**, if there is one
- loads its git tags into **From tag** and **To tag**

### 3. Parent page ID
The ID of the Confluence page the release page will be created under, usually the app's "releases" page. To find a page's ID in Confluence, open the page, then **••• → Page information**. The ID is the number at the end of the address (`pageId=123456`).

The server checks that the token can open this page. The hint under the field shows the page's title and whether the ID is saved for the app:

| Hint | Meaning |
|---|---|
| saved for app-a | This is app-a's saved parent page. |
| will be saved for app-a after the page is created | app-a has no saved parent yet. This one is remembered after a page is created successfully. |
| replaces the saved parent for app-a after the page is created | You typed a different ID than the saved one. It becomes the new saved one after a successful page. |

Saved parents are kept in `parents.json`. Commit that file so the whole team shares them.

### 4. Version and Date
Together they make the page title: **`Release <version> <date>`**, e.g. `Release 1.4.0 2026-10-14`. You can type the date as numbers (dashes are added for you) or pick it from the calendar.

### 5. From tag (OLD) and To tag (NEW)
Filled with the app's tags. The newest `OLD` / `NEW` pair is picked for you. Below them, a preview lists every change between the two tags, with its author and PR title. This is exactly what will go on the page.

### 6. Create page
Creates the page and shows a link to it. If something goes wrong, Confluence's own message is shown, e.g. *"A page with this title already exists"*.

---

## The page it creates

A child page of the parent page, in the parent's space, titled `Release <version> <date>`:

> **App:** app-a · **Tags:** `app-a-2-OLD` → `app-a-2-NEW` · **Date:** 2026-10-14
>
> | Author | PR | Affects a11y | No a11y impact |
> |---|---|---|---|
> | Alice | Show validation errors next to each field (#106) | ☐ | ☐ |
> | Frank | New date picker with screen reader announcements (#105) | ☐ | ☐ |

- **Author:** the person who wrote the change. For a merged pull request, that's the author of the PR, not the person who clicked merge.
- **PR:** the pull request title, cut to 80 characters, with the PR number when there is one.
- **Affects a11y / No a11y impact:** empty Confluence checkboxes. The team ticks one per row on the page.

The server reads the git log again when the page is created, so the page always matches the tags, whatever the browser showed.

---

## How apps and tags are found

**Apps** are the top-level folders of the monorepo whose name matches `appPattern` in `config.json`. The default is `*-app`, so `web-app` and `admin-app` are apps, but `docs`, `shared-lib` or `app-web` are not. `*` matches anything. Folders starting with `.`, `node_modules`, and the folder this tool lives in are always left out.

The fake environment uses `app-*` instead, to match its fake apps `app-a` and `app-b`.

**Tags** must be named after the app folder:

```
<app>-<number>-OLD     e.g. web-app-12-OLD
<app>-<number>-NEW     e.g. web-app-12-NEW
```

**Changes** are read from inside the app's folder, like running:

```bash
cd web-app
git log --first-parent web-app-12-OLD..web-app-12-NEW -- .
```

- `-- .` keeps only commits that changed something in that app's folder, so another app's work never shows up.
- `--first-parent` gives one row per merged pull request, instead of every small commit inside it.
- PR titles are taken from the merge commit message (GitHub, GitLab and Bitbucket style) or, for squash merges, from the commit subject.

---

## The token

The token is **never saved by the page and never sent back to the browser**.

| Situation | What happens |
|---|---|
| `server/.env` doesn't exist | The token is used only while you have the page open. You paste it each time. |
| `server/.env` exists, no token in it | After you paste a token and it passes the check, it's saved as `CONFLUENCE_TOKEN=…`. |
| `server/.env` has a valid token | The token field is hidden. The server uses the saved token. |
| `server/.env` has a token Confluence rejects | The field is shown again with a message. A new valid token replaces the old one. |

Creating `.env` is how you opt in. The tool never creates the real one. `.env` is in `.gitignore`, so it isn't committed. A wrong token is never saved.

### Keeping the saved token safe
Since the server can act with your saved token, it only accepts requests that are:
- **from this computer:** it listens on `127.0.0.1` only (`host` in `config.json`)
- **from its own page:** requests from other websites, or addressed to it under any other name than `localhost` or `127.0.0.1`, are refused

Anyone logged into your computer can still read `.env`, as with any `.env` file. If you ever run the server for others on a network, put it behind HTTPS, because the token would otherwise travel unencrypted.

---

## Configuration

Everything is in [`server/config.json`](server/config.json). The top-level values apply to every environment; an environment only lists what it changes. Paths are relative to the `server` folder.

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "publicDir": "../public",
  "appPattern": "*-app",
  "repoRoot": "",
  "parentsFile": "parents.json",
  "envFile": ".env",
  "confluenceEmail": "",
  "environments": {
    "real": { "confluenceBaseUrl": "https://confluence.example.com" },
    "fake": { "fake": true, "confluenceBaseUrl": "http://localhost:3999", "appPattern": "app-*", ... }
  }
}
```

| Setting | Meaning |
|---|---|
| `port` | Port the server listens on. The `PORT` environment variable overrides it. |
| `host` | Address the server listens on. Keep `127.0.0.1`. |
| `publicDir` | The folder with the form page. Only the files in it can be fetched. |
| `appPattern` | Which top-level folders are apps, e.g. `*-app`. `*` matches anything. |
| `repoRoot` | Monorepo root. Empty means "the git repo this tool is inside". |
| `parentsFile` | The saved app → parent page ID list. |
| `envFile` | The file the token is read from and saved to. |
| `confluenceBaseUrl` | Confluence address. Data Center: `https://confluence.your-company.com`. Cloud: `https://<site>.atlassian.net/wiki`. |
| `confluenceEmail` | Empty for Data Center (the token is sent as `Bearer`). For Cloud, the Atlassian account email that owns the API token. |
| `fake` | `true` starts the fake repo and fake Confluence first. |

---

## Real and fake mode

| Command (from `server/`) | Environment | Git repo | Confluence |
|---|---|---|---|
| `npm run dev` | real | your monorepo | yours, from `config.json` |
| `npm start` | real (no auto-restart) | your monorepo | yours |
| `npm run fake` | fake | `.fake/repo` | fake, on `localhost:3999` |
| `node server.js --env=<name>` | any environment in `config.json` | from config | from config |

`npm run dev` and `npm run fake` restart the server when you change a file. To add another environment, such as `staging`, add an entry under `environments` with the settings it changes, and run `node server.js --env=staging`.

---

## Files

```
README.md               This file
public/                 The form, served at http://localhost:3000/
├── index.html          The page's markup
├── style.css           All styles and CSS animations
├── form.js             The form: field checks, apps → tags → changes, creating the page
└── effects.js          The hyperspeed intro, the heading letters and the Sith figure
server/
├── config.json         Settings, plus what each environment changes
├── config.js           Reads config.json and the --fake / --env= flag
├── server.js           All routes: the page and the API
├── web.js              Tiny web framework on Node's built-in http module
├── git.js              Lists apps and tags, reads the git log
├── confluence.js       Confluence REST calls, and the release page's content
├── storage.js          Reads and saves parents.json and the token in .env
├── fake.js             Fake monorepo + fake Confluence for --fake
├── parents.json        Saved app → parent page IDs (created on first page; commit it)
├── .env                Your saved token (you create it; gitignored)
└── .fake/              Generated fake data (gitignored)
```

---

## API

The page uses these endpoints. All answers are JSON with `ok: true/false`. Errors come with a `message` and a matching HTTP status (400, 401, 404, …).

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/token` | Whether a token is saved, and whether one can be saved. Never returns the token. |
| `POST` | `/api/verify/token` | `{ token? }`: checks the token, or the saved one when none is sent. Saves a typed token that passes. |
| `POST` | `/api/verify/page` | `{ token?, pageId }`: checks that the token can open the page, and returns its title. |
| `GET` | `/api/apps` | The apps, each with its saved parent page ID. |
| `GET` | `/api/apps/:app/tags` | The app's `OLD` / `NEW` tag names, highest number first. |
| `GET` | `/api/apps/:app/changes?from=&to=` | The changes between two of the app's tags. |
| `POST` | `/api/release` | `{ token?, app, pageId, version, date, from, to }`: creates the page and saves the parent for the app. |

App names and tags are only accepted if they match a real app folder and that app's own tags, so nothing else reaches `git`.

---

## Troubleshooting

| You see | Try |
|---|---|
| **Token rejected by Confluence** | The token is wrong or expired. Create a new one. For Cloud, also set `confluenceEmail`. |
| **Could not reach Confluence** | Check `confluenceBaseUrl` in `config.json`, and that you're on the network or VPN that can reach Confluence. |
| **Verify the token first** | The parent page is checked with the token, so the token needs its green check first. |
| **Not found on Confluence** (page ID) | Wrong page ID, or your user can't see that page. |
| App list says **No apps found** | No top-level folder matches `appPattern` (default `*-app`). Check the folder names, or `repoRoot` in `config.json`. |
| **No app-x-&lt;n&gt;-OLD / -NEW tags found** | The app has no tags named like `app-x-12-OLD`. Fetch them with `git fetch --tags`. |
| **No changes in … between …** | No commit between those tags touched that app's folder. |
| **A page with this title already exists** | Confluence titles must be unique per space. Use another version or date, or rename the old page. |
| Page shows **Forbidden** | Open the page as `http://localhost:3000/` or `http://127.0.0.1:3000/`, not through another address. |
| Apps don't load / **Server unreachable** | The server isn't running (start it with `npm run dev` or `npm run fake`), or the HTML file was opened directly. Open it through the server's address. |
| `EADDRINUSE` when starting | Port 3000 (or 3999 in fake mode) is in use. Stop the other program, or start with a different `PORT`. |
