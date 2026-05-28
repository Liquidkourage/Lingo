const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { countAvailableWords, countWords, isFiveLetterWord, isLegalWord, normalizeWordInput, normalizeWordList, pickRandomWords, seedWordsTable } = require("./words");
const {
  REHEARSAL_BOT_COUNT,
  clearRehearsalBots,
  getRehearsalStatus,
  seedRehearsalBots,
  submitRehearsalBotGuesses,
} = require("./rehearsal-bots");
require("dotenv").config();

const QRCode = require("qrcode");

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const adminKey = String(process.env.LINGO_ADMIN_KEY || "").trim();
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const defaultChampion = String(process.env.LINGO_CHAMPION || "").trim();
const DEFAULT_PLAY_SITE_URL = "https://lingo.liquidkourage.com";

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
const ALL_SUBMITTED_GRACE_SECONDS = 10;
let rehearsalAutoSubmitEnabled = false;
let appReady = false;
let shuttingDown = false;
let httpServer = null;
let timerTickHandle = null;
let rehearsalTickHandle = null;
const SHUTDOWN_FORCE_MS = 20000;

function rehearsalDeps() {
  return {
    listPlayers,
    normalizeDisplayName,
    normalizePlayerKey,
    isLegalWord,
    maybeAutoRevealIfAllSubmitted,
    getState,
  };
}

async function runRehearsalBotSubmissions(client = pool) {
  const db = client === pool ? await pool.connect() : client;
  const releaseAfter = client === pool;
  try {
    await db.query("begin");
    const state = await getState(db);
    const result = await submitRehearsalBotGuesses({
      ...rehearsalDeps(),
      state,
      client: db,
    });
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    if (releaseAfter) db.release();
  }
}

app.use(express.json());

app.use((req, res, next) => {
  if (req.method !== "GET") {
    next();
    return;
  }
  const htmlPaths = new Set(["/", "/host", "/display", "/rehearsal"]);
  if (htmlPaths.has(req.path) || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

app.use(express.static(staticDir));

function nowIso() {
  return new Date().toISOString();
}

function windowOpenedAtIso() {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
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

function uniqueStakesInOrder(stakes) {
  const seen = new Set();
  const result = [];
  for (const raw of stakes) {
    const stake = Number(raw);
    if (stake > 0 && !seen.has(stake)) {
      seen.add(stake);
      result.push(stake);
    }
  }
  return result;
}

function parseRoundBallStakesPreserveOrder(state) {
  const raw = state?.round_ball_stakes ?? state?.roundBallStakes ?? [];
  let stakes = [];
  if (Array.isArray(raw)) {
    stakes = raw
      .map((value) => {
        if (value && typeof value === "object") {
          return Number(value.stake ?? value.ballStake ?? 0);
        }
        return Number(value);
      })
      .filter((value) => value > 0);
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        stakes = parsed
          .map((value) => {
            if (value && typeof value === "object") {
              return Number(value.stake ?? value.ballStake ?? 0);
            }
            return Number(value);
          })
          .filter((value) => value > 0);
      }
    } catch (_error) {
      return [];
    }
  }
  return stakes;
}

function parseRoundBallStakes(state) {
  return uniqueStakesInOrder(parseRoundBallStakesPreserveOrder(state));
}

function parseRoundGuessWindows(state) {
  return parseRoundBallStakesPreserveOrder(state).map((stake, index) => ({
    seq: index + 1,
    stake,
  }));
}

function isGuessWindowClosed(windowSeq, state) {
  const current = Number(state.guess_window_seq || 0);
  const phase = String(state.phase || "idle");
  if (windowSeq < current) return true;
  if (windowSeq === current) {
    return phase === "results" || phase === "ended";
  }
  return false;
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

function computeWindowRemainingSeconds(openedAt, windowSeconds) {
  const total = Number(windowSeconds || 0);
  if (!openedAt || !total) return null;
  const openedMs = new Date(openedAt).getTime();
  if (Number.isNaN(openedMs)) return null;
  const end = openedMs + total * 1000;
  const remaining = Math.max(0, Math.floor((end - Date.now()) / 1000));
  return Math.min(total, remaining);
}

function capTimerRemainingSeconds(remaining, windowSeconds) {
  const total = Number(windowSeconds || 0);
  const value = Math.max(0, Number(remaining || 0));
  if (!total) return value;
  return Math.min(total, value);
}

function timerRemainingForState(row) {
  if (!row) return { guessWindowRemainingSeconds: null, resultsWindowRemainingSeconds: null };
  const phase = String(row.phase || "idle");
  const timerPaused = Boolean(row.timer_paused);

  if (timerPaused && row.timer_paused_remaining_seconds != null) {
    const frozen = capTimerRemainingSeconds(
      row.timer_paused_remaining_seconds,
      phase === "guessing" ? row.guess_window_seconds : row.results_window_seconds,
    );
    return {
      guessWindowRemainingSeconds: phase === "guessing" ? frozen : null,
      resultsWindowRemainingSeconds: phase === "results" ? frozen : null,
    };
  }

  return {
    guessWindowRemainingSeconds: phase === "guessing"
      ? effectiveGuessWindowRemaining(row)
      : null,
    resultsWindowRemainingSeconds: phase === "results"
      ? computeWindowRemainingSeconds(row.results_window_opened_at, row.results_window_seconds)
      : null,
  };
}

function windowExpired(openedAt, windowSeconds, timerPaused = false) {
  if (timerPaused) return false;
  if (!openedAt || !windowSeconds) return false;
  const openedMs = new Date(openedAt).getTime();
  if (Number.isNaN(openedMs)) return false;
  return Date.now() >= openedMs + Number(windowSeconds) * 1000;
}

function clearTimerPausePatch() {
  return {
    timer_paused: false,
    timer_paused_remaining_seconds: null,
  };
}

function clearAllSubmittedGracePatch() {
  return {
    all_players_submitted_at: null,
  };
}

function endCurrentWordPatch() {
  return {
    phase: "ended",
    answer_revealed: true,
    balls_remaining: 0,
    ...clearTimerPausePatch(),
    ...clearAllSubmittedGracePatch(),
  };
}

async function hasPlayersWhoCanStillGuess(state, client = pool) {
  const players = await listPlayers(state.session_id, client);
  return players.some((player) => !player.solvedCurrentWord);
}

function newPlayerToken() {
  return crypto.randomUUID();
}

function normalizePlayerToken(playerToken) {
  return String(playerToken || "").trim();
}

function allSubmittedGraceExpired(state) {
  if (!state?.all_players_submitted_at) return false;
  const startMs = new Date(state.all_players_submitted_at).getTime();
  if (Number.isNaN(startMs)) return false;
  return Date.now() >= startMs + ALL_SUBMITTED_GRACE_SECONDS * 1000;
}

function effectiveGuessWindowRemaining(row) {
  const base = computeWindowRemainingSeconds(row.guess_window_opened_at, row.guess_window_seconds);
  if (base == null || !row.all_players_submitted_at) return base;
  const startMs = new Date(row.all_players_submitted_at).getTime();
  if (Number.isNaN(startMs)) return base;
  const graceRemaining = Math.max(
    0,
    ALL_SUBMITTED_GRACE_SECONDS - Math.floor((Date.now() - startMs) / 1000),
  );
  return Math.min(base, graceRemaining);
}

async function getPlayerByToken(sessionId, playerToken, client = pool) {
  const token = normalizePlayerToken(playerToken);
  if (!token) return null;
  const result = await client.query(
    `select *
     from players
     where session_id = $1
       and player_token = $2`,
    [sessionId, token],
  );
  return result.rows[0] || null;
}

async function ensurePlayerToken(row, client = pool) {
  if (row.player_token) return row;
  const token = newPlayerToken();
  const result = await client.query(
    `update players
     set player_token = $1,
         updated_at = now()
     where id = $2
     returning *`,
    [token, row.id],
  );
  return result.rows[0];
}

async function upsertLobbyPlayer(sessionId, displayName, playerToken, client = pool) {
  const normalized = normalizePlayerKey(displayName);
  const token = normalizePlayerToken(playerToken);

  if (token) {
    const existing = await getPlayerByToken(sessionId, token, client);
    if (existing) {
      const conflict = await client.query(
        `select id
         from players
         where session_id = $1
           and normalized_display_name = $2
           and id <> $3`,
        [sessionId, normalized, existing.id],
      );
      if (conflict.rows.length) {
        throw new Error("That name is already taken.");
      }
      const updated = await client.query(
        `update players
         set display_name = $1,
             normalized_display_name = $2,
             updated_at = now()
         where id = $3
         returning *`,
        [displayName, normalized, existing.id],
      );
      return ensurePlayerToken(updated.rows[0], client);
    }
  }

  const existingByName = await client.query(
    `select id, player_token
     from players
     where session_id = $1
       and normalized_display_name = $2`,
    [sessionId, normalized],
  );
  if (existingByName.rows.length) {
    throw new Error("That name is already taken.");
  }

  const result = await client.query(
    `insert into players (
       session_id,
       display_name,
       normalized_display_name,
       player_token,
       updated_at
     )
     values ($1, $2, $3, $4, now())
     returning *`,
    [sessionId, displayName, normalized, newPlayerToken()],
  );
  const row = result.rows[0];
  return ensurePlayerToken(row, client);
}

function serializePlayerIdentity(row) {
  return {
    id: Number(row.id),
    displayName: row.display_name,
    playerToken: row.player_token,
    balls: Number(row.balls || 0),
  };
}

function findPlayerByDisplayName(players, displayName) {
  const key = normalizePlayerKey(displayName);
  return players.find(
    (player) => player.normalizedDisplayName === key
      || String(player.displayName || "").trim().toLowerCase() === String(displayName || "").trim().toLowerCase(),
  ) || null;
}

async function playerHasPerfectSolveForRound(state, player, client = pool) {
  if (Number(player.roundNumber || 0) !== Number(state.round_number || 0)) {
    return false;
  }
  const guess = normalizeWordInput(player.currentGuess || "");
  if (!guess) {
    return false;
  }
  if (!(await isLegalWord(client, guess))) {
    return false;
  }
  return getLingoResultPattern(state.current_word, guess) === "!!!!!";
}

async function allActivePlayersSubmitted(state, client = pool) {
  const players = await listPlayers(state.session_id, client);
  const round = Number(state.round_number || 0);
  const awaiting = [];
  for (const player of players) {
    // Skip players who already solved this word in an earlier window (continue-round).
    // In-window perfect guesses still count as submitted — do not skip them here.
    if (player.solvedCurrentWord) {
      continue;
    }
    awaiting.push(player);
  }
  if (!awaiting.length) return false;
  return awaiting.every(
    (player) => Number(player.roundNumber) === round && !!player.currentGuess,
  );
}

async function freezeGuessSubmissionFeedback(state, client = pool) {
  const submissions = await client.query(
    `select id, guess, player_id
     from guess_submissions
     where session_id = $1
       and round_number = $2`,
    [state.session_id, state.round_number],
  );

  for (const row of submissions.rows) {
    const feedback = await getGuessFeedback(state, row.guess, client);
    await client.query(
      `update guess_submissions
       set result_pattern = $1,
           result_label = $2,
           is_official = false
       where id = $3`,
      [feedback.pattern, feedback.resultLabel, row.id],
    );
  }

  const players = await listPlayers(state.session_id, client);
  for (const player of players) {
    const officialGuess = Number(player.roundNumber) === Number(state.round_number)
      ? normalizeWordInput(player.currentGuess)
      : "";
    if (!officialGuess) continue;

    await client.query(
      `update guess_submissions
       set is_official = (guess = $4)
       where session_id = $1
         and player_id = $2
         and round_number = $3`,
      [state.session_id, player.id, state.round_number, officialGuess],
    );
  }
}

async function performRevealResults(client) {
  const currentState = await getState(client);
  if (currentState.phase !== "guessing") {
    throw new Error("Results can only be revealed during the guessing phase.");
  }
  await freezeGuessSubmissionFeedback(currentState, client);
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
  if (!(await hasPlayersWhoCanStillGuess(state, client))) {
    return updateState(endCurrentWordPatch(), client);
  }
  const continueStake = Number(state.balls_remaining || 0);
  const nextWindowSeq = Number(state.guess_window_seq || 0) + 1;
  const roundBallStakes = [...parseRoundBallStakesPreserveOrder(state), continueStake];

  const nextState = await updateState({
    phase: "guessing",
    guess_window_opened_at: windowOpenedAtIso(),
    guess_window_seconds: Number(guessWindowSeconds || state.guess_window_seconds || 90),
    first_solver_player_id: null,
    guess_window_seq: nextWindowSeq,
    round_ball_stakes: roundBallStakes,
    ...clearTimerPausePatch(),
    ...clearAllSubmittedGracePatch(),
  }, client);
  await clearSessionGuesses(nextState.session_id, client);
  return nextState;
}

async function syncAllSubmittedGrace(state, client) {
  if (state.phase !== "guessing") {
    if (state.all_players_submitted_at) {
      return updateState(clearAllSubmittedGracePatch(), client);
    }
    return state;
  }

  const allIn = await allActivePlayersSubmitted(state, client);
  if (!allIn) {
    if (state.all_players_submitted_at) {
      return updateState(clearAllSubmittedGracePatch(), client);
    }
    return state;
  }

  if (!state.all_players_submitted_at) {
    return updateState({ all_players_submitted_at: windowOpenedAtIso() }, client);
  }

  if (allSubmittedGraceExpired(state)) {
    return performRevealResults(client);
  }

  return state;
}

async function maybeAutoRevealIfAllSubmitted(state, client) {
  return syncAllSubmittedGrace(state, client);
}

async function maybeAdvanceTimedPhase(client = pool) {
  const db = client === pool ? await pool.connect() : client;
  const releaseAfter = client === pool;
  try {
    await db.query("begin");
    let state = await getState(db);

    if (state.phase === "guessing") {
      state = await syncAllSubmittedGrace(state, db);
      if (state.phase === "guessing"
        && state.all_players_submitted_at
        && allSubmittedGraceExpired(state)
        && await allActivePlayersSubmitted(state, db)) {
        state = await performRevealResults(db);
      } else if (state.phase === "guessing"
        && state.all_players_submitted_at
        && allSubmittedGraceExpired(state)) {
        state = await updateState(clearAllSubmittedGracePatch(), db);
      } else if (state.phase === "guessing"
        && windowExpired(state.guess_window_opened_at, state.guess_window_seconds, state.timer_paused)) {
        if (await hasPlayersWhoCanStillGuess(state, db)) {
          state = await performRevealResults(db);
        } else {
          state = await updateState(endCurrentWordPatch(), db);
        }
      }
    } else if (state.phase === "results"
      && windowExpired(state.results_window_opened_at, state.results_window_seconds, state.timer_paused)) {
      const multiplier = Number(state.ball_multiplier || 1);
      const balls = Number(state.balls_remaining || 0);
      if (!state.answer_revealed && balls >= 2 * multiplier) {
        state = await performContinueRound(db, state.guess_window_seconds);
      } else if (!state.answer_revealed) {
        state = await updateState(endCurrentWordPatch(), db);
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

function shouldRevealGuessFeedback(phase) {
  return phase === "results" || phase === "ended";
}

async function getGuessFeedback(state, guess, client = pool) {
  const normalized = normalizeWordInput(guess);
  if (!normalized) {
    return { pattern: "", resultLabel: "" };
  }
  if (!(await isLegalWord(client, normalized))) {
    return { pattern: "", resultLabel: "Not a word…" };
  }
  const pattern = getLingoResultPattern(state.current_word, normalized);
  return {
    pattern,
    resultLabel: formatPatternFeedback(pattern),
  };
}

function isPerfectSolveEntry(entry) {
  return entry?.pattern === "!!!!!" || entry?.resultLabel === "Perfect solve!";
}

function trimHistoryAfterSolve(history) {
  const solveIndex = history.findIndex((entry) => isPerfectSolveEntry(entry));
  if (solveIndex === -1) {
    return history;
  }
  return history.slice(0, solveIndex + 1);
}

function historyAlreadySolved(history) {
  return history.some((entry) => isPerfectSolveEntry(entry));
}

async function listViewerGuessHistory(playerId, state, client = pool, options = {}) {
  const round = Number(state.round_number || 0);
  if (!playerId || !round) return [];

  const result = await client.query(
    `select guess, result_pattern, result_label, is_official, ball_stake, guess_window_seq
     from guess_submissions
     where session_id = $1
       and player_id = $2
       and round_number = $3
     order by guess_window_seq asc, submitted_at asc, id asc`,
    [state.session_id, playerId, round],
  );

  const phase = String(state.phase || "idle");
  const reveal = options.hostMode || shouldRevealGuessFeedback(phase);
  const windows = parseRoundGuessWindows(state);
  const submissionBySeq = new Map();
  const legacyEntries = [];

  for (const row of result.rows) {
    const guess = normalizeWordInput(row.guess);
    if (!guess) continue;

    let pattern = String(row.result_pattern || "");
    let resultLabel = String(row.result_label || "");

    if (!pattern && reveal) {
      const feedback = await getGuessFeedback(state, guess, client);
      pattern = feedback.pattern;
      resultLabel = feedback.resultLabel;
    } else if (!pattern && phase === "guessing" && options.hostMode) {
      resultLabel = "Pending";
    }

    const ballStake = Number(row.ball_stake || 0);
    const entry = {
      guess,
      pattern,
      resultLabel,
      isOfficial: Boolean(row.is_official),
      ballStake,
      guessWindowSeq: Number(row.guess_window_seq || 0),
      status: resultLabel === "Not a word…" ? "invalid" : "guess",
    };
    const windowSeq = Number(row.guess_window_seq || 0);
    if (windowSeq > 0) {
      submissionBySeq.set(windowSeq, entry);
    } else {
      legacyEntries.push(entry);
    }
  }

  if (windows.length) {
    const history = [];
    windows.forEach(({ seq, stake }) => {
      if (historyAlreadySolved(history)) {
        return;
      }
      const existing = submissionBySeq.get(seq);
      if (existing) {
        history.push(existing);
        return;
      }
      if (!isGuessWindowClosed(seq, state)) {
        return;
      }
      history.push({
        guess: "",
        pattern: "",
        resultLabel: "No guess",
        isOfficial: false,
        ballStake: stake,
        guessWindowSeq: seq,
        status: "missed",
      });
    });

    submissionBySeq.forEach((entry, seq) => {
      if (historyAlreadySolved(history)) {
        return;
      }
      if (!windows.some((window) => window.seq === seq)) {
        history.push(entry);
      }
    });

    return trimHistoryAfterSolve(history);
  }

  if (legacyEntries.length) {
    return trimHistoryAfterSolve(legacyEntries);
  }

  return trimHistoryAfterSolve([...submissionBySeq.values()]);
}

async function playerSubmittedCurrentWindow(state, player, client = pool) {
  const round = Number(state.round_number || 0);
  const windowSeq = Number(state.guess_window_seq || 0);
  if (!round || !windowSeq) return false;
  if (Number(player.roundNumber || 0) !== round || !player.currentGuess) {
    return false;
  }
  const result = await client.query(
    `select 1
     from guess_submissions
     where session_id = $1
       and player_id = $2
       and round_number = $3
       and guess_window_seq = $4
     limit 1`,
    [state.session_id, player.id, round, windowSeq],
  );
  return result.rows.length > 0;
}

async function buildViewerContext(displayName, playerToken, state, client = pool) {
  const normalized = normalizeDisplayName(displayName);
  const token = normalizePlayerToken(playerToken);

  let player = null;
  let sessionValid = false;
  if (token) {
    const row = await getPlayerByToken(state.session_id, token, client);
    if (row) {
      player = {
        id: row.id,
        displayName: row.display_name,
        normalizedDisplayName: row.normalized_display_name,
        currentGuess: row.current_guess,
        roundNumber: row.round_number,
        balls: Number(row.balls || 0),
        solvedCurrentWord: Boolean(row.solved_current_word),
      };
      sessionValid = true;
    }
  }

  if (!player && normalized) {
    const players = await listPlayers(state.session_id, client);
    player = findPlayerByDisplayName(players, normalized);
  }

  if (!token && !normalized) return null;
  const phase = String(state.phase || "idle");
  const round = Number(state.round_number || 0);

  if (!player) {
    return {
      found: false,
      sessionValid: false,
      displayName: normalized,
      balls: 0,
      lockedIn: false,
      resultPattern: "",
      roundGuess: "",
      resultLabel: "",
      guessHistory: [],
      isSolved: false,
      isChampion: false,
    };
  }

  const submitted = phase === "guessing"
    ? await playerSubmittedCurrentWindow(state, player, client)
    : Number(player.roundNumber) === round && !!player.currentGuess;
  const guess = submitted ? normalizeWordInput(player.currentGuess) : "";
  let resultPattern = "";
  let resultLabel = "";

  if (shouldRevealGuessFeedback(phase) && submitted) {
    const feedback = await getGuessFeedback(state, guess, client);
    resultPattern = feedback.pattern;
    resultLabel = feedback.resultLabel;
  }

  const guessHistory = await listViewerGuessHistory(player.id, state, client);

  let roundGuess = submitted ? guess : "";
  let viewerResultPattern = shouldRevealGuessFeedback(phase) ? resultPattern : "";
  let viewerResultLabel = resultLabel;

  if (!roundGuess && shouldRevealGuessFeedback(phase) && guessHistory.length) {
    const officialEntry = guessHistory.find((entry) => entry.isOfficial && entry.guess)
      || [...guessHistory].reverse().find((entry) => entry.guess && entry.status !== "missed");
    if (officialEntry) {
      roundGuess = officialEntry.guess;
      if (officialEntry.pattern) {
        viewerResultPattern = officialEntry.pattern;
        viewerResultLabel = officialEntry.resultLabel;
      } else {
        const feedback = await getGuessFeedback(state, roundGuess, client);
        viewerResultPattern = feedback.pattern;
        viewerResultLabel = feedback.resultLabel;
      }
    }
  }

  return {
    found: true,
    sessionValid,
    displayName: player.displayName,
    balls: Number(player.balls || 0),
    lockedIn: phase === "guessing" && submitted && !player.solvedCurrentWord,
    resultPattern: viewerResultPattern,
    roundGuess,
    resultLabel: viewerResultLabel,
    guessHistory,
    isSolved: Boolean(player.solvedCurrentWord),
    isChampion: isChampionPlayer(player.displayName, state),
  };
}

async function buildPublicStatePayload(state, displayName, playerToken, client = pool) {
  const metrics = await getPublicMetrics(state.session_id, state.round_number, client);
  const players = await getPublicDisplayPlayers(state, client);
  const viewer = await buildViewerContext(displayName, playerToken, state, client);
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
  const totalWords = await countWords(pool);
  if (totalWords === 0) {
    await seedWordsTable(pool);
  }
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
    timerPaused: Boolean(row.timer_paused),
    timerPausedRemainingSeconds: row.timer_paused_remaining_seconds != null
      ? Number(row.timer_paused_remaining_seconds)
      : null,
    roundBallStakes: parseRoundBallStakesPreserveOrder(row),
    guessWindowSeq: Number(row.guess_window_seq || 0),
    allPlayersSubmittedAtIso: row.all_players_submitted_at
      ? new Date(row.all_players_submitted_at).toISOString()
      : null,
    ...timerRemainingForState(row),
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
    playSiteUrl: getPlaySiteUrl(),
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

  function patchOrState(key, fallback = null) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      return patch[key] ?? fallback;
    }
    return state[key] ?? fallback;
  }

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
    Boolean(next.timer_paused),
    patchOrState("timer_paused_remaining_seconds"),
    patchOrState("champion_display_name", ""),
    patchOrState("first_solver_player_id"),
    JSON.stringify(parseWordListFromState(next.host_word_suggestions ?? state.host_word_suggestions)),
    JSON.stringify(parseWordListFromState(next.host_word_exclusions ?? state.host_word_exclusions)),
    JSON.stringify(parseRoundBallStakesPreserveOrder(next)),
    patchOrState("all_players_submitted_at"),
    Number(next.guess_window_seq ?? state.guess_window_seq ?? 0),
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
         timer_paused = $15,
         timer_paused_remaining_seconds = $16,
         champion_display_name = $17,
         first_solver_player_id = $18,
         host_word_suggestions = $19::jsonb,
         host_word_exclusions = $20::jsonb,
         round_ball_stakes = $21::jsonb,
         all_players_submitted_at = $22,
         guess_window_seq = $23,
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
  const hadSolverBeforeReveal = players.some((player) => player.solvedCurrentWord);
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
    if (someoneNewlySolved) {
      ballsRemaining -= multiplier;
    }
  } else if (hadSolverBeforeReveal || someoneNewlySolved) {
    ballsRemaining -= multiplier;
  }

  const refreshedPlayers = await listPlayers(state.session_id, client);
  const everyoneSolved = refreshedPlayers.length > 0
    && refreshedPlayers.every((player) => player.solvedCurrentWord);

  const patch = {
    balls_remaining: Math.max(0, ballsRemaining),
    results_window_opened_at: windowOpenedAtIso(),
    first_solver_player_id: firstSolverId,
    ...clearTimerPausePatch(),
    ...clearAllSubmittedGracePatch(),
  };

  if (lastGuessWasTwoBall || everyoneSolved) {
    patch.phase = "ended";
    patch.answer_revealed = true;
    patch.balls_remaining = 0;
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

  const revealedPerfect = submittedThisRound && guess && guessIsLegal && resultPattern === "!!!!!";
  const confirmedSolve = solvedCurrentWord;

  if (phase === "guessing") {
    if (confirmedSolve) {
      status = "solved";
      statusText = "Congratulations!";
      cardTone = "solved";
    } else if (submittedThisRound) {
      status = "locked";
      statusText = "Locked in";
    }
  } else if (phase === "results" || phase === "ended") {
    if (confirmedSolve || revealedPerfect) {
      status = "solved";
      statusText = "Congratulations!";
      cardTone = "solved";
    } else if (!submittedThisRound) {
      statusText = "No guess this round";
    } else if (!guessIsLegal) {
      status = "invalid";
      statusText = "Not a word…";
      cardTone = "invalid";
    } else {
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
    isWinner: confirmedSolve || revealedPerfect,
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
         round_number = 0,
         submitted_at = null,
         updated_at = now()
     where session_id = $1`,
    [sessionId]
  );
}

async function clearSessionPlayers(sessionId, client = pool) {
  await client.query(
    `delete from players
     where session_id = $1`,
    [sessionId],
  );
}

function getPlaySiteUrl() {
  const configured = String(process.env.PLAY_SITE_URL || DEFAULT_PLAY_SITE_URL).trim();
  return (configured || DEFAULT_PLAY_SITE_URL).replace(/\/$/, "");
}

function playPageUrl() {
  return `${getPlaySiteUrl()}/`;
}

app.get("/api/play-qr", async (req, res) => {
  try {
    const url = playPageUrl();
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

app.get("/health/live", (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ ok: false, status: "draining" });
    return;
  }
  res.json({ ok: true });
});

app.get("/health", async (_req, res) => {
  if (!appReady) {
    res.status(503).json({ ok: false, error: "Starting" });
    return;
  }
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
    const playerToken = normalizePlayerToken(req.query.playerToken);
    res.json({
      ok: true,
      state: await buildPublicStatePayload(state, displayName, playerToken),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/join", async (req, res) => {
  const displayName = normalizeDisplayName(req.body.displayName);
  const playerToken = normalizePlayerToken(req.body.playerToken);
  if (!displayName) {
    res.status(400).json({ ok: false, error: "User name is required." });
    return;
  }
  if (displayName.length > 40) {
    res.status(400).json({ ok: false, error: "User name must be 40 characters or fewer." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const state = await getState(client);
    const player = await upsertLobbyPlayer(state.session_id, displayName, playerToken, client);
    await client.query("commit");

    const nextState = await maybeAdvanceTimedPhase();
    const identity = serializePlayerIdentity(player);
    res.json({
      ok: true,
      player: identity,
      publicState: await buildPublicStatePayload(nextState, identity.displayName, identity.playerToken),
    });
  } catch (error) {
    await client.query("rollback");
    res.status(400).json({ ok: false, error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/public/leave", async (req, res) => {
  const displayName = normalizeDisplayName(req.body.displayName);
  const playerToken = normalizePlayerToken(req.body.playerToken);
  if (!playerToken) {
    res.status(400).json({ ok: false, error: "Player session is required. Re-join the game." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const state = await getState(client);
    const player = await getPlayerByToken(state.session_id, playerToken, client);
    if (!player) {
      throw new Error("Player session not found. Re-join the game.");
    }
    await client.query(
      `delete from players
       where id = $1
         and session_id = $2`,
      [player.id, state.session_id],
    );
    await client.query("commit");

    const nextState = await maybeAdvanceTimedPhase();
    res.json({
      ok: true,
      publicState: await buildPublicStatePayload(nextState, displayName, ""),
    });
  } catch (error) {
    await client.query("rollback");
    res.status(400).json({ ok: false, error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/public/submit-guess", async (req, res) => {
  const displayName = normalizeDisplayName(req.body.displayName);
  const playerToken = normalizePlayerToken(req.body.playerToken);
  const guess = normalizeWordInput(req.body.guess);

  if (!playerToken) {
    res.status(400).json({ ok: false, error: "Player session is required. Re-join the game." });
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

    const playerRow = await getPlayerByToken(state.session_id, playerToken, client);
    if (!playerRow) {
      throw new Error("Player session not found. Re-join the game.");
    }
    if (displayName
      && normalizePlayerKey(displayName) !== playerRow.normalized_display_name) {
      throw new Error("Display name does not match your player session.");
    }

    if (playerRow.solved_current_word
      || await playerHasPerfectSolveForRound(state, playerRow, client)) {
      throw new Error("You already solved this word for the round.");
    }

    const upsertResult = await client.query(
      `update players
       set current_guess = $1,
           round_number = $2,
           first_letter = $3,
           submitted_at = now(),
           updated_at = now()
       where id = $4
       returning *`,
      [
        guess,
        state.round_number,
        guess.charAt(0).toUpperCase(),
        playerRow.id,
      ],
    );

    const player = upsertResult.rows[0];

    const ballStake = Number(state.balls_remaining || 0);
    const windowSeq = Number(state.guess_window_seq || 0);
    const lastSubmission = await client.query(
      `select id, guess, ball_stake, guess_window_seq
       from guess_submissions
       where session_id = $1
         and player_id = $2
         and round_number = $3
       order by submitted_at desc, id desc
       limit 1`,
      [state.session_id, player.id, state.round_number],
    );
    const lastRow = lastSubmission.rows[0];
    const lastGuess = lastRow ? normalizeWordInput(lastRow.guess) : "";

    if (lastGuess !== guess) {
      if (lastRow && Number(lastRow.guess_window_seq || 0) === windowSeq) {
        await client.query(
          `update guess_submissions
           set guess = $1,
               submitted_at = now(),
               result_pattern = '',
               result_label = '',
               is_official = false
           where id = $2`,
          [guess, lastRow.id],
        );
      } else {
        await client.query(
          `insert into guess_submissions (
             session_id,
             player_id,
             round_number,
             guess,
             ball_stake,
             guess_window_seq,
             submitted_at
           )
           values ($1, $2, $3, $4, $5, $6, now())`,
          [
            state.session_id,
            player.id,
            state.round_number,
            guess,
            ballStake,
            windowSeq,
          ],
        );
      }
    }

    const solvedNow = await isLegalWord(client, guess)
      && getLingoResultPattern(state.current_word, guess) === "!!!!!";

    let nextState = await getState(client);
    nextState = await maybeAutoRevealIfAllSubmitted(nextState, client);

    await client.query("commit");

    const identity = serializePlayerIdentity(await ensurePlayerToken(player, client));
    res.json({
      ok: true,
      solvedNow,
      player: {
        ...identity,
        currentGuess: player.current_guess,
        roundNumber: player.round_number,
        submittedAtIso: player.submitted_at ? new Date(player.submitted_at).toISOString() : nowIso(),
      },
      publicState: await buildPublicStatePayload(
        nextState,
        identity.displayName,
        identity.playerToken,
      ),
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
    const playersWithHistory = await Promise.all(players.map(async (player) => ({
      ...player,
      guessHistory: await listViewerGuessHistory(player.id, state, pool, { hostMode: true }),
    })));
    res.json({
      ok: true,
      state: {
        session: serializeState(state),
        players: playersWithHistory,
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
        timer_paused: false,
        timer_paused_remaining_seconds: null,
        round_ball_stakes: [],
        guess_window_seq: 0,
        all_players_submitted_at: null,
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
      if (word && (state.phase === "guessing" || state.phase === "results")) {
        throw new Error("Cannot change the word during an active round.");
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
        const openingStake = 6 * multiplier;
        const nextState = await updateState({
          phase: "guessing",
          round_number: nextRound,
          answer_revealed: false,
          balls_remaining: openingStake,
          guess_window_seq: 1,
          round_ball_stakes: [openingStake],
          guess_window_seconds: Number(body.guessWindowSeconds || state.guess_window_seconds || 90),
          results_window_seconds: Number(body.resultsWindowSeconds || state.results_window_seconds || 45),
          guess_window_opened_at: windowOpenedAtIso(),
          first_solver_player_id: null,
          ...clearTimerPausePatch(),
          ...clearAllSubmittedGracePatch(),
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
    case "toggle-timer-pause": {
      if (state.phase !== "guessing" && state.phase !== "results") {
        throw new Error("Timer can only be paused during guessing or results.");
      }
      if (state.timer_paused) {
        const remaining = Math.max(0, Number(state.timer_paused_remaining_seconds || 0));
        if (state.phase === "guessing") {
          return serializeState(await updateState({
            ...clearTimerPausePatch(),
            guess_window_seconds: remaining,
            guess_window_opened_at: windowOpenedAtIso(),
          }));
        }
        return serializeState(await updateState({
          ...clearTimerPausePatch(),
          results_window_seconds: remaining,
          results_window_opened_at: windowOpenedAtIso(),
        }));
      }

      let remaining = 0;
      if (state.phase === "guessing") {
        remaining = computeWindowRemainingSeconds(
          state.guess_window_opened_at,
          state.guess_window_seconds,
        );
      } else {
        remaining = computeWindowRemainingSeconds(
          state.results_window_opened_at,
          state.results_window_seconds,
        );
      }
      if (remaining == null) {
        throw new Error("Timer is not running.");
      }
      return serializeState(await updateState({
        timer_paused: true,
        timer_paused_remaining_seconds: remaining,
      }));
    }
    case "reveal-answer":
      return serializeState(await updateState({
        answer_revealed: true,
        phase: "ended",
        balls_remaining: 0,
        ...clearTimerPausePatch(),
      }));
    case "reset-session": {
      const wordPool = await resetHostWordPool();
      await clearSessionPlayers(state.session_id);
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
        timer_paused: false,
        timer_paused_remaining_seconds: null,
        round_ball_stakes: [],
        guess_window_seq: 0,
        all_players_submitted_at: null,
        ...wordPool,
      }));
    }
    default:
      throw new Error(`Unknown admin action: ${action}`);
  }
}

app.get("/api/admin/rehearsal", requireAdmin, async (_req, res) => {
  try {
    const state = await getState();
    res.json({
      ok: true,
      autoSubmit: rehearsalAutoSubmitEnabled,
      status: await getRehearsalStatus(state, listPlayers, pool),
      state: serializeState(state),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/rehearsal/:command", requireAdmin, async (req, res) => {
  const body = req.body || {};
  try {
    switch (req.params.command) {
      case "setup": {
        const client = await pool.connect();
        try {
          await client.query("begin");
          let state = await getState(client);
          if (state.phase !== "idle") {
            if (!body.forceReset) {
              throw new Error("Session must be idle. Use force reset on setup or hard reset first.");
            }
            await clearRehearsalBots(state.session_id, client);
            await client.query(
              `update players
               set balls = 0,
                   solved_current_word = false,
                   current_guess = '',
                   submitted_at = null,
                   updated_at = now()
               where session_id = $1`,
              [state.session_id],
            );
            state = await updateState({
              phase: "idle",
              round_number: 0,
              current_word: "",
              answer_revealed: false,
              balls_remaining: 0,
              guess_window_opened_at: null,
              results_window_opened_at: null,
              first_solver_player_id: null,
              ...clearTimerPausePatch(),
            }, client);
          }

          const bots = await seedRehearsalBots(state.session_id, upsertLobbyPlayer, client);
          const [word] = await pickRandomWords(client, 1);
          if (!word) {
            throw new Error("No legal words available for rehearsal.");
          }
          state = await updateState({
            current_word: word,
            answer_revealed: false,
            host_note: `Rehearsal — ${REHEARSAL_BOT_COUNT} virtual players`,
          }, client);

          if (body.startRound) {
            const multiplier = Number(state.ball_multiplier || 1);
            const openingStake = 6 * multiplier;
            state = await updateState({
              phase: "guessing",
              round_number: 1,
              answer_revealed: false,
              balls_remaining: openingStake,
              guess_window_seq: 1,
              round_ball_stakes: [openingStake],
              guess_window_seconds: Number(body.guessWindowSeconds || state.guess_window_seconds || 90),
              results_window_seconds: Number(body.resultsWindowSeconds || state.results_window_seconds || 45),
              guess_window_opened_at: windowOpenedAtIso(),
              first_solver_player_id: null,
              ...clearTimerPausePatch(),
              ...clearAllSubmittedGracePatch(),
            }, client);
            await clearSessionGuesses(state.session_id, client);
            await resetWordProgress(state.session_id, client);
          }

          await client.query("commit");
          if (body.autoSubmit !== false) {
            rehearsalAutoSubmitEnabled = true;
          }
          if (state.phase === "guessing") {
            await runRehearsalBotSubmissions();
          }
          const finalState = await getState();
          res.json({
            ok: true,
            autoSubmit: rehearsalAutoSubmitEnabled,
            bots,
            word,
            status: await getRehearsalStatus(finalState, listPlayers, pool),
            state: await enrichStateWithWordPool(finalState),
          });
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
        return;
      }
      case "submit-guesses": {
        const result = await runRehearsalBotSubmissions();
        const state = await getState();
        res.json({
          ok: true,
          result,
          status: await getRehearsalStatus(state, listPlayers, pool),
          state: await enrichStateWithWordPool(state),
        });
        return;
      }
      case "clear": {
        const state = await getState();
        if (state.phase !== "idle") {
          throw new Error("Clear rehearsal bots only while idle.");
        }
        await clearRehearsalBots(state.session_id, pool);
        rehearsalAutoSubmitEnabled = false;
        const nextState = await getState();
        res.json({
          ok: true,
          autoSubmit: false,
          status: await getRehearsalStatus(nextState, listPlayers, pool),
          state: await enrichStateWithWordPool(nextState),
        });
        return;
      }
      case "auto": {
        rehearsalAutoSubmitEnabled = Boolean(body.enabled);
        const state = await getState();
        if (rehearsalAutoSubmitEnabled && state.phase === "guessing") {
          await runRehearsalBotSubmissions();
        }
        res.json({
          ok: true,
          autoSubmit: rehearsalAutoSubmitEnabled,
          status: await getRehearsalStatus(await getState(), listPlayers, pool),
          state: await enrichStateWithWordPool(await getState()),
        });
        return;
      }
      default:
        throw new Error(`Unknown rehearsal command: ${req.params.command}`);
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

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
      : req.path === "/rehearsal"
        ? "rehearsal.html"
        : "index.html";
  res.sendFile(path.join(staticDir, fileName));
});

function startBackgroundTimers() {
  timerTickHandle = setInterval(() => {
    if (shuttingDown || !appReady) return;
    maybeAdvanceTimedPhase().catch((error) => {
      if (!shuttingDown) {
        console.error("timer tick", error.message);
      }
    });
  }, 1000);
  rehearsalTickHandle = setInterval(() => {
    if (shuttingDown || !rehearsalAutoSubmitEnabled) return;
    runRehearsalBotSubmissions().catch((error) => {
      if (!shuttingDown) {
        console.error("rehearsal bots", error.message);
      }
    });
  }, 2500);
}

function stopBackgroundTimers() {
  if (timerTickHandle) {
    clearInterval(timerTickHandle);
    timerTickHandle = null;
  }
  if (rehearsalTickHandle) {
    clearInterval(rehearsalTickHandle);
    rehearsalTickHandle = null;
  }
}

async function bootstrapWithRetry(maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ensureSchema();
      const state = await getState();
      const totalWords = await countWords(pool);
      appReady = true;
      console.log(`Lingo online app ready. Session: ${state.session_id}. Words: ${totalWords}`);
      return;
    } catch (error) {
      console.error(`Bootstrap attempt ${attempt}/${maxAttempts} failed:`, error.message);
      if (attempt >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  appReady = false;
  console.log(`${signal} received — shutting down gracefully`);

  stopBackgroundTimers();

  const forceExitTimer = setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, SHUTDOWN_FORCE_MS);
  forceExitTimer.unref();

  try {
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    await pool.end();
    clearTimeout(forceExitTimer);
    console.log("Shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error("Shutdown error:", error.message);
    process.exit(1);
  }
}

async function startServer() {
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("SIGTERM handler failed:", error.message);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("SIGINT handler failed:", error.message);
      process.exit(1);
    });
  });

  await bootstrapWithRetry();

  httpServer = app.listen(port, "0.0.0.0", () => {
    console.log(`Listening on http://0.0.0.0:${port}`);
    startBackgroundTimers();
  });
}

startServer().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
