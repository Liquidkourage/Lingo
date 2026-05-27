const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { countAvailableWords, countWords, isFiveLetterWord, isLegalWord, normalizeWordInput, normalizeWordList, pickRandomWords, seedWordsTable } = require("./words");
require("dotenv").config();

const QRCode = require("qrcode");

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const adminKey = String(process.env.LINGO_ADMIN_KEY || "").trim();
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const defaultChampion = String(process.env.LINGO_CHAMPION || "").trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});

const staticDir = path.join(__dirname, "public");
const schemaPath = path.join(__dirname, "db", "schema.sql");
const HOST_WORD_SUGGESTION_COUNT = 100;

app.use(express.json());
app.use(express.static(staticDir));

function nowIso() {
  return new Date().toISOString();
}

function normalizeDisplayName(displayName) {
  return String(displayName || "").trim();
}

function normalizePlayerKey(displayName) {
  return normalizeDisplayName(displayName).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase() || "player";
}

function getLingoResultPattern(targetWord, guess) {
  const target = normalizeWordInput(targetWord);
  const attempt = normalizeWordInput(guess);

  if (!isFiveLetterWord(target) || !isFiveLetterWord(attempt)) {
    return "";
  }
  if (target === attempt) {
    return "!!!!!";
  }

  const targetChars = target.split("");
  const guessChars = attempt.split("");
  const result = new Array(5).fill("/");

  for (let index = 0; index < 5; index += 1) {
    if (targetChars[index] === guessChars[index]) {
      result[index] = "!";
      targetChars[index] = null;
      guessChars[index] = null;
    }
  }

  for (let index = 0; index < 5; index += 1) {
    if (!guessChars[index]) {
      continue;
    }

    const matchIndex = targetChars.indexOf(guessChars[index]);
    if (matchIndex !== -1) {
      result[index] = "?";
      targetChars[matchIndex] = null;
    }
  }

  return result.join("");
}

function getEffectiveChampion(state) {
  const fromState = String(state.champion_display_name || "").trim();
  if (fromState) return fromState;
  return defaultChampion;
}

function isChampionPlayer(displayName, state) {
  const champion = getEffectiveChampion(state);
  if (!champion || !displayName) return false;
  return String(displayName).trim().toLowerCase() === champion.toLowerCase();
}

function parseWordListFromState(value) {
  if (Array.isArray(value)) return normalizeWordList(value);
  if (typeof value === "string") {
    try {
      return normalizeWordList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

async function buildHostWordSuggestions(exclusions, count = HOST_WORD_SUGGESTION_COUNT, client = pool) {
  return pickRandomWords(client, count, exclusions);
}

async function resetHostWordPool(client = pool) {
  const exclusions = [];
  const suggestions = await buildHostWordSuggestions(exclusions, HOST_WORD_SUGGESTION_COUNT, client);
  return {
    host_word_suggestions: suggestions,
    host_word_exclusions: exclusions,
  };
}

async function ensureHostWordPool(state, client = pool) {
  const suggestions = parseWordListFromState(state.host_word_suggestions);
  if (suggestions.length > 0) return state;

  const exclusions = parseWordListFromState(state.host_word_exclusions);
  const nextSuggestions = await buildHostWordSuggestions(exclusions, HOST_WORD_SUGGESTION_COUNT, client);
  if (!nextSuggestions.length) return state;

  return updateState({
    host_word_suggestions: nextSuggestions,
    host_word_exclusions: exclusions,
  }, client);
}

async function enrichStateWithWordPool(state, client = pool) {
  return {
    ...state,
    availableWordCount: await countAvailableWords(client, state.wordExclusions || []),
  };
}

function windowExpired(openedAt, windowSeconds) {
  if (!openedAt || !windowSeconds) return false;
  const openedMs = new Date(openedAt).getTime();
  if (Number.isNaN(openedMs)) return false;
  return Date.now() >= openedMs + Number(windowSeconds) * 1000;
}

function findPlayerByDisplayName(players, displayName) {
  const key = normalizePlayerKey(displayName);
  return players.find(
    (player) => player.normalizedDisplayName === key
      || String(player.displayName || "").trim().toLowerCase() === String(displayName || "").trim().toLowerCase(),
  ) || null;
}

async function allActivePlayersSubmitted(state, client = pool) {
  const players = await listPlayers(state.session_id, client);
  const round = Number(state.round_number || 0);
  const awaiting = players.filter((player) => !player.solvedCurrentWord);
  if (!awaiting.length) return false;
  return awaiting.every(
    (player) => Number(player.roundNumber) === round && !!player.currentGuess,
  );
}

async function performRevealResults(client) {
  const currentState = await getState(client);
  if (currentState.phase !== "guessing") {
    throw new Error("Results can only be revealed during the guessing phase.");
  }
  const scoringPatch = await applyRevealResultsScoring(currentState, client);
  return updateState(scoringPatch, client);
}

async function performContinueRound(client, guessWindowSeconds) {
  const state = await getState(client);
  if (state.phase !== "results") {
    throw new Error("Guessing can only continue from the results phase.");
  }
  const multiplier = Number(state.ball_multiplier || 1);
  const balls = Number(state.balls_remaining || 0);
  if (state.answer_revealed || balls < 2 * multiplier) {
    throw new Error("The round cannot continue in the current state.");
  }
  const nextState = await updateState({
    phase: "guessing",
    guess_window_opened_at: nowIso(),
    guess_window_seconds: Number(guessWindowSeconds || state.guess_window_seconds || 90),
    first_solver_player_id: null,
  }, client);
  await clearSessionGuesses(nextState.session_id, client);
  return nextState;
}

async function maybeAutoRevealIfAllSubmitted(state, client) {
  if (state.phase !== "guessing") return state;
  if (!(await allActivePlayersSubmitted(state, client))) return state;
  return performRevealResults(client);
}

async function maybeAdvanceTimedPhase(client = pool) {
  const db = client === pool ? await pool.connect() : client;
  const releaseAfter = client === pool;
  try {
    await db.query("begin");
    let state = await getState(db);

    if (state.phase === "guessing"
      && windowExpired(state.guess_window_opened_at, state.guess_window_seconds)) {
      state = await performRevealResults(db);
    } else if (state.phase === "results"
      && windowExpired(state.results_window_opened_at, state.results_window_seconds)) {
      const multiplier = Number(state.ball_multiplier || 1);
      const balls = Number(state.balls_remaining || 0);
      if (!state.answer_revealed && balls >= 2 * multiplier) {
        state = await performContinueRound(db, state.guess_window_seconds);
      }
    }

    await db.query("commit");
    return state;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    if (releaseAfter) db.release();
  }
}

function formatPatternFeedback(pattern) {
  if (pattern === "!!!!!") return "Perfect solve!";
  if (!pattern) return "";
  return pattern
    .split("")
    .map((mark) => (mark === "!" ? "▪" : mark === "?" ? "○" : "✕"))
    .join(" ");
}

async function buildViewerContext(displayName, state, client = pool) {
  const normalized = normalizeDisplayName(displayName);
  if (!normalized) return null;

  const players = await listPlayers(state.session_id, client);
  const player = findPlayerByDisplayName(players, normalized);
  const phase = String(state.phase || "idle");
  const round = Number(state.round_number || 0);

  if (!player) {
    return {
      found: false,
      displayName: normalized,
      balls: 0,
      lockedIn: false,
      resultPattern: "",
      resultLabel: "",
      isSolved: false,
    };
  }

  const submitted = Number(player.roundNumber) === round && !!player.currentGuess;
  let resultPattern = "";
  let resultLabel = "";

  if ((phase === "results" || phase === "ended") && submitted) {
    const guess = normalizeWordInput(player.currentGuess);
    if (!(await isLegalWord(client, guess))) {
      resultLabel = "Not a word…";
    } else {
      resultPattern = getLingoResultPattern(state.current_word, guess);
      resultLabel = formatPatternFeedback(resultPattern);
    }
  }

  return {
    found: true,
    displayName: player.displayName,
    balls: Number(player.balls || 0),
    lockedIn: phase === "guessing" && submitted,
    resultPattern: phase === "results" || phase === "ended" ? resultPattern : "",
    resultLabel,
    isSolved: Boolean(player.solvedCurrentWord),
  };
}

async function buildPublicStatePayload(state, displayName, client = pool) {
  const metrics = await getPublicMetrics(state.session_id, state.round_number, client);
  const players = await getPublicDisplayPlayers(state, client);
  const viewer = await buildViewerContext(displayName, state, client);
  return {
    ...serializePublicState(state),
    ...metrics,
    players,
    viewer,
  };
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
  await seedWordsTable(pool);
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
    championDisplayName: getEffectiveChampion(row),
    firstSolverPlayerId: row.first_solver_player_id ? Number(row.first_solver_player_id) : null,
    wordSuggestions: parseWordListFromState(row.host_word_suggestions),
    wordExclusions: parseWordListFromState(row.host_word_exclusions),
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
    next.champion_display_name ?? state.champion_display_name ?? "",
    next.first_solver_player_id ?? state.first_solver_player_id ?? null,
    JSON.stringify(parseWordListFromState(next.host_word_suggestions ?? state.host_word_suggestions)),
    JSON.stringify(parseWordListFromState(next.host_word_exclusions ?? state.host_word_exclusions)),
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
         champion_display_name = $15,
         first_solver_player_id = $16,
         host_word_suggestions = $17::jsonb,
         host_word_exclusions = $18::jsonb,
         updated_at = now()
     where id = 1
     returning *`,
    params
  );

  return result.rows[0];
}

async function listPlayers(sessionId, client = pool) {
  const result = await client.query(
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
    createdAtIso: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAtIso: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    submissionCount: Number(row.submission_count || 0),
    balls: Number(row.balls || 0),
    solvedCurrentWord: Boolean(row.solved_current_word),
  }));
}

async function getPublicMetrics(sessionId, roundNumber, client = pool) {
  const result = await client.query(
    `select
       count(*)::int as player_count,
       count(*) filter (
         where round_number = $2
           and (
             current_guess <> ''
             or solved_current_word = true
           )
       )::int as submitted_this_round
     from players
     where session_id = $1`,
    [sessionId, roundNumber]
  );

  return {
    playerCount: Number(result.rows[0]?.player_count || 0),
    submittedThisRound: Number(result.rows[0]?.submitted_this_round || 0),
  };
}

async function resetWordProgress(sessionId, client = pool) {
  await client.query(
    `update players
     set solved_current_word = false,
         updated_at = now()
     where session_id = $1`,
    [sessionId]
  );
}

async function applyRevealResultsScoring(state, client) {
  const multiplier = Number(state.ball_multiplier || 1);
  let ballsRemaining = Number(state.balls_remaining || 0);
  const stakeAtReveal = ballsRemaining;
  const lastGuessWasTwoBall = ballsRemaining === 2 * multiplier;

  const players = await listPlayers(state.session_id, client);
  const submittedPlayers = players
    .filter((player) => Number(player.roundNumber) === Number(state.round_number) && player.currentGuess)
    .sort((left, right) => new Date(left.submittedAtIso || 0) - new Date(right.submittedAtIso || 0));

  let someoneNewlySolved = false;
  let firstSolverId = null;

  for (const player of submittedPlayers) {
    const guess = normalizeWordInput(player.currentGuess);
    if (!(await isLegalWord(client, guess))) {
      continue;
    }

    const pattern = getLingoResultPattern(state.current_word, guess);
    if (pattern !== "!!!!!") {
      continue;
    }
    if (player.solvedCurrentWord) {
      continue;
    }

    someoneNewlySolved = true;
    await client.query(
      `update players
       set balls = balls + $1,
           solved_current_word = true,
           updated_at = now()
       where id = $2`,
      [stakeAtReveal, player.id]
    );

    if (!firstSolverId) {
      firstSolverId = player.id;
    }
  }

  if (ballsRemaining === 6 * multiplier) {
    ballsRemaining = 5 * multiplier;
  }
  if (someoneNewlySolved) {
    ballsRemaining -= multiplier;
  }

  const patch = {
    balls_remaining: Math.max(0, ballsRemaining),
    results_window_opened_at: nowIso(),
    first_solver_player_id: firstSolverId,
  };

  if (lastGuessWasTwoBall) {
    patch.phase = "ended";
    patch.answer_revealed = true;
  } else {
    patch.phase = "results";
  }

  return patch;
}

async function serializePublicDisplayPlayer(player, state, client = pool) {
  const currentRound = Number(state.round_number || 0);
  const submittedThisRound = Number(player.roundNumber || 0) === currentRound && !!player.currentGuess;
  const phase = String(state.phase || "idle");
  const guess = submittedThisRound ? normalizeWordInput(player.currentGuess) : "";
  const balls = Number(player.balls || 0);
  const solvedCurrentWord = Boolean(player.solvedCurrentWord);
  const isChampion = isChampionPlayer(player.displayName, state);
  const isFirstSolver = Number(state.first_solver_player_id || 0) === Number(player.id)
    && (phase === "results" || phase === "ended");

  let guessIsLegal = true;
  if (guess) {
    guessIsLegal = await isLegalWord(client, guess);
  }

  let resultPattern = "";
  if (guess && guessIsLegal) {
    resultPattern = getLingoResultPattern(state.current_word, guess);
  }

  let status = "waiting";
  let statusText = "Waiting for guess";
  let cardTone = "default";

  if (solvedCurrentWord && phase !== "idle") {
    status = "solved";
    statusText = "Congratulations!";
    cardTone = "solved";
  } else if (phase === "guessing") {
    if (submittedThisRound) {
      status = "locked";
      statusText = "Locked in";
    }
  } else if (phase === "results" || phase === "ended") {
    if (!submittedThisRound) {
      statusText = "No guess this round";
    } else if (!guessIsLegal) {
      status = "invalid";
      statusText = "Not a word…";
      cardTone = "invalid";
    } else if (resultPattern === "!!!!!") {
      status = "solved";
      statusText = "Congratulations!";
      cardTone = "solved";
    } else if (resultPattern) {
      status = "resolved";
      statusText = "Round result";
    }
  }

  return {
    id: player.id,
    displayName: player.displayName,
    balls,
    isChampion,
    solvedCurrentWord,
    isFirstSolver,
    hasSubmitted: submittedThisRound,
    guessIsLegal,
    status,
    statusText,
    cardTone,
    resultPattern: (phase === "results" || phase === "ended") && guessIsLegal ? resultPattern : "",
    isWinner: resultPattern === "!!!!!",
    submissionCount: Number(player.submissionCount || 0),
    submittedAtIso: player.submittedAtIso,
    joinedAtIso: player.createdAtIso || player.updatedAtIso || null,
  };
}

async function getPublicDisplayPlayers(state, client = pool) {
  const players = await listPlayers(state.session_id, client);
  return Promise.all(players.map((player) => serializePublicDisplayPlayer(player, state, client)));
}

async function clearSessionGuesses(sessionId, client = pool) {
  await client.query(
    `update players
     set current_guess = '',
         submitted_at = null,
         updated_at = now()
     where session_id = $1`,
    [sessionId]
  );
}

function playPageUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/`;
}

app.get("/api/play-qr", async (req, res) => {
  try {
    const url = playPageUrl(req);
    const png = await QRCode.toBuffer(url, {
      type: "png",
      width: 400,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#58e8ff", light: "#061428" },
    });
    res.type("png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(png);
  } catch (error) {
    console.error("play-qr", error);
    res.status(500).end();
  }
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/public-state", async (req, res) => {
  try {
    const state = await maybeAdvanceTimedPhase();
    const displayName = normalizeDisplayName(req.query.displayName);
    res.json({
      ok: true,
      state: await buildPublicStatePayload(state, displayName),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/submit-guess", async (req, res) => {
  const displayName = normalizeDisplayName(req.body.displayName);
  const guess = normalizeWordInput(req.body.guess);

  if (!displayName) {
    res.status(400).json({ ok: false, error: "Display name is required." });
    return;
  }
  if (!isFiveLetterWord(guess)) {
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
    if (!(await isLegalWord(client, guess))) {
      throw new Error("Guess must be a legal 5-letter Scrabble word.");
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

    let nextState = await getState(client);
    nextState = await maybeAutoRevealIfAllSubmitted(nextState, client);

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
      publicState: await buildPublicStatePayload(nextState, displayName),
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
    let state = await maybeAdvanceTimedPhase();
    state = await ensureHostWordPool(state);
    const serialized = await enrichStateWithWordPool(serializeState(state));
    res.json({ ok: true, state: serialized });
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
  const word = normalizeWordInput(body.word);

  switch (action) {
    case "state":
      return serializeState(state);
    case "create-session": {
      const wordPool = await resetHostWordPool();
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
        first_solver_player_id: null,
        ...wordPool,
      }));
    }
    case "set-word": {
      if (word && !isFiveLetterWord(word)) {
        throw new Error("Word must be exactly 5 letters.");
      }
      if (word && !(await isLegalWord(pool, word))) {
        throw new Error("Word must be a legal 5-letter Scrabble word.");
      }
      const patch = {
        current_word: word,
        answer_revealed: false,
      };
      if (body.hostNote !== undefined) {
        patch.host_note = String(body.hostNote || "");
      }
      return serializeState(await updateState(patch));
    }
    case "start-round": {
      if (!state.current_word) {
        throw new Error("Set a 5-letter word before starting a round.");
      }
      const nextRound = Number(state.round_number || 0) + 1;
      const multiplier = Number(state.ball_multiplier || 1);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const nextState = await updateState({
          phase: "guessing",
          round_number: nextRound,
          answer_revealed: false,
          balls_remaining: 6 * multiplier,
          guess_window_seconds: Number(body.guessWindowSeconds || state.guess_window_seconds || 90),
          results_window_seconds: Number(body.resultsWindowSeconds || state.results_window_seconds || 45),
          guess_window_opened_at: nowIso(),
          first_solver_player_id: null,
        }, client);
        await clearSessionGuesses(nextState.session_id, client);
        await resetWordProgress(nextState.session_id, client);
        await client.query("commit");
        return serializeState(nextState);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    case "reveal-results": {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const nextState = await performRevealResults(client);
        await client.query("commit");
        return serializeState(nextState);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    case "continue-round": {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const nextState = await performContinueRound(
          client,
          Number(body.guessWindowSeconds || state.guess_window_seconds || 90),
        );
        await client.query("commit");
        return serializeState(nextState);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
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
    case "refresh-word-suggestions": {
      const exclusions = parseWordListFromState(state.host_word_exclusions);
      const count = Math.max(1, Number(body.count) || HOST_WORD_SUGGESTION_COUNT);
      const suggestions = await buildHostWordSuggestions(exclusions, count);
      if (!suggestions.length) {
        throw new Error("No words left in the host pool.");
      }
      return serializeState(await updateState({
        host_word_suggestions: suggestions,
      }));
    }
    case "exclude-word": {
      const excludedWord = normalizeWordInput(body.word);
      if (!isFiveLetterWord(excludedWord)) {
        throw new Error("Word must be exactly 5 letters.");
      }
      const exclusions = parseWordListFromState(state.host_word_exclusions);
      if (!exclusions.includes(excludedWord)) {
        exclusions.push(excludedWord);
      }
      const suggestions = parseWordListFromState(state.host_word_suggestions)
        .filter((item) => item !== excludedWord);
      return serializeState(await updateState({
        host_word_exclusions: exclusions,
        host_word_suggestions: suggestions,
      }));
    }
    case "set-champion":
      return serializeState(await updateState({
        champion_display_name: normalizeDisplayName(body.championDisplayName),
      }));
    case "set-host-note":
      return serializeState(await updateState({
        host_note: String(body.hostNote || ""),
      }));
    case "remove-player": {
      const playerId = Number(body.playerId);
      if (!Number.isFinite(playerId) || playerId <= 0) {
        throw new Error("playerId is required.");
      }
      await pool.query(
        `delete from players
         where id = $1
           and session_id = $2`,
        [playerId, state.session_id]
      );
      return serializeState(await getState());
    }
    case "set-player-balls": {
      const playerId = Number(body.playerId);
      const balls = Number(body.balls);
      if (!Number.isFinite(playerId) || playerId <= 0) {
        throw new Error("playerId is required.");
      }
      if (!Number.isFinite(balls) || balls < 0) {
        throw new Error("balls must be a non-negative number.");
      }
      await pool.query(
        `update players
         set balls = $1,
             updated_at = now()
         where id = $2
           and session_id = $3`,
        [balls, playerId, state.session_id]
      );
      return serializeState(await getState());
    }
    case "award-all-balls":
      await pool.query(
        `update players
         set balls = balls + 1,
             updated_at = now()
         where session_id = $1`,
        [state.session_id]
      );
      return serializeState(await getState());
    case "reveal-answer":
      return serializeState(await updateState({
        answer_revealed: true,
        phase: "ended",
      }));
    case "reset-session": {
      const wordPool = await resetHostWordPool();
      await pool.query(
        `update players
         set balls = 0,
             solved_current_word = false,
             current_guess = '',
             submitted_at = null,
             updated_at = now()
         where session_id = $1`,
        [state.session_id]
      );
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
        first_solver_player_id: null,
        ...wordPool,
      }));
    }
    default:
      throw new Error(`Unknown admin action: ${action}`);
  }
}

app.post("/api/admin/:action", requireAdmin, async (req, res) => {
  try {
    const state = await handleAdminAction(req.params.action, req.body || {});
    res.json({ ok: true, state: await enrichStateWithWordPool(state) });
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
  const fileName = req.path === "/host"
    ? "host.html"
    : req.path === "/display"
      ? "display.html"
      : "index.html";
  res.sendFile(path.join(staticDir, fileName));
});

ensureSchema()
  .then(async () => {
    const state = await getState();
    const totalWords = await countWords(pool);
    console.log(`Lingo online app ready on port ${port}. Session: ${state.session_id}. Words: ${totalWords}`);
    app.listen(port, () => {
      console.log(`Listening on http://localhost:${port}`);
    });
    setInterval(() => {
      maybeAdvanceTimedPhase().catch((error) => {
        console.error("timer tick", error.message);
      });
    }, 2000);
  })
  .catch((error) => {
    console.error("Failed to start app:", error);
    process.exit(1);
  });
