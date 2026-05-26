const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);
const adminKey = String(process.env.LINGO_ADMIN_KEY || "").trim();
const databaseUrl = String(process.env.DATABASE_URL || "").trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});

const staticDir = path.join(__dirname, "public");
const schemaPath = path.join(__dirname, "db", "schema.sql");

app.use(express.json());
app.use(express.static(staticDir));

function nowIso() {
  return new Date().toISOString();
}

function validateWord(word) {
  return /^[A-Z]{5}$/.test(word);
}

function normalizeDisplayName(displayName) {
  return String(displayName || "").trim();
}

function normalizePlayerKey(displayName) {
  return normalizeDisplayName(displayName).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase() || "player";
}

function requireAdmin(req, res, next) {
  const provided = String(req.get("x-lingo-admin-key") || "").trim();
  if (!adminKey || provided !== adminKey) {
    res.status(401).json({ ok: false, error: "Invalid admin key." });
    return;
  }
  next();
}

async function ensureSchema() {
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

function serializeState(row) {
  if (!row) return null;
  return {
    version: row.version,
    mode: row.mode,
    phase: row.phase,
    sessionId: row.session_id,
    roundNumber: row.round_number,
    currentWord: row.current_word,
    answerRevealed: row.answer_revealed,
    ballMultiplier: row.ball_multiplier,
    ballsRemaining: row.balls_remaining,
    guessWindowSeconds: row.guess_window_seconds,
    resultsWindowSeconds: row.results_window_seconds,
    hostNote: row.host_note,
    guessWindowOpenedAtIso: row.guess_window_opened_at ? new Date(row.guess_window_opened_at).toISOString() : null,
    resultsWindowOpenedAtIso: row.results_window_opened_at ? new Date(row.results_window_opened_at).toISOString() : null,
    updatedAtIso: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function serializePublicState(row) {
  const state = serializeState(row);
  if (!state) return null;
  const publicFirstLetter = state.currentWord ? `${state.currentWord.charAt(0).toUpperCase()}....` : "";
  return {
    ...state,
    publicFirstLetter,
    revealedWord: state.answerRevealed ? state.currentWord : "",
    currentWord: state.answerRevealed ? state.currentWord : "",
  };
}

async function getState(client = pool) {
  const result = await client.query("select * from app_state where id = 1");
  return result.rows[0];
}

async function updateState(patch, client = pool) {
  const state = await getState(client);
  const next = {
    ...state,
    ...patch,
  };

  const params = [
    next.version,
    next.mode,
    next.phase,
    next.session_id,
    next.round_number,
    next.current_word,
    next.answer_revealed,
    next.ball_multiplier,
    next.balls_remaining,
    next.guess_window_seconds,
    next.results_window_seconds,
    next.host_note,
    next.guess_window_opened_at || null,
    next.results_window_opened_at || null,
  ];

  const result = await client.query(
    `update app_state
     set version = $1,
         mode = $2,
         phase = $3,
         session_id = $4,
         round_number = $5,
         current_word = $6,
         answer_revealed = $7,
         ball_multiplier = $8,
         balls_remaining = $9,
         guess_window_seconds = $10,
         results_window_seconds = $11,
         host_note = $12,
         guess_window_opened_at = $13,
         results_window_opened_at = $14,
         updated_at = now()
     where id = 1
     returning *`,
    params
  );

  return result.rows[0];
}

async function listPlayers(sessionId) {
  const result = await pool.query(
    `select p.*,
            (
              select count(*)
              from guess_submissions gs
              where gs.player_id = p.id
            ) as submission_count
     from players p
     where p.session_id = $1
     order by p.display_name asc`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    displayName: row.display_name,
    normalizedDisplayName: row.normalized_display_name,
    currentGuess: row.current_guess,
    roundNumber: row.round_number,
    firstLetter: row.first_letter,
    submittedAtIso: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    updatedAtIso: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    submissionCount: Number(row.submission_count || 0),
  }));
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/public-state", async (_req, res) => {
  try {
    const state = await getState();
    res.json({ ok: true, state: serializePublicState(state) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/submit-guess", async (req, res) => {
  const displayName = normalizeDisplayName(req.body.displayName);
  const guess = String(req.body.guess || "").trim().toUpperCase();

  if (!displayName) {
    res.status(400).json({ ok: false, error: "Display name is required." });
    return;
  }
  if (!validateWord(guess)) {
    res.status(400).json({ ok: false, error: "Guess must be exactly 5 letters." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const state = await getState(client);
    if (state.phase !== "guessing") {
      throw new Error("Guesses are only accepted during the guessing phase.");
    }
    if (!state.current_word) {
      throw new Error("The host has not set a word yet.");
    }

    const upsertResult = await client.query(
      `insert into players (
         session_id,
         display_name,
         normalized_display_name,
         current_guess,
         round_number,
         first_letter,
         submitted_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, now(), now())
       on conflict (session_id, normalized_display_name)
       do update set
         display_name = excluded.display_name,
         current_guess = excluded.current_guess,
         round_number = excluded.round_number,
         first_letter = excluded.first_letter,
         submitted_at = now(),
         updated_at = now()
       returning *`,
      [
        state.session_id,
        displayName,
        normalizePlayerKey(displayName),
        guess,
        state.round_number,
        state.current_word.charAt(0).toUpperCase(),
      ]
    );

    const player = upsertResult.rows[0];

    await client.query(
      `insert into guess_submissions (
         session_id,
         player_id,
         round_number,
         guess,
         submitted_at
       )
       values ($1, $2, $3, $4, now())`,
      [state.session_id, player.id, state.round_number, guess]
    );

    await client.query("commit");

    res.json({
      ok: true,
      player: {
        id: player.id,
        displayName: player.display_name,
        currentGuess: player.current_guess,
        roundNumber: player.round_number,
        submittedAtIso: player.submitted_at ? new Date(player.submitted_at).toISOString() : nowIso(),
      },
      publicState: serializePublicState(state),
    });
  } catch (error) {
    await client.query("rollback");
    res.status(400).json({ ok: false, error: error.message });
  } finally {
    client.release();
  }
});

app.get("/api/admin/state", requireAdmin, async (_req, res) => {
  try {
    const state = await getState();
    res.json({ ok: true, state: serializeState(state) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/players", requireAdmin, async (_req, res) => {
  try {
    const state = await getState();
    const players = await listPlayers(state.session_id);
    res.json({
      ok: true,
      state: {
        session: serializeState(state),
        players,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function handleAdminAction(action, body) {
  const state = await getState();
  const word = String(body.word || "").trim().toUpperCase();

  switch (action) {
    case "state":
      return serializeState(state);
    case "create-session":
      return serializeState(await updateState({
        version: 1,
        mode: "lingo",
        phase: "idle",
        session_id: `session_${Date.now()}`,
        round_number: 0,
        current_word: "",
        answer_revealed: false,
        ball_multiplier: 1,
        balls_remaining: 0,
        guess_window_seconds: 90,
        results_window_seconds: 45,
        host_note: "",
        guess_window_opened_at: null,
        results_window_opened_at: null,
      }));
    case "set-word":
      if (word && !validateWord(word)) {
        throw new Error("Word must be exactly 5 letters.");
      }
      return serializeState(await updateState({
        current_word: word,
        answer_revealed: false,
        host_note: String(body.hostNote || ""),
      }));
    case "start-round": {
      if (!state.current_word) {
        throw new Error("Set a 5-letter word before starting a round.");
      }
      const nextRound = Number(state.round_number || 0) + 1;
      const multiplier = Number(state.ball_multiplier || 1);
      return serializeState(await updateState({
        phase: "guessing",
        round_number: nextRound,
        answer_revealed: false,
        balls_remaining: 6 * multiplier,
        guess_window_seconds: Number(body.guessWindowSeconds || state.guess_window_seconds || 90),
        results_window_seconds: Number(body.resultsWindowSeconds || state.results_window_seconds || 45),
        guess_window_opened_at: nowIso(),
      }));
    }
    case "reveal-results":
      return serializeState(await updateState({
        phase: "results",
        results_window_opened_at: nowIso(),
      }));
    case "continue-round":
      return serializeState(await updateState({
        phase: "guessing",
        guess_window_opened_at: nowIso(),
        guess_window_seconds: Number(body.guessWindowSeconds || state.guess_window_seconds || 90),
      }));
    case "toggle-double-balls":
      return serializeState(await updateState({
        ball_multiplier: Number(state.ball_multiplier || 1) === 2 ? 1 : 2,
      }));
    case "set-balls": {
      const balls = Number(body.ballsRemaining);
      if (!Number.isFinite(balls) || balls < 0) {
        throw new Error("ballsRemaining must be a non-negative number.");
      }
      return serializeState(await updateState({
        balls_remaining: balls,
      }));
    }
    case "reveal-answer":
      return serializeState(await updateState({
        answer_revealed: true,
        phase: "ended",
      }));
    case "reset-session":
      return serializeState(await updateState({
        phase: "idle",
        round_number: 0,
        current_word: "",
        answer_revealed: false,
        ball_multiplier: 1,
        balls_remaining: 0,
        guess_window_seconds: 90,
        results_window_seconds: 45,
        host_note: "",
        guess_window_opened_at: null,
        results_window_opened_at: null,
      }));
    default:
      throw new Error(`Unknown admin action: ${action}`);
  }
}

app.post("/api/admin/:action", requireAdmin, async (req, res) => {
  try {
    const state = await handleAdminAction(req.params.action, req.body || {});
    res.json({ ok: true, state });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }
  if (req.method !== "GET") {
    next();
    return;
  }
  res.sendFile(path.join(staticDir, req.path === "/host" ? "host.html" : "index.html"));
});

ensureSchema()
  .then(async () => {
    const state = await getState();
    console.log(`Lingo online app ready on port ${port}. Session: ${state.session_id}`);
    app.listen(port, () => {
      console.log(`Listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start app:", error);
    process.exit(1);
  });
