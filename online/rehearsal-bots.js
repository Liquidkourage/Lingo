const REHEARSAL_BOT_COUNT = 20;
const REHEARSAL_NAME_PREFIX = "Rehearsal ";

const REHEARSAL_BOT_NAMES = Array.from({ length: REHEARSAL_BOT_COUNT }, (_, index) => (
  `${REHEARSAL_NAME_PREFIX}${String(index + 1).padStart(2, "0")}`
));

function isRehearsalBotName(displayName) {
  return String(displayName || "").startsWith(REHEARSAL_NAME_PREFIX);
}

async function pickBotGuess(client) {
  const result = await client.query(
    `select word from words order by random() limit 1`,
  );
  return result.rows[0]?.word || "TYPEO";
}

async function clearRehearsalBots(sessionId, client) {
  await client.query(
    `delete from players
     where session_id = $1
       and display_name like $2`,
    [sessionId, `${REHEARSAL_NAME_PREFIX}%`],
  );
}

async function seedRehearsalBots(sessionId, upsertLobbyPlayer, client) {
  await clearRehearsalBots(sessionId, client);
  const created = [];
  for (const displayName of REHEARSAL_BOT_NAMES) {
    const row = await upsertLobbyPlayer(sessionId, displayName, "", client);
    created.push({
      id: Number(row.id),
      displayName: row.display_name,
    });
  }
  return created;
}

async function submitRehearsalBotGuesses({
  state,
  listPlayers,
  normalizeDisplayName,
  normalizePlayerKey,
  isLegalWord,
  maybeAutoRevealIfAllSubmitted,
  getState,
  client,
}) {
  if (state.phase !== "guessing" || !state.current_word) {
    return { submitted: 0, skipped: 0, reason: "Guessing is not open." };
  }

  const round = Number(state.round_number || 0);
  const players = await listPlayers(state.session_id, client);
  const bots = players.filter((player) => isRehearsalBotName(player.displayName));

  let submitted = 0;
  let skipped = 0;

  for (const player of bots) {
    if (player.solvedCurrentWord) {
      skipped += 1;
      continue;
    }
    if (Number(player.roundNumber) === round && player.currentGuess) {
      skipped += 1;
      continue;
    }

    const guess = await pickBotGuess(client);
    if (!(await isLegalWord(client, guess))) {
      skipped += 1;
      continue;
    }

    const displayName = normalizeDisplayName(player.displayName);
    await client.query(
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
         updated_at = now()`,
      [
        state.session_id,
        displayName,
        normalizePlayerKey(displayName),
        guess,
        round,
        guess.charAt(0).toUpperCase(),
      ],
    );

    const playerRow = await client.query(
      `select id from players
       where session_id = $1
         and normalized_display_name = $2`,
      [state.session_id, normalizePlayerKey(displayName)],
    );
    const playerId = playerRow.rows[0]?.id;
    if (playerId) {
      await client.query(
        `insert into guess_submissions (
           session_id,
           player_id,
           round_number,
           guess,
           submitted_at
         )
         values ($1, $2, $3, $4, now())`,
        [state.session_id, playerId, round, guess],
      );
    }

    submitted += 1;
  }

  let nextState = await getState(client);
  if (submitted > 0) {
    nextState = await maybeAutoRevealIfAllSubmitted(nextState, client);
  }

  return {
    submitted,
    skipped,
    botCount: bots.length,
    phase: nextState.phase,
    autoRevealTriggered: submitted > 0 && nextState.phase !== "guessing",
  };
}

async function getRehearsalStatus(state, listPlayers, client) {
  const round = Number(state.round_number || 0);
  const players = await listPlayers(state.session_id, client);
  const bots = players.filter((player) => isRehearsalBotName(player.displayName));
  const submitted = bots.filter(
    (player) => Number(player.roundNumber) === round && !!player.currentGuess,
  ).length;

  return {
    botCount: bots.length,
    targetCount: REHEARSAL_BOT_COUNT,
    submittedThisRound: submitted,
    phase: state.phase,
    roundNumber: round,
    currentWord: state.current_word ? state.current_word.toUpperCase() : "",
  };
}

module.exports = {
  REHEARSAL_BOT_COUNT,
  REHEARSAL_BOT_NAMES,
  REHEARSAL_NAME_PREFIX,
  isRehearsalBotName,
  clearRehearsalBots,
  seedRehearsalBots,
  submitRehearsalBotGuesses,
  getRehearsalStatus,
};
