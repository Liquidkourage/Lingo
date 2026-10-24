/**
 * Durable player accounts: lifetime stats and round history.
 * The night's seat stays on `players`. Guests have no rows here.
 */

const ACHIEVEMENTS = [
  { id: "first_solve", title: "First solve", test: (stats) => Number(stats.words_solved) >= 1 },
  { id: "ten_solves", title: "Ten solves", test: (stats) => Number(stats.words_solved) >= 10 },
  { id: "ball_stack", title: "Ball stack", test: (stats) => Number(stats.balls_earned) >= 25 },
  { id: "century_balls", title: "Century", test: (stats) => Number(stats.balls_earned) >= 100 },
  { id: "bingo", title: "Bingo", test: (stats) => Number(stats.bingos_won) >= 1 },
  { id: "regular", title: "Regular", test: (stats) => Number(stats.shows_joined) >= 10 },
];

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  if (!value || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeClientId(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > 80) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}

function emptyStats() {
  return {
    showsJoined: 0,
    guessesMade: 0,
    wordsSolved: 0,
    ballsEarned: 0,
    bingosWon: 0,
  };
}

function statsPublicRow(row) {
  if (!row) return emptyStats();
  return {
    showsJoined: Number(row.shows_joined) || 0,
    guessesMade: Number(row.guesses_made) || 0,
    wordsSolved: Number(row.words_solved) || 0,
    ballsEarned: Number(row.balls_earned) || 0,
    bingosWon: Number(row.bingos_won) || 0,
  };
}

async function ensureStatsRow(client, userId) {
  await client.query(
    `insert into player_stats (user_id)
     values ($1)
     on conflict (user_id) do nothing`,
    [userId],
  );
}

async function syncAchievements(client, userId) {
  const stats = await client.query(
    `select shows_joined, guesses_made, words_solved, balls_earned, bingos_won
     from player_stats
     where user_id = $1`,
    [userId],
  );
  const row = stats.rows[0];
  if (!row) return;
  for (const badge of ACHIEVEMENTS) {
    if (!badge.test(row)) continue;
    await client.query(
      `insert into player_achievements (user_id, achievement_id)
       values ($1, $2)
       on conflict (user_id, achievement_id) do nothing`,
      [userId, badge.id],
    );
  }
}

async function recordShowJoin(client, userId, sessionId) {
  const id = Number(userId);
  const session = String(sessionId || "").trim();
  if (!id || !session) return;
  await ensureStatsRow(client, id);
  const inserted = await client.query(
    `insert into player_show_joins (user_id, session_id)
     values ($1, $2)
     on conflict (user_id, session_id) do nothing
     returning user_id`,
    [id, session],
  );
  if (!inserted.rows.length) return;
  await client.query(
    `update player_stats
     set shows_joined = shows_joined + 1,
         updated_at = now()
     where user_id = $1`,
    [id],
  );
  await syncAchievements(client, id);
}

async function recordGuess(client, ctx) {
  const userId = Number(ctx.userId);
  const sessionId = String(ctx.sessionId || "").trim();
  if (!userId || !sessionId) return;
  const roundNumber = Number(ctx.roundNumber) || 0;
  const displayName = String(ctx.displayName || "").slice(0, 40);
  await ensureStatsRow(client, userId);
  await client.query(
    `update player_stats
     set guesses_made = guesses_made + 1,
         updated_at = now()
     where user_id = $1`,
    [userId],
  );
  await client.query(
    `insert into player_round_history (
       user_id, session_id, round_number, display_name, guesses
     )
     values ($1, $2, $3, $4, 1)
     on conflict (user_id, session_id, round_number) do update
       set guesses = player_round_history.guesses + 1,
           display_name = excluded.display_name`,
    [userId, sessionId, roundNumber, displayName],
  );
  await syncAchievements(client, userId);
}

async function recordSolve(client, ctx) {
  const userId = Number(ctx.userId);
  const sessionId = String(ctx.sessionId || "").trim();
  if (!userId || !sessionId) return;
  const roundNumber = Number(ctx.roundNumber) || 0;
  const displayName = String(ctx.displayName || "").slice(0, 40);
  const word = String(ctx.word || "").slice(0, 5);
  const balls = Math.max(0, Number(ctx.balls) || 0);
  await ensureStatsRow(client, userId);
  await client.query(
    `update player_stats
     set words_solved = words_solved + 1,
         balls_earned = balls_earned + $2,
         updated_at = now()
     where user_id = $1`,
    [userId, balls],
  );
  await client.query(
    `insert into player_round_history (
       user_id, session_id, round_number, display_name, word, solved, balls_earned
     )
     values ($1, $2, $3, $4, $5, true, $6)
     on conflict (user_id, session_id, round_number) do update
       set solved = true,
           word = excluded.word,
           display_name = excluded.display_name,
           balls_earned = player_round_history.balls_earned + excluded.balls_earned`,
    [userId, sessionId, roundNumber, displayName, word, balls],
  );
  await syncAchievements(client, userId);
}

async function recordBingoWin(client, ctx) {
  const userId = Number(ctx.userId);
  const sessionId = String(ctx.sessionId || "").trim();
  if (!userId || !sessionId) return;
  const roundNumber = Number(ctx.roundNumber) || 0;
  const displayName = String(ctx.displayName || "").slice(0, 40);
  await ensureStatsRow(client, userId);
  await client.query(
    `update player_stats
     set bingos_won = bingos_won + 1,
         updated_at = now()
     where user_id = $1`,
    [userId],
  );
  await client.query(
    `insert into player_round_history (
       user_id, session_id, round_number, display_name, bingo_won
     )
     values ($1, $2, $3, $4, true)
     on conflict (user_id, session_id, round_number) do update
       set bingo_won = true,
           display_name = excluded.display_name`,
    [userId, sessionId, roundNumber, displayName],
  );
  await syncAchievements(client, userId);
}

async function loadCareer(client, userId) {
  const id = Number(userId);
  if (!id) {
    return { stats: emptyStats(), achievements: [], recentRounds: [] };
  }
  await ensureStatsRow(client, id);
  const statsResult = await client.query(
    `select shows_joined, guesses_made, words_solved, balls_earned, bingos_won
     from player_stats
     where user_id = $1`,
    [id],
  );
  const badges = await client.query(
    `select achievement_id, unlocked_at
     from player_achievements
     where user_id = $1
     order by unlocked_at asc`,
    [id],
  );
  const rounds = await client.query(
    `select round_number, word, guesses, solved, balls_earned, bingo_won, started_at
     from player_round_history
     where user_id = $1
     order by started_at desc
     limit 12`,
    [id],
  );
  const titleById = new Map(ACHIEVEMENTS.map((badge) => [badge.id, badge.title]));
  return {
    stats: statsPublicRow(statsResult.rows[0]),
    achievements: badges.rows.map((row) => ({
      id: row.achievement_id,
      title: titleById.get(row.achievement_id) || row.achievement_id,
      unlockedAt: row.unlocked_at ? new Date(row.unlocked_at).toISOString() : null,
    })),
    recentRounds: rounds.rows.map((row) => ({
      roundNumber: Number(row.round_number) || 0,
      word: row.solved ? String(row.word || "") : "",
      guesses: Number(row.guesses) || 0,
      solved: Boolean(row.solved),
      ballsEarned: Number(row.balls_earned) || 0,
      bingoWon: Boolean(row.bingo_won),
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    })),
  };
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  normalizeClientId,
  recordShowJoin,
  recordGuess,
  recordSolve,
  recordBingoWin,
  loadCareer,
};
