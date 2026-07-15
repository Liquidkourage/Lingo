const fs = require("fs/promises");
const path = require("path");
const { normalizeWordList, normalizeWordInput } = require("./words");

const wordSetsDir = path.join(__dirname, "data", "word-sets");

function wordSetIdFromFilename(filename) {
  return String(filename || "").replace(/\.json$/i, "");
}

async function readWordSetFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const id = String(parsed.id || wordSetIdFromFilename(path.basename(filePath))).trim();
  const name = String(parsed.name || id).trim();
  const description = String(parsed.description || "").trim();
  const words = normalizeWordList(parsed.words || []);
  return { id, name, description, words };
}

async function listWordSets() {
  let entries = [];
  try {
    entries = await fs.readdir(wordSetsDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sets = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const set = await readWordSetFile(path.join(wordSetsDir, entry));
    sets.push({
      id: set.id,
      name: set.name,
      description: set.description,
      wordCount: set.words.length,
    });
  }
  return sets.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadWordSetById(setId) {
  const normalizedId = String(setId || "").trim().toLowerCase();
  if (!normalizedId) {
    throw new Error("Word set id is required.");
  }

  const directPath = path.join(wordSetsDir, `${normalizedId}.json`);
  try {
    return await readWordSetFile(directPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  const sets = await listWordSets();
  const match = sets.find((set) => set.id.toLowerCase() === normalizedId);
  if (!match) {
    throw new Error(`Word set "${setId}" was not found.`);
  }
  return readWordSetFile(path.join(wordSetsDir, `${match.id}.json`));
}

module.exports = {
  listWordSets,
  loadWordSetById,
  normalizeWordInput,
};
