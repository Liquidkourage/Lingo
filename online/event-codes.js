const fs = require("fs/promises");
const path = require("path");

const { isFiveLetterWord, isLegalWord, normalizeWordInput } = require("./words");

const blocklistFilePath = path.join(__dirname, "data", "event-code-blocklist.txt");
const DEFAULT_EVENT_CODE = "default";

const RESERVED_EVENT_CODES = new Set([
  DEFAULT_EVENT_CODE,
  "admin",
  "api",
  "bingo",
  "display",
  "health",
  "host",
  "join",
  "lobby",
  "play",
  "rehearsal",
  "rules",
]);

const INLINE_BLOCKED_EVENT_CODES = new Set([
  "admin",
  "bingo",
  "hosts",
  "plays",
  "rules",
  "words",
]);

let blockedEventCodes = new Set([...INLINE_BLOCKED_EVENT_CODES]);

function normalizeEventCodeInput(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!code) {
    return DEFAULT_EVENT_CODE;
  }
  return code;
}

function isDefaultEventCode(code) {
  return normalizeEventCodeInput(code) === DEFAULT_EVENT_CODE;
}

function isEventCodeFormat(code) {
  const normalized = normalizeEventCodeInput(code);
  if (normalized === DEFAULT_EVENT_CODE) {
    return true;
  }
  return /^[a-z]{5}$/.test(normalized);
}

function formatEventCode(code) {
  const normalized = normalizeEventCodeInput(code);
  if (normalized === DEFAULT_EVENT_CODE) {
    return normalized;
  }
  if (!/^[a-z]{5}$/.test(normalized)) {
    throw new Error("Join code must be exactly 5 letters.");
  }
  return normalized;
}

function isBlockedEventCode(code) {
  return blockedEventCodes.has(normalizeEventCodeInput(code));
}

function isReservedEventCode(code) {
  return RESERVED_EVENT_CODES.has(normalizeEventCodeInput(code));
}

async function loadEventCodeBlocklist(filePath = blocklistFilePath) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    for (const line of String(contents || "").split(/\r?\n/)) {
      const word = normalizeEventCodeInput(line);
      if (/^[a-z]{5}$/.test(word)) {
        blockedEventCodes.add(word);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  blockedEventCodes = new Set([
    ...blockedEventCodes,
    ...INLINE_BLOCKED_EVENT_CODES,
  ]);
}

async function validateEventCode(db, code, options = {}) {
  const normalized = formatEventCode(code);
  if (normalized === DEFAULT_EVENT_CODE) {
    if (options.allowDefault === false) {
      throw new Error("Pick a 5-letter join code from the dictionary.");
    }
    return normalized;
  }

  const word = normalizeWordInput(normalized);
  if (!isFiveLetterWord(word)) {
    throw new Error("Join code must be exactly 5 letters.");
  }
  if (isReservedEventCode(normalized)) {
    throw new Error("That join code is reserved. Pick another word.");
  }
  if (isBlockedEventCode(normalized)) {
    throw new Error("That word cannot be used as a join code. Pick another.");
  }
  if (!(await isLegalWord(db, word))) {
    throw new Error("Join code must be a legal 5-letter dictionary word.");
  }
  return normalized;
}

async function pickRandomEventCode(db, client = db) {
  const used = await client.query("select lower(event_code) as event_code from app_state");
  const exclude = new Set([
    ...blockedEventCodes,
    ...RESERVED_EVENT_CODES,
    ...used.rows.map((row) => String(row.event_code || "").trim().toLowerCase()).filter(Boolean),
  ]);

  const result = await client.query(
    `select word
     from words
     where not (lower(word) = any($1::text[]))
     order by random()
     limit 1`,
    [[...exclude]],
  );

  const word = result.rows[0]?.word;
  if (!word) {
    throw new Error("No join codes left. Remove an old event or expand the word list.");
  }
  return String(word).trim().toLowerCase();
}

function joinPlayUrl(basePlayUrl, eventCode) {
  const base = String(basePlayUrl || "").trim().replace(/\/$/, "") || "/play";
  const code = normalizeEventCodeInput(eventCode);
  if (!code || code === DEFAULT_EVENT_CODE) {
    return base;
  }
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}join=${encodeURIComponent(code)}`;
}

function displayJoinCode(eventCode) {
  const code = normalizeEventCodeInput(eventCode);
  if (!code || code === DEFAULT_EVENT_CODE) {
    return "";
  }
  return code.toUpperCase();
}

module.exports = {
  DEFAULT_EVENT_CODE,
  blocklistFilePath,
  displayJoinCode,
  formatEventCode,
  isBlockedEventCode,
  isDefaultEventCode,
  isEventCodeFormat,
  isReservedEventCode,
  joinPlayUrl,
  loadEventCodeBlocklist,
  normalizeEventCodeInput,
  pickRandomEventCode,
  validateEventCode,
};
