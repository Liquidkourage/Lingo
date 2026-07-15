const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { countAvailableWords, countWords, isFiveLetterWord, isLegalWord, normalizeWordInput, normalizeWordList, pickRandomWords, seedWordsTable } = require("./words");
const {
  DEFAULT_EVENT_CODE,
  displayJoinCode,
  formatEventCode,
  joinPlayUrl,
  loadEventCodeBlocklist,
  normalizeEventCodeInput,
  pickRandomEventCode,
  validateEventCode,
} = require("./event-codes");
const {
  REHEARSAL_BOT_COUNT,
  clearRehearsalBots,
  getRehearsalStatus,
  seedRehearsalBots,
  submitRehearsalBotGuesses,
} = require("./rehearsal-bots");
const {
  generateCallSheet,
  createGameId,
  callsMade,
  calledNumbersFromSheet,
  hasBingoLine,
  generateBingoCard,
  evaluateBingoClaim,
  bingoAchievedWithinBudget,
} = require("./bingo-logic");
const { listWordSets, loadWordSetById } = require("./word-sets");
require("dotenv").config();

const QRCode = require("qrcode");

function resolveDatabaseUrl() {
  const direct = [
    process.env.DATABASE_URL,
    process.env.DATABASE_PRIVATE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRESQL_URL,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  if (direct) {
    return direct;
  }

  const user = process.env.PGUSER || process.env.POSTGRES_USER;
  const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
  const host = process.env.PGHOST || process.env.POSTGRES_HOST;
  const port = process.env.PGPORT || process.env.POSTGRES_PORT || "5432";
  const database = process.env.PGDATABASE || process.env.POSTGRES_DB;
  if (user && password && host && database) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  }

  return "";
}

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const adminKey = String(process.env.LINGO_ADMIN_KEY || "").trim();
const databaseUrl = resolveDatabaseUrl();
const defaultChampion = String(process.env.LINGO_CHAMPION || "").trim();
const LINGO_AMBASSADOR_ALIASES = new Set(
  String(process.env.LINGO_AMBASSADOR || "jeewee")
    .split(",")
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean),
);
const DEFAULT_PLAY_SITE_URL = "https://lingo.liquidkourage.com";

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. On Railway, open your web service → Variables → add a reference to the Postgres plugin's DATABASE_URL (or DATABASE_PRIVATE_URL).",
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});

const eventContext = new AsyncLocalStorage();

function normalizeEventCode(value) {
  return formatEventCode(value);
}

function currentEventCode() {
  return eventContext.getStore()?.eventCode || DEFAULT_EVENT_CODE;
}

function runWithEventCode(eventCode, fn) {
  return eventContext.run({ eventCode: normalizeEventCode(eventCode) }, fn);
}

function resolveEventCodeFromRequest(req) {
  return normalizeEventCode(
    req.get("x-lingo-event-code")
    || req.query.join
    || req.query.code
    || req.query.event
    || req.query.eventCode
    || req.body?.join
    || req.body?.code
    || req.body?.eventCode
    || req.body?.event,
  );
}

function attachEventContext(req, res, next) {
  try {
    runWithEventCode(resolveEventCodeFromRequest(req), next);
  } catch (error) {
    const creatingEvent = req.method === "POST"
      && String(req.path || "").includes("create-event");
    if (creatingEvent) {
      runWithEventCode(DEFAULT_EVENT_CODE, next);
      return;
    }
    res.status(400).json({ ok: false, error: error.message });
  }
}

async function createEventRow(eventCode, client = pool) {
  const code = await validateEventCode(client, eventCode, { allowDefault: false });
  const existing = await client.query(
    "select 1 from app_state where event_code = $1",
    [code],
  );
  if (existing.rowCount) {
    throw new Error("Event code already in use. Pick another.");
  }

  const sessionId = `session_${Date.now()}`;
  const idResult = await client.query("select coalesce(max(id), 0) + 1 as next_id from app_state");
  const nextId = Number(idResult.rows[0]?.next_id || 1);
  const result = await client.query(
    `insert into app_state (
       id,
       event_code,
       version,
       mode,
       phase,
       session_id,
       round_number,
       current_word,
       answer_revealed,
       ball_multiplier,
       balls_remaining,
       guess_window_seconds,
       results_window_seconds,
       host_note
     ) values ($1, $2, 1, 'lingo', 'idle', $3, 0, '', false, 1, 0, $4, $5, '')
     returning *`,
    [nextId, code, sessionId, DEFAULT_GUESS_WINDOW_SECONDS, DEFAULT_RESULTS_WINDOW_SECONDS],
  );
  return result.rows[0];
}

const staticDir = path.join(__dirname, "public");
const schemaPath = path.join(__dirname, "db", "schema.sql");
const HOST_WORD_SUGGESTION_COUNT = 100;
const HOST_WORD_QUEUE_MAX = 8;
const HOST_BROADCAST_MAX_LENGTH = 200;
const PROFILE_DISPLAY_NAME_MAX_LENGTH = 40;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SCRAMBLE_WORD_LENGTH = 8;
const SCRAMBLE_ANSWERS = [
  "TYPEOING",
  "GAMEWORD",
  "SHOWTIME",
  "LIQUIDKO",
  "WORDPLAY",
  "BALLPARK",
  "GUESSTWO",
  "FINALEON",
];
const ALL_SUBMITTED_GRACE_SECONDS = 10;
const MAX_GUESS_HISTORY_WINDOWS = 12;
const ABANDONED_SESSION_IDLE_MS = 60 * 60 * 1000;
const MIN_GUESS_WINDOW_SECONDS = 30;
const DEFAULT_GUESS_WINDOW_SECONDS = 100;
const MIN_RESULTS_WINDOW_SECONDS = 15;
const DEFAULT_RESULTS_WINDOW_SECONDS = 20;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 6;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
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

function normalizeUsername(username) {
  return String(username || "").trim();
}

function normalizedUsernameKey(username) {
  return normalizeUsername(username).toLowerCase();
}

function validateUsername(username) {
  const value = normalizeUsername(username);
  if (value.length < MIN_USERNAME_LENGTH || value.length > MAX_USERNAME_LENGTH) {
    throw new Error(`Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters.`);
  }
  if (!USERNAME_PATTERN.test(value)) {
    throw new Error("Username may only use letters, numbers, and underscores.");
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

function validateProfileDisplayName(displayName) {
  const value = normalizeDisplayName(displayName);
  if (!value) {
    throw new Error("Display name is required.");
  }
  if (value.length > PROFILE_DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`Display name must be ${PROFILE_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`);
  }
  return value;
}

function userProfileDisplayName(user) {
  const profile = normalizeDisplayName(user?.profile_display_name);
  if (profile) return profile;
  return normalizeDisplayName(user?.username);
}

function serializeUserPublic(user) {
  return {
    username: user.username,
    authToken: user.auth_token,
    profileDisplayName: userProfileDisplayName(user),
    email: String(user.email || "").trim(),
    emailVerified: Boolean(user.email_verified),
  };
}

function pickScrambleWord() {
  const index = Math.floor(Math.random() * SCRAMBLE_ANSWERS.length);
  return SCRAMBLE_ANSWERS[index] || "TYPEOING";
}

function buildLeaderboardEntries(players) {
  return (Array.isArray(players) ? players : [])
    .map((player) => ({
      displayName: player.displayName,
      balls: Number(player.balls || 0),
      isChampion: Boolean(player.isChampion),
      isAmbassador: isAmbassadorPlayer(player.displayName),
      isSolved: Boolean(player.isSolved),
    }))
    .sort((left, right) => {
      if (right.balls !== left.balls) return right.balls - left.balls;
      return String(left.displayName).localeCompare(String(right.displayName));
    });
}

function buildUnsubmittedPlayerNames(state, players) {
  const phase = String(state.phase || "idle");
  if (phase !== "guessing" && phase !== "results") {
    return [];
  }
  const round = Number(state.round_number || 0);
  return (Array.isArray(players) ? players : [])
    .filter((player) => {
      if (player.solvedCurrentWord || player.isSolved) return false;
      if (Number(player.roundNumber) !== round) return true;
      return !player.hasSubmitted;
    })
    .map((player) => player.displayName)
    .filter(Boolean);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash || "").split(":");
  if (!salt || !expectedHex) return false;
  const actualHex = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function newAuthToken() {
  return crypto.randomUUID();
}

async function getUserByAuthToken(authToken, client = pool) {
  const token = normalizePlayerToken(authToken);
  if (!token) return null;
  const result = await client.query(
    `select id, username, normalized_username, auth_token, created_at, updated_at
     from users
     where auth_token = $1`,
    [token],
  );
  return result.rows[0] || null;
}

async function getPlayerByUserId(sessionId, userId, client = pool) {
  const result = await client.query(
    `select *
     from players
     where session_id = $1
       and user_id = $2`,
    [sessionId, userId],
  );
  return result.rows[0] || null;
}

async function createUserAccount(username, password, client = pool) {
  const normalized = validateUsername(username);
  const normalizedKey = normalizedUsernameKey(normalized);
  validatePassword(password);
  const existing = await client.query(
    `select id from users where normalized_username = $1`,
    [normalizedKey],
  );
  if (existing.rows.length) {
    throw new Error("That username is already taken.");
  }
  const authToken = newAuthToken();
  const result = await client.query(
    `insert into users (username, normalized_username, password_hash, auth_token, profile_display_name, updated_at)
     values ($1, $2, $3, $4, $1, now())
     returning *`,
    [normalized, normalizedKey, hashPassword(password), authToken],
  );
  return result.rows[0];
}

async function loginUserAccount(username, password, client = pool) {
  const normalizedKey = normalizedUsernameKey(validateUsername(username));
  validatePassword(password);
  const result = await client.query(
    `select * from users where normalized_username = $1`,
    [normalizedKey],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new Error("Invalid username or password.");
  }
  const authToken = newAuthToken();
  await client.query(
    `update users
     set auth_token = $1,
         updated_at = now()
     where id = $2`,
    [authToken, user.id],
  );
  return {
    id: user.id,
    username: user.username,
    auth_token: authToken,
  };
}

async function logoutUserAccount(authToken, client = pool) {
  await client.query(
    `update users
     set auth_token = null,
         updated_at = now()
     where auth_token = $1`,
    [normalizePlayerToken(authToken)],
  );
}

async function upsertLobbyPlayerForUser(sessionId, user, client = pool) {
  const userId = Number(user.id);
  const displayName = userProfileDisplayName(user);
  const normalized = normalizePlayerKey(displayName);

  const existingByUser = await getPlayerByUserId(sessionId, userId, client);
  if (existingByUser) {
    return ensurePlayerToken(existingByUser, client);
  }

  const conflict = await client.query(
    `select id
     from players
     where session_id = $1
       and normalized_display_name = $2
       and (user_id is null or user_id <> $3)`,
    [sessionId, normalized, userId],
  );
  if (conflict.rows.length) {
    throw new Error("That name is already taken in this session.");
  }

  const result = await client.query(
    `insert into players (
       session_id,
       display_name,
       normalized_display_name,
       player_token,
       user_id,
       updated_at
     )
     values ($1, $2, $3, $4, $5, now())
     returning *`,
    [sessionId, displayName, normalized, newPlayerToken(), userId],
  );
  return ensurePlayerToken(result.rows[0], client);
}

async function resolvePlayerForAuth(sessionId, authToken, client = pool) {
  const user = await getUserByAuthToken(authToken, client);
  if (!user) {
    throw new Error("Sign in to continue.");
  }
  const row = await getPlayerByUserId(sessionId, user.id, client);
  if (!row) {
    throw new Error("Join the game on this device first.");
  }
  return { user, row };
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

function isAmbassadorPlayer(displayName) {
  const raw = String(displayName || "").trim().toLowerCase();
  if (!raw) return false;
  if (LINGO_AMBASSADOR_ALIASES.has(raw)) return true;
  return LINGO_AMBASSADOR_ALIASES.has(normalizePlayerKey(displayName));
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

function parseWordQueueFromState(value) {
  return parseWordListFromState(value).slice(0, HOST_WORD_QUEUE_MAX);
}

function parseWordHistoryFromState(value) {
  return parseWordListFromState(value);
}

async function listGlobalHostWordBans(client = pool) {
  const result = await client.query(
    `select word from host_word_bans order by word asc`,
  );
  return normalizeWordList(result.rows.map((row) => row.word));
}

async function addGlobalHostWordBan(word, client = pool) {
  const normalized = normalizeWordInput(word);
  if (!isFiveLetterWord(normalized)) {
    return;
  }
  await client.query(
    `insert into host_word_bans (word)
     values ($1)
     on conflict (word) do nothing`,
    [normalized],
  );
}

async function removeGlobalHostWordBan(word, client = pool) {
  const normalized = normalizeWordInput(word);
  if (!isFiveLetterWord(normalized)) {
    return;
  }
  await client.query(
    `delete from host_word_bans where word = $1`,
    [normalized],
  );
}

async function migrateEventExclusionsToGlobalBans(client = pool) {
  const result = await client.query(`select host_word_exclusions from app_state`);
  for (const row of result.rows) {
    for (const word of parseWordListFromState(row.host_word_exclusions)) {
      await addGlobalHostWordBan(word, client);
    }
  }
}

async function hostWordPoolExclusions(state, client = pool) {
  const globalBans = await listGlobalHostWordBans(client);
  return normalizeWordList([
    ...globalBans,
    ...parseWordListFromState(state.host_word_exclusions),
    ...parseWordHistoryFromState(state.host_word_history),
    ...parseWordQueueFromState(state.host_word_queue),
  ]);
}

function buildWordQueueAdvancePatch(state) {
  const completed = normalizeWordInput(state.current_word || "");
  if (!completed) {
    return {};
  }

  const history = parseWordHistoryFromState(state.host_word_history);
  if (!history.includes(completed)) {
    history.push(completed);
  }

  let queue = parseWordQueueFromState(state.host_word_queue);
  if (queue.length > 0 && queue[0] === completed) {
    queue = queue.slice(1);
  } else {
    queue = queue.filter((word) => word !== completed);
  }

  return {
    host_word_history: history,
    host_word_queue: queue,
    current_word: queue[0] || "",
  };
}

function endRoundPatch(state) {
  return endCurrentWordPatch();
}

function wordQueueAdvancePatchForStartRound(state) {
  if (state.phase !== "ended" || !state.answer_revealed) {
    return {};
  }
  return buildWordQueueAdvancePatch(state);
}

async function buildHostWordSuggestions(exclusions, count = HOST_WORD_SUGGESTION_COUNT, client = pool) {
  return pickRandomWords(client, count, exclusions);
}

async function resetHostWordPool(state = {}, client = pool) {
  const exclusions = await hostWordPoolExclusions(state, client);
  const suggestions = await buildHostWordSuggestions(
    exclusions,
    HOST_WORD_SUGGESTION_COUNT,
    client,
  );
  return {
    host_word_suggestions: suggestions,
    host_word_queue: [],
    host_word_history: [],
  };
}

async function ensureHostWordPool(state, client = pool) {
  const exclusions = await hostWordPoolExclusions(state, client);
  const exclusionSet = new Set(exclusions);
  const currentSuggestions = parseWordListFromState(state.host_word_suggestions);
  const filteredSuggestions = currentSuggestions.filter((word) => !exclusionSet.has(word));
  if (filteredSuggestions.length > 0) {
    if (filteredSuggestions.length !== currentSuggestions.length) {
      return updateState({
        host_word_suggestions: filteredSuggestions,
      }, client);
    }
    return state;
  }

  const nextSuggestions = await buildHostWordSuggestions(exclusions, HOST_WORD_SUGGESTION_COUNT, client);
  if (!nextSuggestions.length) return state;

  return updateState({
    host_word_suggestions: nextSuggestions,
  }, client);
}

async function enrichStateWithWordPool(state, client = pool) {
  const globalBans = await listGlobalHostWordBans(client);
  const exclusions = await hostWordPoolExclusions({
    host_word_exclusions: state.wordExclusions,
    host_word_history: state.wordHistory,
    host_word_queue: state.wordQueue,
  }, client);
  return {
    ...state,
    wordExclusions: globalBans,
    availableWordCount: await countAvailableWords(client, exclusions),
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

function configuredGuessWindowSeconds(stored) {
  const value = Number(stored || 0);
  if (Number.isFinite(value) && value >= 60) {
    return Math.floor(value);
  }
  return DEFAULT_GUESS_WINDOW_SECONDS;
}

function configuredResultsWindowSeconds(stored) {
  const value = Number(stored || 0);
  if (Number.isFinite(value) && value >= MIN_RESULTS_WINDOW_SECONDS) {
    return Math.floor(value);
  }
  return DEFAULT_RESULTS_WINDOW_SECONDS;
}

function normalizedGuessWindowSeconds(value, fallback = DEFAULT_GUESS_WINDOW_SECONDS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= MIN_GUESS_WINDOW_SECONDS) {
    return Math.floor(parsed);
  }
  return configuredGuessWindowSeconds(fallback);
}

function normalizedResultsWindowSeconds(value, fallback = DEFAULT_RESULTS_WINDOW_SECONDS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= MIN_RESULTS_WINDOW_SECONDS) {
    return Math.floor(parsed);
  }
  return configuredResultsWindowSeconds(fallback);
}

function windowOpenedAtForRemaining(windowSeconds, remainingSeconds) {
  const total = Number(windowSeconds || 0);
  const remaining = Math.max(0, Number(remainingSeconds || 0));
  if (!total) return windowOpenedAtIso();
  const elapsed = Math.max(0, total - remaining);
  return new Date(Date.now() - elapsed * 1000).toISOString();
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
    return updateState(endRoundPatch(state), client);
  }
  const continueStake = Number(state.balls_remaining || 0);
  const nextWindowSeq = Number(state.guess_window_seq || 0) + 1;
  const roundBallStakes = [...parseRoundBallStakesPreserveOrder(state), continueStake];

  const nextState = await updateState({
    phase: "guessing",
    guess_window_opened_at: windowOpenedAtIso(),
    guess_window_seconds: normalizedGuessWindowSeconds(
      guessWindowSeconds,
      state.guess_window_seconds,
    ),
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

async function maybeExpireAbandonedSession(state, client = pool, options = {}) {
  const forceIfEmpty = Boolean(options.forceIfEmpty);
  if (!state || state.phase === "idle") {
    return state;
  }
  const players = await listPlayers(state.session_id, client);
  const updatedAt = state.updated_at ? new Date(state.updated_at).getTime() : 0;
  if (players.length === 0) {
    if (!forceIfEmpty && updatedAt && Date.now() - updatedAt < ABANDONED_SESSION_IDLE_MS) {
      return state;
    }
  } else {
    const lastActivityAt = Math.max(
      updatedAt,
      ...players.map((player) => {
        const playerUpdated = player.updatedAtIso ? new Date(player.updatedAtIso).getTime() : 0;
        const playerCreated = player.createdAtIso ? new Date(player.createdAtIso).getTime() : 0;
        return Math.max(playerUpdated, playerCreated);
      }),
    );
    if (!lastActivityAt || Date.now() - lastActivityAt < ABANDONED_SESSION_IDLE_MS) {
      return state;
    }
  }
  return updateState({
    mode: "lingo",
    phase: "idle",
    round_number: 0,
    current_word: "",
    answer_revealed: false,
    balls_remaining: 0,
    ball_multiplier: 1,
    guess_window_opened_at: null,
    results_window_opened_at: null,
    first_solver_player_id: null,
    timer_paused: false,
    timer_paused_remaining_seconds: null,
    round_ball_stakes: [],
    guess_window_seq: 0,
    all_players_submitted_at: null,
    host_broadcast: "",
    leaderboard_visible: false,
    ...clearTimerPausePatch(),
    ...clearAllSubmittedGracePatch(),
  }, client);
}

async function maybeAdvanceTimedPhase(client = pool) {
  const db = client === pool ? await pool.connect() : client;
  const releaseAfter = client === pool;
  try {
    await db.query("begin");
    let state = await getState(db);
    state = await maybeExpireAbandonedSession(state, db);

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
          state = await updateState(endRoundPatch(state), db);
        }
      }
    } else if (state.phase === "results"
      && windowExpired(state.results_window_opened_at, state.results_window_seconds, state.timer_paused)) {
      const multiplier = Number(state.ball_multiplier || 1);
      const balls = Number(state.balls_remaining || 0);
      if (!state.answer_revealed && balls >= 2 * multiplier) {
        state = await performContinueRound(
          db,
          configuredGuessWindowSeconds(state.guess_window_seconds),
        );
      } else if (!state.answer_revealed) {
        state = await updateState(endRoundPatch(state), db);
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
    const visibleWindows = windows.length > MAX_GUESS_HISTORY_WINDOWS
      ? windows.slice(-MAX_GUESS_HISTORY_WINDOWS)
      : windows;
    const history = [];
    visibleWindows.forEach(({ seq, stake }) => {
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

async function buildViewerContext(displayName, playerToken, state, client = pool, options = {}) {
  const normalized = normalizeDisplayName(displayName);
  const token = normalizePlayerToken(playerToken);
  const authToken = normalizePlayerToken(options.authToken);
  let accountUser = null;

  let player = null;
  let sessionValid = false;
  if (authToken) {
    accountUser = await getUserByAuthToken(authToken, client);
    if (accountUser) {
      const row = await getPlayerByUserId(state.session_id, accountUser.id, client);
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
  }
  if (!player && token) {
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

  if (!token && !normalized && !accountUser) return null;
  const phase = String(state.phase || "idle");
  const round = Number(state.round_number || 0);

  if (!player) {
    return {
      found: false,
      sessionValid: false,
      accountSignedIn: Boolean(accountUser),
      accountUsername: accountUser?.username || "",
      displayName: accountUser?.username || normalized,
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
    accountSignedIn: Boolean(accountUser),
    accountUsername: accountUser?.username || "",
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

const HOST_MESSAGE_MAX_LENGTH = 160;
const HOST_MESSAGE_QUEUE_MAX = 12;

function buildRevealFanfareKey(state) {
  const phase = String(state.phase || "idle");
  if (phase !== "results" && phase !== "ended") {
    return "";
  }
  const round = Number(state.round_number || state.roundNumber || 0);
  const seq = Number(state.guess_window_seq || state.guessWindowSeq || 0);
  return `${round}:${seq}`;
}

function buildCorrectGuessWinners(players) {
  return (Array.isArray(players) ? players : [])
    .filter((player) => player.isWinner && player.resultPattern === "!!!!!")
    .map((player) => ({
      displayName: player.displayName,
    }));
}

async function insertHostMessage(sessionId, displayName, message, client = pool) {
  const text = String(message || "").trim().slice(0, HOST_MESSAGE_MAX_LENGTH);
  if (!text) {
    throw new Error("Message is required.");
  }
  await client.query(
    `insert into host_messages (session_id, display_name, message)
     values ($1, $2, $3)`,
    [sessionId, displayName, text],
  );
  await client.query(
    `delete from host_messages
     where session_id = $1
       and id not in (
         select id
         from host_messages
         where session_id = $1
         order by created_at desc
         limit $2
       )`,
    [sessionId, HOST_MESSAGE_QUEUE_MAX],
  );
}

async function listHostMessages(sessionId, client = pool) {
  const result = await client.query(
    `select id, display_name, message, created_at
     from host_messages
     where session_id = $1
     order by created_at asc
     limit $2`,
    [sessionId, HOST_MESSAGE_QUEUE_MAX],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    displayName: row.display_name,
    message: row.message,
    createdAtIso: new Date(row.created_at).toISOString(),
  }));
}

async function dismissHostMessage(sessionId, messageId, client = pool) {
  await client.query(
    `delete from host_messages
     where session_id = $1
       and id = $2`,
    [sessionId, messageId],
  );
}

async function getLatestBingoGameForSession(sessionId, client = pool) {
  const result = await client.query(
    `select *
     from bingo_games
     where session_id = $1
     order by created_at desc
     limit 1`,
    [sessionId],
  );
  return result.rows[0] || null;
}

function computeBingoPlayerStatus(playerRow, bingoRow) {
  if (!playerRow || !bingoRow) {
    return null;
  }

  const ballsEarned = Number(playerRow.balls || 0);
  const callSheet = Array.isArray(bingoRow.call_sheet) ? bingoRow.call_sheet : [];
  const callIndex = Number(bingoRow.call_index ?? -1);
  const made = callsMade(callIndex);
  const { grid } = generateBingoCard(bingoRow.id, playerRow.display_name);
  const called = calledNumbersFromSheet(callSheet, callIndex);
  const hasLine = hasBingoLine(grid, called);
  const earnedBingoInBudget = bingoAchievedWithinBudget(
    callSheet,
    callIndex,
    ballsEarned,
    grid,
  );
  const budgetRemaining = Math.max(0, ballsEarned - made);
  const hasWinner = Boolean(bingoRow.winner_display_name);
  const isWinner = hasWinner
    && String(bingoRow.winner_display_name).toLowerCase()
      === String(playerRow.display_name).toLowerCase();
  const canClaim = earnedBingoInBudget && !hasWinner;

  let status = "watching";
  let statusLabel = "Watching";
  if (isWinner) {
    status = "winner";
    statusLabel = "Winner";
  } else if (ballsEarned < 1) {
    status = "no-balls";
    statusLabel = "No balls";
  } else if (hasWinner) {
    status = "beaten";
    statusLabel = "Out";
  } else if (canClaim) {
    status = "can-claim";
    statusLabel = "Can claim";
  } else if (hasLine && !earnedBingoInBudget) {
    status = "late";
    statusLabel = "Late line";
  } else if (made >= ballsEarned && !earnedBingoInBudget) {
    status = "out";
    statusLabel = "Out of budget";
  } else if (budgetRemaining === 0) {
    status = "last-call";
    statusLabel = "Last call";
  }

  return {
    ballsEarned,
    callsMade: made,
    budgetRemaining,
    hasLine,
    earnedBingoInBudget,
    canClaim,
    isWinner,
    status,
    statusLabel,
  };
}

function summarizeBingoPlayerStatuses(statuses) {
  const summary = {
    total: statuses.length,
    noBalls: 0,
    watching: 0,
    canClaim: 0,
    out: 0,
    winner: 0,
  };

  for (const status of statuses) {
    if (!status) continue;
    if (status.status === "no-balls") summary.noBalls += 1;
    if (status.status === "watching" || status.status === "last-call") summary.watching += 1;
    if (status.status === "can-claim") summary.canClaim += 1;
    if (status.status === "out" || status.status === "late" || status.status === "beaten") {
      summary.out += 1;
    }
    if (status.status === "winner") summary.winner += 1;
  }

  return summary;
}

async function listBingoPlayerStatuses(sessionId, bingoRow, client = pool) {
  const players = await listPlayers(sessionId, client);
  return players.map((player) => ({
    playerId: Number(player.id),
    displayName: player.displayName,
    bingo: computeBingoPlayerStatus({
      display_name: player.displayName,
      balls: player.balls,
    }, bingoRow),
  }));
}

async function applyWordQueuePatch(state, words, client = pool) {
  const queue = normalizeWordList(words).slice(0, HOST_WORD_QUEUE_MAX);
  for (const word of queue) {
    if (!isFiveLetterWord(word)) {
      throw new Error("Each queued word must be exactly 5 letters.");
    }
    if (!(await isLegalWord(client, word))) {
      throw new Error(`"${word}" is not a legal 5-letter Scrabble word.`);
    }
  }
  const history = parseWordHistoryFromState(state.host_word_history);
  const overlap = queue.find((word) => history.includes(word));
  if (overlap) {
    throw new Error(`"${overlap}" was already played this session.`);
  }
  const patch = { host_word_queue: queue };
  const currentWord = normalizeWordInput(state.current_word);
  if (!currentWord || !queue.includes(currentWord)) {
    patch.current_word = queue[0] || "";
  }
  return patch;
}

async function buildPublicStatePayload(state, displayName, playerToken, client = pool, options = {}) {
  const metrics = await getPublicMetrics(state.session_id, state.round_number, client);
  const players = await getPublicDisplayPlayers(state, client);
  const viewer = await buildViewerContext(displayName, playerToken, state, client, options);
  const bingoRow = await getLatestBingoGameForSession(state.session_id, client);
  const revealFanfareKey = buildRevealFanfareKey(state);
  const correctGuessWinners = buildCorrectGuessWinners(players);
  const leaderboard = buildLeaderboardEntries(players);
  const unsubmittedPlayers = buildUnsubmittedPlayerNames(state, players);
  return {
    ...serializePublicState(state),
    ...metrics,
    players,
    viewer,
    bingo: bingoRow ? serializeBingoPublicState(bingoRow) : null,
    revealFanfareKey,
    correctGuessWinners,
    leaderboard,
    unsubmittedPlayers,
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
  await loadEventCodeBlocklist();
  await migrateEventExclusionsToGlobalBans();
  const totalWords = await countWords(pool);
  if (totalWords === 0) {
    await seedWordsTable(pool);
  }
}

function serializeState(row) {
  if (!row) return null;
  return {
    eventCode: row.event_code || DEFAULT_EVENT_CODE,
    joinCode: displayJoinCode(row.event_code || DEFAULT_EVENT_CODE),
    version: row.version,
    mode: row.mode,
    phase: row.phase,
    sessionId: row.session_id,
    roundNumber: row.round_number,
    currentWord: row.current_word,
    answerRevealed: row.answer_revealed,
    ballMultiplier: row.ball_multiplier,
    ballsRemaining: row.balls_remaining,
    guessWindowSeconds: configuredGuessWindowSeconds(row.guess_window_seconds),
    resultsWindowSeconds: configuredResultsWindowSeconds(row.results_window_seconds),
    hostNote: row.host_note,
    hostBroadcast: String(row.host_broadcast || ""),
    leaderboardVisible: Boolean(row.leaderboard_visible),
    awardAllBallsSeq: Number(row.award_all_balls_seq || 0),
    scrambleWord: String(row.scramble_word || ""),
    championDisplayName: getEffectiveChampion(row),
    firstSolverPlayerId: row.first_solver_player_id ? Number(row.first_solver_player_id) : null,
    wordSuggestions: parseWordListFromState(row.host_word_suggestions),
    wordExclusions: parseWordListFromState(row.host_word_exclusions),
    wordQueue: parseWordQueueFromState(row.host_word_queue),
    wordHistory: parseWordHistoryFromState(row.host_word_history),
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
    playSiteUrl: playPageUrl(state.eventCode),
    playSiteBaseUrl: `${getPlaySiteUrl()}/play`,
    joinPlayUrl: playPageUrl(state.eventCode),
    revealedWord: state.answerRevealed ? state.currentWord : "",
    currentWord: state.answerRevealed ? state.currentWord : "",
  };
}

async function getState(client = pool) {
  const eventCode = currentEventCode();
  const result = await client.query("select * from app_state where event_code = $1", [eventCode]);
  if (!result.rows[0]) {
    throw new Error(`Unknown join code "${eventCode}". Check the code on the venue screen.`);
  }
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
    JSON.stringify(parseWordQueueFromState(next.host_word_queue ?? state.host_word_queue)),
    JSON.stringify(parseWordHistoryFromState(next.host_word_history ?? state.host_word_history)),
    JSON.stringify(parseRoundBallStakesPreserveOrder(next)),
    patchOrState("all_players_submitted_at"),
    Number(next.guess_window_seq ?? state.guess_window_seq ?? 0),
    String(patchOrState("host_broadcast", "")),
    Boolean(patchOrState("leaderboard_visible", false)),
    Number(patchOrState("award_all_balls_seq", 0)),
    String(patchOrState("scramble_word", "")),
    currentEventCode(),
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
         host_word_queue = $21::jsonb,
         host_word_history = $22::jsonb,
         round_ball_stakes = $23::jsonb,
         all_players_submitted_at = $24,
         guess_window_seq = $25,
         host_broadcast = $26,
         leaderboard_visible = $27,
         award_all_balls_seq = $28,
         scramble_word = $29,
         updated_at = now()
     where event_code = $30
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

  // Opening window is 5 + 1 bonus (6). Strip the bonus after the first reveal;
  // stay at 5 until someone solves, then drop by 1 per solve down to 2.
  if (ballsRemaining === 6 * multiplier) {
    ballsRemaining = someoneNewlySolved
      ? 4 * multiplier
      : 5 * multiplier;
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
    Object.assign(patch, endRoundPatch(state));
  } else {
    patch.phase = "results";
  }

  return patch;
}

async function serializePublicDisplayPlayer(player, state, client = pool, context = {}) {
  const currentRound = Number(state.round_number || 0);
  const phase = String(state.phase || "idle");
  const windowSubmission = context.windowSubmission || null;
  const hasAnyRoundSubmission = Boolean(context.hasAnyRoundSubmission);
  const useWindowSubmission = (phase === "results" || phase === "ended") && windowSubmission;

  let submittedThisRound = Number(player.roundNumber || 0) === currentRound && !!player.currentGuess;
  let guess = submittedThisRound ? normalizeWordInput(player.currentGuess) : "";

  if (useWindowSubmission) {
    submittedThisRound = Boolean(windowSubmission.guess);
    guess = submittedThisRound ? normalizeWordInput(windowSubmission.guess) : "";
  }

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
  if (useWindowSubmission && windowSubmission.result_pattern) {
    resultPattern = String(windowSubmission.result_pattern);
    if (windowSubmission.result_label === "Not a word…") {
      guessIsLegal = false;
    }
  } else if (guess && guessIsLegal) {
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
      statusText = hasAnyRoundSubmission ? "Missed this guess" : "No guess this round";
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
    isWinner: (phase === "results" || phase === "ended") && (confirmedSolve || revealedPerfect),
    submissionCount: Number(player.submissionCount || 0),
    submittedAtIso: player.submittedAtIso,
    joinedAtIso: player.createdAtIso || player.updatedAtIso || null,
  };
}

async function loadDisplayPlayerSubmissionContext(state, client = pool) {
  const phase = String(state.phase || "idle");
  const round = Number(state.round_number || 0);
  const windowSeq = Number(state.guess_window_seq || 0);
  const windowSubmissions = new Map();
  const roundSubmissionCounts = new Map();

  if ((phase === "results" || phase === "ended") && round && windowSeq) {
    const result = await client.query(
      `select player_id, guess, result_pattern, result_label, guess_window_seq
       from guess_submissions
       where session_id = $1
         and round_number = $2`,
      [state.session_id, round],
    );
    for (const row of result.rows) {
      const playerId = Number(row.player_id);
      roundSubmissionCounts.set(playerId, (roundSubmissionCounts.get(playerId) || 0) + 1);
      if (Number(row.guess_window_seq || 0) === windowSeq) {
        windowSubmissions.set(playerId, row);
      }
    }
  }

  return { windowSubmissions, roundSubmissionCounts };
}

async function getPublicDisplayPlayers(state, client = pool) {
  const players = await listPlayers(state.session_id, client);
  const { windowSubmissions, roundSubmissionCounts } = await loadDisplayPlayerSubmissionContext(state, client);
  return Promise.all(players.map((player) => serializePublicDisplayPlayer(player, state, client, {
    windowSubmission: windowSubmissions.get(Number(player.id)) || null,
    hasAnyRoundSubmission: (roundSubmissionCounts.get(Number(player.id)) || 0) > 0,
  })));
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

function playPageUrl(eventCode = currentEventCode()) {
  return joinPlayUrl(`${getPlaySiteUrl()}/play`, eventCode);
}

app.use("/api", attachEventContext);

app.get("/api/play-qr", async (req, res) => {
  try {
    const url = playPageUrl(resolveEventCodeFromRequest(req));
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
    const authToken = normalizePlayerToken(req.query.authToken);
    res.json({
      ok: true,
      state: await buildPublicStatePayload(state, displayName, playerToken, pool, { authToken }),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/public/me", async (req, res) => {
  try {
    const authToken = normalizePlayerToken(req.query.authToken);
    const user = await getUserByAuthToken(authToken);
    if (!user) {
      res.status(401).json({ ok: false, error: "Not signed in." });
      return;
    }
    res.json({
      ok: true,
      user: serializeUserPublic(user),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/update-profile", async (req, res) => {
  const authToken = normalizePlayerToken(req.body.authToken);
  const profileDisplayName = validateProfileDisplayName(req.body.profileDisplayName);
  const email = String(req.body.email || "").trim().toLowerCase();
  try {
    const user = await getUserByAuthToken(authToken);
    if (!user) {
      throw new Error("Sign in to update your profile.");
    }
    const result = await pool.query(
      `update users
       set profile_display_name = $1,
           email = $2,
           email_verified = case when $2 = '' then false else email_verified end,
           updated_at = now()
       where id = $3
       returning *`,
      [profileDisplayName, email, user.id],
    );
    res.json({ ok: true, user: serializeUserPublic(result.rows[0]) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/change-password", async (req, res) => {
  const authToken = normalizePlayerToken(req.body.authToken);
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = validatePassword(req.body.newPassword);
  try {
    const user = await getUserByAuthToken(authToken);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      throw new Error("Current password is incorrect.");
    }
    await pool.query(
      `update users
       set password_hash = $1,
           updated_at = now()
       where id = $2`,
      [hashPassword(newPassword), user.id],
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/request-password-reset", async (req, res) => {
  const username = validateUsername(req.body.username);
  try {
    const result = await pool.query(
      `select id from users where normalized_username = $1`,
      [normalizedUsernameKey(username)],
    );
    const user = result.rows[0];
    if (!user) {
      res.json({ ok: true, message: "If that account exists, a reset token was created." });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);
    await pool.query(
      `update users
       set password_reset_token = $1,
           password_reset_expires_at = $2,
           updated_at = now()
       where id = $3`,
      [token, expiresAt, user.id],
    );
    res.json({
      ok: true,
      resetToken: token,
      expiresAtIso: expiresAt.toISOString(),
      message: "Use this reset token on the password reset form within one hour.",
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/reset-password", async (req, res) => {
  const token = String(req.body.resetToken || "").trim();
  const newPassword = validatePassword(req.body.newPassword);
  if (!token) {
    res.status(400).json({ ok: false, error: "Reset token is required." });
    return;
  }
  try {
    const result = await pool.query(
      `select *
       from users
       where password_reset_token = $1
         and password_reset_expires_at > now()`,
      [token],
    );
    const user = result.rows[0];
    if (!user) {
      throw new Error("Reset token is invalid or expired.");
    }
    await pool.query(
      `update users
       set password_hash = $1,
           password_reset_token = null,
           password_reset_expires_at = null,
           updated_at = now()
       where id = $2`,
      [hashPassword(newPassword), user.id],
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/request-email-verification", async (req, res) => {
  const authToken = normalizePlayerToken(req.body.authToken);
  try {
    const user = await getUserByAuthToken(authToken);
    if (!user) {
      throw new Error("Sign in first.");
    }
    const email = String(user.email || "").trim();
    if (!email) {
      throw new Error("Add an email address to your profile first.");
    }
    const token = crypto.randomBytes(16).toString("hex");
    res.json({
      ok: true,
      verificationToken: token,
      message: "Email delivery is not wired yet. Save this token for manual verification during beta.",
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/verify-email", async (req, res) => {
  const authToken = normalizePlayerToken(req.body.authToken);
  try {
    const user = await getUserByAuthToken(authToken);
    if (!user) {
      throw new Error("Sign in first.");
    }
    if (!String(user.email || "").trim()) {
      throw new Error("Add an email address to your profile first.");
    }
    const result = await pool.query(
      `update users
       set email_verified = true,
           updated_at = now()
       where id = $1
       returning *`,
      [user.id],
    );
    res.json({ ok: true, user: serializeUserPublic(result.rows[0]) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/register", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || "");
  try {
    const user = await createUserAccount(username, password);
    res.json({
      ok: true,
      user: serializeUserPublic(user),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/login", async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || "");
  try {
    const user = await loginUserAccount(username, password);
    const fullUser = await getUserByAuthToken(user.auth_token);
    res.json({
      ok: true,
      user: serializeUserPublic(fullUser),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/logout", async (req, res) => {
  const authToken = normalizePlayerToken(req.body.authToken);
  try {
    await logoutUserAccount(authToken);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/public/join", async (req, res) => {
  const authToken = normalizePlayerToken(req.body.authToken);
  const displayName = normalizeDisplayName(req.body.displayName);
  const playerToken = normalizePlayerToken(req.body.playerToken);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const state = await getState(client);
    let player;
    if (authToken) {
      const user = await getUserByAuthToken(authToken, client);
      if (!user) {
        throw new Error("Sign in to join the game.");
      }
      player = await upsertLobbyPlayerForUser(state.session_id, user, client);
    } else {
      if (!displayName) {
        throw new Error("Enter a display name or sign in to join the game.");
      }
      if (displayName.length > 40) {
        throw new Error("User name must be 40 characters or fewer.");
      }
      player = await upsertLobbyPlayer(state.session_id, displayName, playerToken, client);
    }
    await client.query("commit");

    const nextState = await maybeAdvanceTimedPhase();
    const identity = serializePlayerIdentity(player);
    res.json({
      ok: true,
      player: identity,
      publicState: await buildPublicStatePayload(
        nextState,
        identity.displayName,
        identity.playerToken,
        pool,
        { authToken },
      ),
    });
  } catch (error) {
    await client.query("rollback");
    res.status(400).json({ ok: false, error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/public/host-message", async (req, res) => {
  const playerToken = normalizePlayerToken(req.body.playerToken);
  const authToken = normalizePlayerToken(req.body.authToken);
  const message = String(req.body.message || "").trim();
  if (!playerToken && !authToken) {
    res.status(400).json({ ok: false, error: "Sign in and join the game first." });
    return;
  }
  if (!message) {
    res.status(400).json({ ok: false, error: "Message is required." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const state = await getState(client);
    let player;
    if (authToken) {
      ({ row: player } = await resolvePlayerForAuth(state.session_id, authToken, client));
    } else {
      player = await getPlayerByToken(state.session_id, playerToken, client);
      if (!player) {
        throw new Error("Join the game on this device before messaging the host.");
      }
    }
    await insertHostMessage(state.session_id, player.display_name, message, client);
    await client.query("commit");
    res.json({ ok: true });
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
  const authToken = normalizePlayerToken(req.body.authToken);
  if (!playerToken && !authToken) {
    res.status(400).json({ ok: false, error: "Sign in to leave the game." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const state = await getState(client);
    let player;
    if (authToken) {
      ({ row: player } = await resolvePlayerForAuth(state.session_id, authToken, client));
    } else {
      player = await getPlayerByToken(state.session_id, playerToken, client);
      if (!player) {
        throw new Error("Player session not found. Re-join the game.");
      }
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
      publicState: await buildPublicStatePayload(nextState, displayName, "", pool, { authToken }),
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
  const authToken = normalizePlayerToken(req.body.authToken);
  const guess = normalizeWordInput(req.body.guess);

  if (!playerToken && !authToken) {
    res.status(400).json({ ok: false, error: "Sign in and join the game first." });
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

    const playerRow = authToken
      ? (await resolvePlayerForAuth(state.session_id, authToken, client)).row
      : await getPlayerByToken(state.session_id, playerToken, client);
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
        pool,
        { authToken },
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
    const players = await getPublicDisplayPlayers(state);
    const serialized = await enrichStateWithWordPool(serializeState(state));
    const bingoRow = await getLatestBingoGameForSession(state.session_id);
    res.json({
      ok: true,
      state: {
        ...serialized,
        revealFanfareKey: buildRevealFanfareKey(state),
        correctGuessWinners: buildCorrectGuessWinners(players),
        hostMessages: await listHostMessages(state.session_id),
        leaderboard: buildLeaderboardEntries(players),
        unsubmittedPlayers: buildUnsubmittedPlayerNames(state, players),
        bingo: bingoRow ? serializeBingoPublicState(bingoRow) : null,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/players", requireAdmin, async (_req, res) => {
  try {
    const state = await getState();
    const players = await listPlayers(state.session_id);
    const bingoRow = state.mode === "bingo"
      ? await getLatestBingoGameForSession(state.session_id)
      : null;
    const playersWithHistory = await Promise.all(players.map(async (player) => ({
      ...player,
      guessHistory: await listViewerGuessHistory(player.id, state, pool, { hostMode: true }),
      bingo: bingoRow
        ? computeBingoPlayerStatus({
          display_name: player.displayName,
          balls: player.balls,
        }, bingoRow)
        : null,
    })));
    const bingoStatuses = playersWithHistory
      .map((player) => player.bingo)
      .filter(Boolean);
    res.json({
      ok: true,
      state: {
        session: serializeState(state),
        players: playersWithHistory,
        bingo: bingoRow ? {
          ...serializeBingoPublicState(bingoRow),
          summary: summarizeBingoPlayerStatuses(bingoStatuses),
        } : null,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function handleAdminAction(action, body) {
  if (action === "create-event") {
    let code = "";
    if (body.eventCode) {
      code = await validateEventCode(pool, body.eventCode, { allowDefault: false });
    } else {
      code = await pickRandomEventCode(pool);
    }
    return serializeState(await createEventRow(code));
  }

  const state = await getState();
  const word = normalizeWordInput(body.word);

  switch (action) {
    case "state":
      return serializeState(state);
    case "create-session": {
      const wordPool = await resetHostWordPool(state);
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
        guess_window_seconds: DEFAULT_GUESS_WINDOW_SECONDS,
        results_window_seconds: DEFAULT_RESULTS_WINDOW_SECONDS,
        host_note: "",
        guess_window_opened_at: null,
        results_window_opened_at: null,
        first_solver_player_id: null,
        timer_paused: false,
        timer_paused_remaining_seconds: null,
        round_ball_stakes: [],
        guess_window_seq: 0,
        all_players_submitted_at: null,
        host_broadcast: "",
        leaderboard_visible: false,
        award_all_balls_seq: 0,
        scramble_word: pickScrambleWord(),
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
      const queueAdvance = wordQueueAdvancePatchForStartRound(state);
      const stateAfterQueue = { ...state, ...queueAdvance };
      let activeWord = normalizeWordInput(stateAfterQueue.current_word);
      if (!activeWord) {
        const queue = parseWordQueueFromState(stateAfterQueue.host_word_queue);
        activeWord = queue[0] || "";
      }
      if (!activeWord) {
        throw new Error("Set a 5-letter word or add words to the queue before starting a round.");
      }
      const nextRound = Number(state.round_number || 0) + 1;
      const multiplier = Number(state.ball_multiplier || 1);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const openingStake = 6 * multiplier;
        const startPatch = {
          ...queueAdvance,
          mode: "lingo",
          phase: "guessing",
          round_number: nextRound,
          answer_revealed: false,
          balls_remaining: openingStake,
          guess_window_seq: 1,
          round_ball_stakes: [openingStake],
          ...(nextRound > 1 || state.phase === "idle" ? { host_broadcast: "" } : {}),
          guess_window_seconds: normalizedGuessWindowSeconds(
            body.guessWindowSeconds,
            state.guess_window_seconds,
          ),
          results_window_seconds: normalizedResultsWindowSeconds(
            body.resultsWindowSeconds,
            state.results_window_seconds,
          ),
          guess_window_opened_at: windowOpenedAtIso(),
          first_solver_player_id: null,
          ...clearTimerPausePatch(),
          ...clearAllSubmittedGracePatch(),
        };
        if (!normalizeWordInput(stateAfterQueue.current_word)) {
          startPatch.current_word = activeWord;
        }
        const nextState = await updateState(startPatch, client);
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
          normalizedGuessWindowSeconds(body.guessWindowSeconds, state.guess_window_seconds),
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
    case "set-timers": {
      return serializeState(await updateState({
        guess_window_seconds: normalizedGuessWindowSeconds(body.guessWindowSeconds),
        results_window_seconds: normalizedResultsWindowSeconds(body.resultsWindowSeconds),
      }));
    }
    case "refresh-word-suggestions": {
      const exclusions = await hostWordPoolExclusions(state);
      const exclusionSet = new Set(exclusions);
      const count = Math.max(1, Number(body.count) || HOST_WORD_SUGGESTION_COUNT);
      const suggestions = (await buildHostWordSuggestions(exclusions, count))
        .filter((word) => !exclusionSet.has(word));
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
      await addGlobalHostWordBan(excludedWord);
      const suggestions = parseWordListFromState(state.host_word_suggestions)
        .filter((item) => item !== excludedWord);
      return serializeState(await updateState({
        host_word_suggestions: suggestions,
      }));
    }
    case "unexclude-word": {
      const restoredWord = normalizeWordInput(body.word);
      if (!isFiveLetterWord(restoredWord)) {
        throw new Error("Word must be exactly 5 letters.");
      }
      await removeGlobalHostWordBan(restoredWord);
      return serializeState(await getState());
    }
    case "add-to-word-queue": {
      const word = normalizeWordInput(body.word);
      if (!isFiveLetterWord(word)) {
        throw new Error("Word must be exactly 5 letters.");
      }
      if (!(await isLegalWord(pool, word))) {
        throw new Error("Word must be a legal 5-letter Scrabble word.");
      }
      const queue = parseWordQueueFromState(state.host_word_queue);
      if (queue.length >= HOST_WORD_QUEUE_MAX) {
        throw new Error(`Queue holds up to ${HOST_WORD_QUEUE_MAX} words.`);
      }
      if (queue.includes(word)) {
        throw new Error("Word is already in the queue.");
      }
      const history = parseWordHistoryFromState(state.host_word_history);
      if (history.includes(word)) {
        throw new Error("Word was already played this session.");
      }
      queue.push(word);
      const patch = { host_word_queue: queue };
      if (!normalizeWordInput(state.current_word) && queue.length === 1) {
        patch.current_word = word;
      }
      return serializeState(await updateState(patch));
    }
    case "remove-from-word-queue": {
      const word = normalizeWordInput(body.word);
      const queue = parseWordQueueFromState(state.host_word_queue).filter((item) => item !== word);
      const patch = { host_word_queue: queue };
      if (normalizeWordInput(state.current_word) === word) {
        patch.current_word = queue[0] || "";
      }
      return serializeState(await updateState(patch));
    }
    case "set-word-queue": {
      const patch = await applyWordQueuePatch(state, body.words || []);
      return serializeState(await updateState(patch));
    }
    case "load-word-set": {
      const set = await loadWordSetById(body.setId);
      if (!set.words.length) {
        throw new Error(`Word set "${set.name}" is empty.`);
      }
      const patch = await applyWordQueuePatch(state, set.words);
      return serializeState(await updateState(patch));
    }
    case "set-champion":
      return serializeState(await updateState({
        champion_display_name: normalizeDisplayName(body.championDisplayName),
      }));
    case "set-host-note":
      return serializeState(await updateState({
        host_note: String(body.hostNote || ""),
      }));
    case "set-host-broadcast":
      return serializeState(await updateState({
        host_broadcast: String(body.hostBroadcast || "").trim().slice(0, HOST_BROADCAST_MAX_LENGTH),
      }));
    case "set-leaderboard-visible":
      return serializeState(await updateState({
        leaderboard_visible: Boolean(body.visible),
      }));
    case "regenerate-scramble-word":
      return serializeState(await updateState({
        scramble_word: pickScrambleWord(),
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
    case "award-all-balls": {
      await pool.query(
        `update players
         set balls = balls + 1,
             updated_at = now()
         where session_id = $1`,
        [state.session_id],
      );
      return serializeState(await updateState({
        award_all_balls_seq: Number(state.award_all_balls_seq || 0) + 1,
      }));
    }
    case "toggle-timer-pause": {
      if (state.phase !== "guessing" && state.phase !== "results") {
        throw new Error("Timer can only be paused during guessing or results.");
      }
      if (state.timer_paused) {
        const remaining = Math.max(0, Number(state.timer_paused_remaining_seconds || 0));
        if (state.phase === "guessing") {
          const guessWindowSeconds = configuredGuessWindowSeconds(state.guess_window_seconds);
          return serializeState(await updateState({
            ...clearTimerPausePatch(),
            guess_window_seconds: guessWindowSeconds,
            guess_window_opened_at: windowOpenedAtForRemaining(guessWindowSeconds, remaining),
          }));
        }
        const resultsWindowSeconds = configuredResultsWindowSeconds(state.results_window_seconds);
        return serializeState(await updateState({
          ...clearTimerPausePatch(),
          results_window_seconds: resultsWindowSeconds,
          results_window_opened_at: windowOpenedAtForRemaining(resultsWindowSeconds, remaining),
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
        ...endRoundPatch(state),
        ...clearTimerPausePatch(),
      }));
    case "dismiss-host-message": {
      const messageId = Number(body.messageId);
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error("messageId is required.");
      }
      await dismissHostMessage(state.session_id, messageId);
      const nextState = await getState();
      const players = await getPublicDisplayPlayers(nextState);
      return {
        ...serializeState(nextState),
        revealFanfareKey: buildRevealFanfareKey(nextState),
        correctGuessWinners: buildCorrectGuessWinners(players),
        hostMessages: await listHostMessages(nextState.session_id),
      };
    }
    case "reset-round": {
      if (state.phase === "idle" && Number(state.round_number || 0) === 0) {
        throw new Error("No active round to reset.");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await clearSessionGuesses(state.session_id, client);
        await resetWordProgress(state.session_id, client);
        await client.query(
          `delete from guess_submissions
           where session_id = $1`,
          [state.session_id],
        );
        const nextState = await updateState({
          mode: "lingo",
          phase: "idle",
          round_number: 0,
          current_word: "",
          answer_revealed: false,
          balls_remaining: 0,
          guess_window_opened_at: null,
          results_window_opened_at: null,
          first_solver_player_id: null,
          round_ball_stakes: [],
          guess_window_seq: 0,
          all_players_submitted_at: null,
          ...clearTimerPausePatch(),
        }, client);
        await client.query("commit");
        return serializeState(nextState);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    case "reset-session": {
      const wordPool = await resetHostWordPool(state);
      await clearSessionPlayers(state.session_id);
      await pool.query(`delete from host_messages where session_id = $1`, [state.session_id]);
      return serializeState(await updateState({
        mode: "lingo",
        phase: "idle",
        round_number: 0,
        current_word: "",
        answer_revealed: false,
        ball_multiplier: 1,
        balls_remaining: 0,
        guess_window_seconds: DEFAULT_GUESS_WINDOW_SECONDS,
        results_window_seconds: DEFAULT_RESULTS_WINDOW_SECONDS,
        host_note: "",
        guess_window_opened_at: null,
        results_window_opened_at: null,
        first_solver_player_id: null,
        timer_paused: false,
        timer_paused_remaining_seconds: null,
        round_ball_stakes: [],
        guess_window_seq: 0,
        all_players_submitted_at: null,
        host_broadcast: "",
        leaderboard_visible: false,
        award_all_balls_seq: 0,
        scramble_word: pickScrambleWord(),
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
              guess_window_seconds: normalizedGuessWindowSeconds(
                body.guessWindowSeconds,
                state.guess_window_seconds,
              ),
              results_window_seconds: normalizedResultsWindowSeconds(
                body.resultsWindowSeconds,
                state.results_window_seconds,
              ),
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

function serializeBingoPublicState(row) {
  const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
  const callIndex = Number(row.call_index ?? -1);
  const current = callIndex >= 0 ? callSheet[callIndex] : null;
  const called = callIndex >= 0 ? callSheet.slice(0, callIndex + 1) : [];
  return {
    gameId: row.id,
    callIndex,
    callsMade: callsMade(callIndex),
    lastCall: current?.label || null,
    called: called.map((entry) => entry.label),
    calledNumbers: called.map((entry) => entry.number),
    winnerDisplayName: row.winner_display_name || "",
    hasWinner: Boolean(row.winner_display_name),
    totalCalls: callSheet.length,
  };
}

async function getBingoGameRow(gameId, client = pool) {
  const result = await client.query(
    `select *
     from bingo_games
     where id = $1`,
    [String(gameId || "").trim()],
  );
  return result.rows[0] || null;
}

async function startBingoGameForSession(sessionId, client = pool) {
  const gameId = createGameId();
  const callSheet = generateCallSheet(gameId);
  await client.query(
    `insert into bingo_games (id, session_id, call_sheet, call_index, winner_display_name)
     values ($1, $2, $3::jsonb, -1, '')`,
    [gameId, sessionId, JSON.stringify(callSheet)],
  );
  return getBingoGameRow(gameId, client);
}

async function advanceBingoGame(gameId, action, client = pool) {
  const row = await getBingoGameRow(gameId, client);
  if (!row) {
    throw new Error("Bingo game not found.");
  }
  if (row.winner_display_name) {
    throw new Error("This bingo game already has a winner.");
  }

  const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
  let callIndex = Number(row.call_index ?? -1);

  if (action === "next") {
    if (callIndex >= callSheet.length - 1) {
      throw new Error("All balls have already been called.");
    }
    callIndex += 1;
  } else if (action === "prev") {
    if (callIndex < 0) {
      throw new Error("No calls to undo yet.");
    }
    callIndex -= 1;
  } else if (action === "reset") {
    callIndex = -1;
  } else {
    throw new Error("Unknown bingo call action.");
  }

  const updated = await client.query(
    `update bingo_games
     set call_index = $1,
         updated_at = now()
     where id = $2
     returning *`,
    [callIndex, gameId],
  );
  return updated.rows[0];
}

app.post("/api/admin/bingo/start", requireAdmin, async (_req, res) => {
  try {
    const state = await getState();
    const row = await startBingoGameForSession(state.session_id);
    await updateState({ mode: "bingo" });
    const publicState = serializeBingoPublicState(row);
    const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
    res.json({
      ok: true,
      bingo: {
        ...publicState,
        callOrder: callSheet.map((entry) => entry.label),
      },
      playerUrl: `${getPlaySiteUrl()}/bingo?game=${encodeURIComponent(publicState.gameId)}`,
      hostCallsUrl: `${getPlaySiteUrl()}/bingo/calls?game=${encodeURIComponent(publicState.gameId)}`,
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/bingo/advance", requireAdmin, async (req, res) => {
  try {
    const gameId = String(req.body.gameId || "").trim();
    const action = String(req.body.action || "next").trim();
    if (!gameId) {
      throw new Error("gameId is required.");
    }
    const row = await advanceBingoGame(gameId, action);
    const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
    res.json({
      ok: true,
      bingo: {
        ...serializeBingoPublicState(row),
        callOrder: callSheet.map((entry) => entry.label),
      },
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/bingo/state", requireAdmin, async (req, res) => {
  try {
    const gameId = String(req.query.game || req.query.gameId || "").trim();
    if (!gameId) {
      throw new Error("game is required.");
    }
    const row = await getBingoGameRow(gameId);
    if (!row) {
      res.status(404).json({ ok: false, error: "Bingo game not found." });
      return;
    }
    const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
    res.json({
      ok: true,
      bingo: {
        ...serializeBingoPublicState(row),
        callOrder: callSheet.map((entry) => entry.label),
      },
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/bingo/state", async (req, res) => {
  try {
    const gameId = String(req.query.game || req.query.gameId || "").trim();
    if (!gameId) {
      res.status(400).json({ ok: false, error: "game is required." });
      return;
    }
    const row = await getBingoGameRow(gameId);
    if (!row) {
      res.status(404).json({ ok: false, error: "Bingo game not found." });
      return;
    }
    res.json({ ok: true, bingo: serializeBingoPublicState(row) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/bingo/end", requireAdmin, async (_req, res) => {
  try {
    const state = await getState();
    const nextState = await updateState({
      mode: "lingo",
      phase: "idle",
      host_broadcast: "",
    });
    res.json({
      ok: true,
      state: serializeState(nextState),
      bingo: state.mode === "bingo"
        ? serializeBingoPublicState(await getLatestBingoGameForSession(state.session_id))
        : null,
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/word-sets", requireAdmin, async (_req, res) => {
  try {
    const sets = await listWordSets();
    res.json({ ok: true, sets });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/bingo/players", requireAdmin, async (req, res) => {
  try {
    const state = await getState();
    const gameId = String(req.query.game || req.query.gameId || "").trim();
    const bingoRow = gameId
      ? await getBingoGameRow(gameId)
      : await getLatestBingoGameForSession(state.session_id);
    if (!bingoRow) {
      res.status(404).json({ ok: false, error: "No active bingo game found." });
      return;
    }
    const players = await listBingoPlayerStatuses(state.session_id, bingoRow);
    const statuses = players.map((player) => player.bingo).filter(Boolean);
    res.json({
      ok: true,
      bingo: serializeBingoPublicState(bingoRow),
      summary: summarizeBingoPlayerStatuses(statuses),
      players,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/bingo/player-state", async (req, res) => {
  try {
    const gameId = String(req.query.game || req.query.gameId || "").trim();
    const playerToken = normalizePlayerToken(req.query.playerToken);
    if (!gameId || !playerToken) {
      res.status(400).json({ ok: false, error: "game and playerToken are required." });
      return;
    }

    const row = await getBingoGameRow(gameId);
    if (!row) {
      res.status(404).json({ ok: false, error: "Bingo game not found." });
      return;
    }

    const playerRow = await getPlayerByToken(row.session_id, playerToken);
    if (!playerRow) {
      res.status(404).json({ ok: false, error: "Join the TYPEO game on this device first." });
      return;
    }

    const publicState = serializeBingoPublicState(row);
    const ballsEarned = Number(playerRow.balls || 0);
    const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
    const callIndex = Number(row.call_index ?? -1);
    const { grid } = generateBingoCard(gameId, playerRow.display_name);
    const called = calledNumbersFromSheet(callSheet, callIndex);
    const hasLine = hasBingoLine(grid, called);
    const made = callsMade(callIndex);
    const earnedBingoInBudget = bingoAchievedWithinBudget(
      callSheet,
      callIndex,
      ballsEarned,
      grid,
    );
    const isWinner = Boolean(row.winner_display_name)
      && String(row.winner_display_name).toLowerCase()
        === String(playerRow.display_name).toLowerCase();

    res.json({
      ok: true,
      bingo: publicState,
      player: {
        displayName: playerRow.display_name,
        ballsEarned,
        callsMade: made,
        hasLine,
        earnedBingoInBudget,
        canClaim: earnedBingoInBudget && !publicState.hasWinner,
        isWinner,
        budgetRemaining: Math.max(0, ballsEarned - made),
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/bingo/claim", async (req, res) => {
  const gameId = String(req.body.gameId || req.body.game || "").trim();
  const playerToken = normalizePlayerToken(req.body.playerToken);
  if (!gameId || !playerToken) {
    res.status(400).json({ ok: false, error: "gameId and playerToken are required." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const locked = await client.query(
      `select *
       from bingo_games
       where id = $1
       for update`,
      [gameId],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new Error("Bingo game not found.");
    }
    if (row.winner_display_name) {
      throw new Error(`${row.winner_display_name} already won this bingo game.`);
    }

    const playerRow = await getPlayerByToken(row.session_id, playerToken, client);
    if (!playerRow) {
      throw new Error("Join the TYPEO game on this device first.");
    }

    const callSheet = Array.isArray(row.call_sheet) ? row.call_sheet : [];
    const callIndex = Number(row.call_index ?? -1);
    const evaluation = evaluateBingoClaim({
      gameId,
      displayName: playerRow.display_name,
      callSheet,
      callIndex,
      ballsEarned: playerRow.balls,
    });
    if (!evaluation.ok) {
      throw new Error(evaluation.error);
    }

    const updated = await client.query(
      `update bingo_games
       set winner_player_id = $1,
           winner_display_name = $2,
           updated_at = now()
       where id = $3
       returning *`,
      [playerRow.id, playerRow.display_name, gameId],
    );

    await client.query("commit");
    res.json({
      ok: true,
      winner: playerRow.display_name,
      bingo: serializeBingoPublicState(updated.rows[0]),
    });
  } catch (error) {
    await client.query("rollback");
    res.status(400).json({ ok: false, error: error.message });
  } finally {
    client.release();
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
  const joinMatch = req.path.match(/^\/join\/([a-z]{5})$/i);
  if (joinMatch) {
    res.redirect(302, `/play?join=${encodeURIComponent(joinMatch[1].toLowerCase())}`);
    return;
  }
  const fileName = req.path === "/"
    ? "lobby.html"
    : req.path === "/play"
      ? "index.html"
      : req.path === "/host"
        ? "host.html"
        : req.path === "/display"
          ? "display.html"
          : req.path === "/rules"
            ? "rules.html"
            : req.path === "/rehearsal"
            ? "rehearsal.html"
            : req.path === "/bingo" || req.path === "/bingo.html"
              ? "bingo.html"
              : req.path === "/bingo/calls" || req.path === "/bingo-calls.html"
                ? "bingo-calls.html"
                : "index.html";
  res.sendFile(path.join(staticDir, fileName));
});

async function advanceAllTimedPhases() {
  const result = await pool.query("select event_code from app_state");
  for (const row of result.rows) {
    await runWithEventCode(row.event_code, () => maybeAdvanceTimedPhase());
  }
}

function startBackgroundTimers() {
  timerTickHandle = setInterval(() => {
    if (shuttingDown || !appReady) return;
    advanceAllTimedPhases().catch((error) => {
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
      let state = await getState();
      state = await maybeExpireAbandonedSession(state, pool, { forceIfEmpty: true });
      const eventCount = await pool.query("select count(*)::int as count from app_state");
      const totalWords = await countWords(pool);
      appReady = true;
      console.log(
        `TYPEO online app ready. Event: ${state.event_code}. Sessions: ${eventCount.rows[0]?.count || 0}. Words: ${totalWords}`,
      );
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

  httpServer = app.listen(port, "0.0.0.0", () => {
    console.log(`Listening on http://0.0.0.0:${port}`);
  });

  await bootstrapWithRetry();
  startBackgroundTimers();
}

startServer().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
