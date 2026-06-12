#!/usr/bin/env node
/**
 * One-shot 20-bot rehearsal setup against a running TYPEO server.
 *
 * Usage (from online/):
 *   LINGO_ADMIN_KEY=secret BASE_URL=https://lingo-production-fc88.up.railway.app node scripts/run-rehearsal.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const baseUrl = String(process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const adminKey = String(process.env.LINGO_ADMIN_KEY || "").trim();

if (!adminKey) {
  console.error("LINGO_ADMIN_KEY is required.");
  process.exit(1);
}

async function adminPost(command, body = {}) {
  const response = await fetch(`${baseUrl}/api/admin/rehearsal/${command}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-lingo-admin-key": adminKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Failed: ${command}`);
  }
  return payload;
}

async function main() {
  console.log(`Rehearsal setup → ${baseUrl}`);
  const payload = await adminPost("setup", {
    forceReset: true,
    startRound: true,
    autoSubmit: true,
  });
  console.log(`Bots: ${payload.bots?.length || 0}`);
  console.log(`Word: ${payload.word || "(see host)"}`);
  console.log(`Phase: ${payload.status?.phase}`);
  console.log(`Auto-guess: ${payload.autoSubmit ? "on" : "off"}`);
  console.log("");
  console.log("Open:");
  console.log(`  ${baseUrl}/rehearsal`);
  console.log(`  ${baseUrl}/host`);
  console.log(`  ${baseUrl}/display`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
