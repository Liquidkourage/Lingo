# Lingo

This repo currently contains **three different paths**:

| Path | Status | Purpose |
| --- | --- | --- |
| `online/` | Current | Railway + Postgres browser app. This is the active path for moving Lingo online. |
| `Lingo/` | Active legacy app | VB.NET WinForms desktop production app, including Firestore/bingo work. |
| `web/` + `functions/` + `firebase.json` | Legacy prototype | Early Firebase-hosted browser prototype kept for reference. |

## What to open first

- If you want the **current online app**, start in `online/`.
- If you want the **existing desktop show controller**, start in `Lingo/`.
- If you are only looking for the old Firebase experiment, see `web/` and `functions/`.

## Useful commands

From the repo root:

```bash
npm run online:start
npm run online:lint
```

Firebase prototype helpers are still available, but are not the primary path:

```bash
npm run firebase:emulators
npm run firebase:deploy
npm run firebase:functions:lint
```

## Directory notes

### `online/`
Railway/Postgres Express app:
- `server.js`
- `public/index.html`
- `public/host.html`
- `db/schema.sql`

### `Lingo/`
Desktop WinForms app:
- `Form1.vb`
- `PublicDisplay.vb`
- built-in bingo host form
- Firestore listener code

### `web/`
Legacy static browser pages from the Firebase prototype.

### `functions/`
Legacy Firebase Functions backend prototype.
