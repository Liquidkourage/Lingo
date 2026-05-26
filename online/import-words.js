const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { countWords, seedWordsTable, wordsFilePath } = require("./words");
require("dotenv").config();

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const schemaPath = path.join(__dirname, "db", "schema.sql");

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

async function main() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  try {
    const sql = fs.readFileSync(schemaPath, "utf8");
    await pool.query(sql);

    const importResult = await seedWordsTable(pool, wordsFilePath);
    const totalWords = await countWords(pool);

    console.log(
      `Word import complete. Added ${importResult.insertedCount} new words from ${importResult.sourceCount} source rows. Database now has ${totalWords} legal words.`
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Word import failed:", error);
  process.exit(1);
});
