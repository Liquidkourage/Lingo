# Lingo Online (Railway + Postgres)

This is the **current online migration path** for Lingo.

This folder contains the Railway/Postgres pivot for Lingo.

## What it includes

- `server.js` - Express app serving both pages and API
- `public/index.html` - player guessing page
- `public/host.html` - host dashboard
- `db/schema.sql` - Postgres schema, auto-applied on startup
- `data/words.txt` - bundled 5-letter legal word list for validation
- `import-words.js` - manual word import/sync script
- `.env.example` - local environment variables

## Required environment variables

- `DATABASE_URL` - Railway Postgres connection string
- `LINGO_ADMIN_KEY` - secret used by the host dashboard
- `PORT` - optional, defaults to `3000`

## Local run

1. Copy `.env.example` to `.env`
2. Fill in your Postgres URL and admin key
3. Run:

```bash
npm install
npm start
```

The app will automatically sync `data/words.txt` into the `words` table on startup.

Then open:

- `http://localhost:3000/` - player page
- `http://localhost:3000/host` - host dashboard

## Railway deploy

1. Create a new Railway service from this repo
2. Set the root directory to `online`
3. Add a PostgreSQL database
4. Add environment variables:
   - `DATABASE_URL` = Railway Postgres connection string
   - `LINGO_ADMIN_KEY` = your chosen host secret
5. Deploy

Railway should automatically run:

```bash
npm start
```

That startup also auto-imports the bundled legal word list into Postgres.

If you ever need to resync the word list manually, run:

```bash
npm run import-words
```

## Current scope

This is the first Railway slice, not the full game yet.

Included:

- backend-owned session state
- host controls for word / round / balls / answer reveal
- player guess submission with legal-word validation
- host inspection of accepted guesses

Still to migrate:

- scoring parity with the VB app
- public display / OBS page
- Twitch integration
- bingo flows
