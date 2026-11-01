# Release page creator

## Run it

Requires **Node.js 22.18 or newer** (it runs the TypeScript as it is) and **git**.

1. Set `repo` in [`server/config.json`](server/config.json) to the monorepo's folder.
2. Start the server in the `server` folder and open **http://localhost:3000/**:

```bash
node server.ts
```

## How the PRs are found

A merged PR is a commit between the two tags that:
- is on the main line (`--first-parent`),
- has **Merged PR** in its message, e.g. `Merged PR 1234: Add keyboard navigation`,
- changed something in the app's folder.

The list shows who made the merge commit and the PR's title.

## Files

```
public/index.html   The form, with its script inline
server/server.ts    Serves the form and answers POST /api/release
server/config.json  The port and the monorepo's folder
```

## Versions

| Version | What was added |
|---|---|
| v-1 | The bare minimum: one server file and a plain form. You type an app and two tags, and it lists the merged PRs from git. The monorepo folder is set in `config.json`. |
