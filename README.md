# Release page creator

A small local web app that starts the **release script** for one app in the monorepo.

You pick an app, two git tags, a version and a release date. The server checks your Confluence token, makes it available to the script as the `CONFLUENCE_TOKEN` environment variable, and runs:

```bash
bash release.sh <from-tag> <to-tag> <app> <version> <release-date>
```

The script reads the merged PRs between the two tags from git and creates the release page in Confluence.

```
 Form (public/)               Local server (server/)                   Outside
┌──────────────────┐        ┌───────────────────────────────┐
│ Token            │──────▶│ check token ───────────────────┼──▶ Confluence
│                  │        │ → process.env.CONFLUENCE_TOKEN │
│ App              │──────▶│ list apps / tags ──────────────┼──▶ git (app folder)
│ Version, Date    │        │                               │
│ From / To tag    │        │                               │
│ [Create page]    │──────▶│ run release.sh ────────────────┼──▶ git log, Confluence
└──────────────────┘        └───────────────────────────────┘
```

---

## Contents

- [Setup](#setup)
- [Walking through the form](#walking-through-the-form)
- [The release script](#the-release-script)
- [How apps and tags are found](#how-apps-and-tags-are-found)
- [The token](#the-token)
- [Configuration](#configuration)
- [Files](#files)
- [API](#api)
- [Troubleshooting](#troubleshooting)

---

## Setup

Requirements: **Node.js 18.11 or newer**, **git** and **bash** (Git Bash on Windows). Nothing to install: the server only uses Node's built-in modules.


**1. Put the tool in the monorepo.** The server lists the monorepo's top-level folders as apps, and runs the script from the monorepo root:

```
monorepo/
├── web-app/             ← listed (matches *-app)
├── admin-app/           ← listed
├── docs/                ← not listed
└── release-page/        ← this tool (not listed)
    ├── public/
    └── server/
        └── release.sh   ← the release script
```

**2. Add the release script** as `server/release.sh`, or point `releaseScript` in [`server/config.json`](server/config.json) at it. See [The release script](#the-release-script).

**3. Set the Confluence address.** In `server/config.json`, replace the example `confluenceBaseUrl` with yours. It's used to check the token, and passed to the script as `CONFLUENCE_BASE_URL`.

**4. On Windows, check `bash`.** From PowerShell, `bash` may be WSL's `bash.exe`, which can't run a script under `C:\`. Set `"bash"` in `config.json` to Git Bash, e.g. `"C:/Program Files/Git/bin/bash.exe"`.

**5. Get a Confluence personal access token.** In Confluence: **your profile picture → Settings → Personal Access Tokens → Create token**.

**6. (Optional) Let the tool remember the token.** Create an empty `.env` file in the `server` folder. See [The token](#the-token).

**7. Start the server** and open **http://localhost:3000/**.

```bash
npm run dev
```

---

## Walking through the form

### 1. Confluence token
Paste your personal access token. The server asks Confluence who the token belongs to. If it works, you see a green check, and the server keeps it as `CONFLUENCE_TOKEN` for the script.

If a valid token is already saved in `.env`, this field is replaced by **● Using the token saved in .env**. Click **Use a different token** to type another one.

### 2. App
A list of the top-level folders in the monorepo. Picking an app loads its git tags into **From tag** and **To tag**.

### 3. Version and Date
Passed to the script as they are. You can type the date as numbers (dashes are added for you) or pick it from the calendar.

### 4. From tag (OLD) and To tag (NEW)
Filled with the app's tags. The newest `OLD` / `NEW` pair is picked for you.

### 5. Create page
Runs the release script. When it's done, its last output line is shown under the button. If that line is a URL (e.g. the new page's address), it's shown as an **open in Confluence** link. If the script fails, its last error line is shown.

---

## The release script

The server runs it as:

```bash
bash <releaseScript> <from-tag> <to-tag> <app> <version> <release-date>
#     e.g.           web-app-12-OLD web-app-12-NEW web-app 1.4.0 2026-10-14
```

| | |
|---|---|
| Working directory | the monorepo root |
| `CONFLUENCE_TOKEN` | the verified token (never passed as an argument, so it doesn't show up in process lists) |
| `CONFLUENCE_BASE_URL` | `confluenceBaseUrl` from `config.json` |
| `CONFLUENCE_EMAIL` | `confluenceEmail` from `config.json` (empty for Data Center) |
| Exit code | `0` = success. Anything else is shown as an error, with the last line of stderr. |
| Output | Printed in the server's terminal. Print the page URL as the last line to get a link in the form. |
| Timeout | 5 minutes |

The server only starts the script for an app folder that exists and two tags that belong to that app, so the arguments are always a known app and real tags. Arguments are passed directly, never through a shell.

---

## How apps and tags are found

**Apps** are the top-level folders of the monorepo whose name matches `appPattern` in `config.json`. The default is `*-app`, so `web-app` and `admin-app` are apps, but `docs`, `shared-lib` or `app-web` are not. `*` matches anything. Folders starting with `.`, `node_modules`, and the folder this tool lives in are always left out.

**Tags** must be named after the app folder:

```
<app>-<number>-OLD     e.g. web-app-12-OLD
<app>-<number>-NEW     e.g. web-app-12-NEW
```

---

## The token

The token is **never saved by the page and never sent back to the browser**.

| Situation | What happens |
|---|---|
| `server/.env` doesn't exist | The token lives only in the server's memory (`process.env.CONFLUENCE_TOKEN`) until it stops. |
| `server/.env` exists, no token in it | After you paste a token and it passes the check, it's saved as `CONFLUENCE_TOKEN=…`. |
| `server/.env` has a valid token | It's loaded into `process.env.CONFLUENCE_TOKEN` at start, and the token field is hidden. |
| `server/.env` has a token Confluence rejects | The field is shown again with a message. A new valid token replaces the old one. |

Creating `.env` is how you opt in. The tool never creates the real one. `.env` is in `.gitignore`, so it isn't committed. A wrong token is never saved.

### Keeping the saved token safe
Since the server can run the script with your token, it only accepts requests that are:
- **from this computer:** it listens on `127.0.0.1` only
- **from its own page:** requests from other websites, or addressed to it under any other name than `localhost` or `127.0.0.1`, are refused

---

## Configuration

Everything is in [`server/config.json`](server/config.json). Paths are relative to the `server` folder.

| Setting | Meaning |
|---|---|
| `port` | Port the server listens on. The `PORT` environment variable overrides it. |
| `appPattern` | Which top-level folders are apps, e.g. `*-app`. `*` matches anything. |
| `repoRoot` | Monorepo root, and where the script runs. Empty means "the git repo this tool is inside". |
| `bash` | The bash that runs the script. On Windows, use Git Bash's `bash.exe`. |
| `releaseScript` | The release script, `release.sh` by default. |
| `confluenceBaseUrl` | Confluence address, for the token check and the script. Cloud: `https://<site>.atlassian.net/wiki`. |
| `confluenceEmail` | Empty for Data Center (the token is sent as `Bearer`). For Cloud, the Atlassian account email that owns the API token. |

`npm run dev` restarts the server when its files change; `npm start` doesn't.

---

## Files

```
README.md               This file
public/                 The form, served at http://localhost:3000/
├── index.html          The page's markup
├── style.css           All styles and CSS animations
├── form.js             The form: field checks, apps → tags, starting the release
└── effects.js          The hyperspeed intro, the heading letters and the Sith figure
server/
├── server.js           The whole server: the page, the API, git, the token and the release script
├── config.json         Settings
├── release.sh          The real release script (you add it)
└── .env                Your saved token (you create it; gitignored)
```

---

## API

All answers are JSON with `ok: true/false`. Errors come with a `message` and a matching HTTP status.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/token` | Whether a token is saved, and whether one can be saved. Never returns the token. |
| `POST` | `/api/verify/token` | `{ token? }`: checks the token, or the saved one when none is sent. A working token becomes `CONFLUENCE_TOKEN`; a typed one is saved to `.env`. |
| `GET` | `/api/apps` | The app names. |
| `GET` | `/api/apps/:app/tags` | The app's `OLD` / `NEW` tag names, highest number first. |
| `POST` | `/api/release` | `{ token?, app, from, to, version, date }`: runs the release script and returns its `output`. |

---

## Troubleshooting

| You see | Try |
|---|---|
| **Token rejected by Confluence** | The token is wrong or expired. Create a new one. For Cloud, also set `confluenceEmail`. |
| **Could not reach Confluence** | Check `confluenceBaseUrl` in `config.json`, and that you're on the network or VPN that can reach Confluence. |
| **Release script failed: "bash" not found** | Set `bash` in `config.json` to the full path of Git Bash's `bash.exe`. |
| **Release script failed: … No such file** | `releaseScript` doesn't point at the script, or `bash` is WSL's (see [Using it for real](#using-it-for-real), step 4). |
| **Release script failed: &lt;message&gt;** | The script exited non-zero; the message is its last error line. The full output is in the server's terminal. |
| App list says **No apps found** | No top-level folder matches `appPattern`. Check the folder names, or `repoRoot` in `config.json`. |
| **No app-x-&lt;n&gt;-OLD / -NEW tags found** | The app has no tags named like `app-x-12-OLD`. Fetch them with `git fetch --tags`. |
| Page shows **Forbidden** | Open the page as `http://localhost:3000/` or `http://127.0.0.1:3000/`. |
| `EADDRINUSE` when starting | Port 3000 is in use. Stop the other program, or start with a different `PORT`. |
