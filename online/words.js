const fs = require("fs/promises");
const path = require("path");

const wordsFilePath = path.join(__dirname, "data", "words.txt");

function normalizeWordInput(value) {
  return String(value || "").trim().toUpperCase();
}

function isFiveLetterWord(word) {
  return /^[A-Z]{5}$/.test(normalizeWordInput(word));
}

function parseWordsFile(contents) {
  const words = new Set();

  for (const line of String(contents || "").split(/\r?\n/)) {
    const word = normalizeWordInput(line);
    if (isFiveLetterWord(word)) {
      words.add(word);
    }
  }

  return Array.from(words);
}

async function loadWordsFromFile(filePath = wordsFilePath) {
  const contents = await fs.readFile(filePath, "utf8");
  const words = parseWordsFile(contents);
  if (!words.length) {
    throw new Error(`No valid 5-letter words found in ${filePath}`);
  }
  return words;
}

async function seedWordsTable(db, filePath = wordsFilePath) {
  const words = await loadWordsFromFile(filePath);
  const result = await db.query(
    `insert into words (word)
     select distinct unnest($1::text[])
     on conflict (word) do nothing`,
    [words]
  );

  return {
    sourceCount: words.length,
    insertedCount: result.rowCount || 0,
  };
}

async function countWords(db) {
  const result = await db.query("select count(*)::int as count from words");
  return Number(result.rows[0]?.count || 0);
}

async function isLegalWord(db, word) {
  const normalized = normalizeWordInput(word);
  if (!isFiveLetterWord(normalized)) {
    return false;
  }

  const result = await db.query("select 1 from words where word = $1", [normalized]);
  return result.rowCount > 0;
}

function normalizeWordList(words) {
  return [...new Set(
    (Array.isArray(words) ? words : [])
      .map(normalizeWordInput)
      .filter(isFiveLetterWord),
  )];
}

async function pickRandomWords(db, count, excludeWords = []) {
  const limit = Math.max(0, Number(count) || 0);
  if (!limit) return [];

  const exclude = normalizeWordList(excludeWords);
  const result = exclude.length
    ? await db.query(
      `select word
       from words
       where not (word = any($1::text[]))
       order by random()
       limit $2`,
      [exclude, limit],
    )
    : await db.query(
      `select word
       from words
       order by random()
       limit $1`,
      [limit],
    );

  return result.rows.map((row) => row.word);
}

async function countAvailableWords(db, excludeWords = []) {
  const exclude = normalizeWordList(excludeWords);
  const result = exclude.length
    ? await db.query(
      `select count(*)::int as count
       from words
       where not (word = any($1::text[]))`,
      [exclude],
    )
    : await db.query("select count(*)::int as count from words");
  return Number(result.rows[0]?.count || 0);
}

module.exports = {
  countAvailableWords,
  countWords,
  isFiveLetterWord,
  isLegalWord,
  loadWordsFromFile,
  normalizeWordInput,
  normalizeWordList,
  parseWordsFile,
  pickRandomWords,
  seedWordsTable,
  wordsFilePath,
};
