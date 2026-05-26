const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");

admin.initializeApp();

const db = admin.firestore();
const adminKey = defineSecret("LINGO_ADMIN_KEY");

const SESSION_COLLECTION = "onlineGameState";
const SESSION_DOC = "current";
const PLAYER_COLLECTION = "onlinePlayers";

function sessionRef() {
  return db.collection(SESSION_COLLECTION).doc(SESSION_DOC);
}

function playersCollection() {
  return db.collection(PLAYER_COLLECTION);
}

function nowIso() {
  return new Date().toISOString();
}

function buildEmptySession() {
  return {
    version: 1,
    mode: "lingo",
    phase: "idle",
    sessionId: `${Date.now()}`,
    roundNumber: 0,
    currentWord: "",
    answerRevealed: false,
    ballMultiplier: 1,
    ballsRemaining: 0,
    guessWindowSeconds: 90,
    resultsWindowSeconds: 45,
    hostNote: "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAtIso: nowIso(),
  };
}

function buildSerializableEmptySession() {
  return {
    ...buildEmptySession(),
    updatedAt: null,
  };
}

async function getSessionSnapshot() {
  const ref = sessionRef();
  const snapshot = await ref.get();
  if (snapshot.exists) {
    return { ref, data: snapshot.data() };
  }

  const empty = buildEmptySession();
  await ref.set(empty);
  return { ref, data: buildSerializableEmptySession() };
}

async function mergeSession(patch) {
  const { ref, data } = await getSessionSnapshot();
  const next = {
    ...data,
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAtIso: nowIso(),
  };
  await ref.set(next, { merge: true });
  const saved = await ref.get();
  return saved.data();
}

function requireAdmin(req) {
  const provided = req.get("x-lingo-admin-key") || "";
  const expected = adminKey.value();
  return Boolean(provided) && provided === expected;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function normalizeDisplayName(displayName) {
  return String(displayName || "").trim();
}

function safePlayerKey(displayName) {
  return normalizeDisplayName(displayName).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase() || "player";
}

function playerDocId(sessionId, displayName) {
  return `${sessionId}_${safePlayerKey(displayName)}`;
}

function sanitizeForPublic(data) {
  if (!data) return buildSerializableEmptySession();
  const {
    currentWord,
    ...rest
  } = data;

  const publicFirstLetter = currentWord ? `${currentWord.charAt(0).toUpperCase()}....` : "";
  return {
    ...rest,
    publicFirstLetter,
    revealedWord: data.answerRevealed ? currentWord : "",
  };
}

async function listPlayersForSession(sessionId) {
  if (!sessionId) return [];
  const snapshot = await playersCollection().where("sessionId", "==", sessionId).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
}

async function submitGuess(body) {
  const displayName = normalizeDisplayName(body.displayName);
  const guess = String(body.guess || "").trim().toUpperCase();

  if (!displayName) {
    throw new Error("Display name is required.");
  }
  if (!/^[A-Z]{5}$/.test(guess)) {
    throw new Error("Guess must be exactly 5 letters.");
  }

  const { data } = await getSessionSnapshot();
  if (!data.sessionId) {
    throw new Error("No active session.");
  }
  if (data.phase !== "guessing") {
    throw new Error("Guesses are only accepted during the guessing phase.");
  }
  if (!data.currentWord) {
    throw new Error("The host has not set a word yet.");
  }

  const ref = playersCollection().doc(playerDocId(data.sessionId, displayName));
  const playerState = {
    sessionId: data.sessionId,
    roundNumber: Number(data.roundNumber || 0),
    displayName,
    normalizedDisplayName: safePlayerKey(displayName),
    currentGuess: guess,
    guessLength: guess.length,
    firstLetter: data.currentWord.charAt(0).toUpperCase(),
    submittedAtIso: nowIso(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAtIso: nowIso(),
  };

  await ref.set(playerState, { merge: true });
  return {
    accepted: true,
    player: playerState,
    publicState: sanitizeForPublic(data),
  };
}

async function handleAdminAction(action, body) {
  const {
    word = "",
    guessWindowSeconds,
    resultsWindowSeconds,
    hostNote = "",
  } = body;

  const normalizedWord = String(word || "").trim().toUpperCase();

  switch (action) {
    case "state": {
      const { data } = await getSessionSnapshot();
      return data;
    }
    case "players": {
      const { data } = await getSessionSnapshot();
      const players = await listPlayersForSession(data.sessionId);
      return {
        session: data,
        players,
      };
    }
    case "create-session":
      return mergeSession(buildEmptySession());
    case "set-word": {
      if (normalizedWord && !/^[A-Z]{5}$/.test(normalizedWord)) {
        throw new Error("Word must be exactly 5 letters.");
      }
      return mergeSession({
        currentWord: normalizedWord,
        answerRevealed: false,
        hostNote,
      });
    }
    case "start-round": {
      const { data } = await getSessionSnapshot();
      if (!data.currentWord) {
        throw new Error("Set a 5-letter word before starting a round.");
      }
      const nextRound = Number(data.roundNumber || 0) + 1;
      const multiplier = Number(data.ballMultiplier || 1);
      return mergeSession({
        phase: "guessing",
        roundNumber: nextRound,
        answerRevealed: false,
        ballsRemaining: 6 * multiplier,
        guessWindowSeconds: Number(guessWindowSeconds || data.guessWindowSeconds || 90),
        resultsWindowSeconds: Number(resultsWindowSeconds || data.resultsWindowSeconds || 45),
        guessWindowOpenedAtIso: nowIso(),
      });
    }
    case "reveal-results":
      return mergeSession({
        phase: "results",
        resultsWindowOpenedAtIso: nowIso(),
      });
    case "continue-round": {
      const { data } = await getSessionSnapshot();
      return mergeSession({
        phase: "guessing",
        guessWindowOpenedAtIso: nowIso(),
        guessWindowSeconds: Number(guessWindowSeconds || data.guessWindowSeconds || 90),
      });
    }
    case "toggle-double-balls": {
      const { data } = await getSessionSnapshot();
      const multiplier = Number(data.ballMultiplier || 1) === 2 ? 1 : 2;
      return mergeSession({
        ballMultiplier: multiplier,
      });
    }
    case "set-balls": {
      const nextBalls = Number(body.ballsRemaining);
      if (!Number.isFinite(nextBalls) || nextBalls < 0) {
        throw new Error("ballsRemaining must be a non-negative number.");
      }
      return mergeSession({
        ballsRemaining: nextBalls,
      });
    }
    case "reveal-answer":
      return mergeSession({
        answerRevealed: true,
        phase: "ended",
      });
    case "reset-session":
      return mergeSession(buildEmptySession());
    default:
      throw new Error(`Unknown admin action: ${action}`);
  }
}

exports.hostApi = onRequest(
  {
    cors: true,
    secrets: [adminKey],
  },
  async (req, res) => {
    try {
      const route = (req.path || req.originalUrl || req.url || "").split("?")[0].replace(/^\/+/, "");

      if (req.method === "GET" && route === "api/public-state") {
        const { data } = await getSessionSnapshot();
        res.json({ ok: true, state: sanitizeForPublic(data) });
        return;
      }

      if (req.method === "POST" && route === "api/public/submit-guess") {
        const body = parseBody(req);
        const result = await submitGuess(body);
        res.json({ ok: true, ...result });
        return;
      }

      if (!route.startsWith("api/admin/")) {
        res.status(404).json({ ok: false, error: "Not found." });
        return;
      }

      if (!requireAdmin(req)) {
        res.status(401).json({ ok: false, error: "Invalid admin key." });
        return;
      }

      const action = route.replace("api/admin/", "");
      const body = parseBody(req);
      const state = await handleAdminAction(action, body);
      res.json({ ok: true, state });
    } catch (error) {
      logger.error("hostApi failed", error);
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error.",
      });
    }
  }
);
