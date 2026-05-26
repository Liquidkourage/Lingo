# Online Lingo

This repo now contains the first browser-hosted slice of the Lingo migration:

- `web/index.html` - browser player guessing page
- `web/host.html` - browser host dashboard
- `functions/index.js` - backend-owned session API
- `web/bingo.html` - existing player-side bingo page
- `firebase.json` / `.firebaserc` - Hosting + Functions wiring

## Backend state

The current online session lives in Firestore at:

- `onlineGameState/current`

Current host actions:

- create/reset session
- set current word
- start round
- reveal results
- continue round
- toggle 2x balls
- set remaining balls
- reveal answer

Current public/player actions:

- load public session state
- submit a 5-letter guess during the guessing phase
- persist player display name in local storage

Current host inspection:

- load per-session accepted player guesses from the backend

## Deploy prerequisites

1. Install dependencies:
   - root: `npm install`
   - functions: `npm install`
2. Set the Firebase Functions secret:
   - `npx firebase-tools functions:secrets:set LINGO_ADMIN_KEY`
3. Deploy:
   - `npx firebase-tools deploy --only functions,hosting`

## Current scope

This is intentionally a first slice, not a full replacement for the VB app yet.

What is online now:

- host controls for Lingo round/session state
- player guess submissions at `web/index.html`
- host-side inspection of accepted guesses
- backend-owned API for those controls
- Firebase Hosting scaffold in this repo

What still needs migration later:

- player guessing flow tied to the online session
- OBS/public display page
- scoring engine parity with the VB app
- online bingo validation/host claims view
