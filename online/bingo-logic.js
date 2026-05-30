function hashString(text) {
  let hash = 0;
  const value = String(text || "");
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function letterForNumber(number) {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

function callLabel(letter, number) {
  return `${letter}-${number}`;
}

function generateBingoCard(gameId, displayName) {
  const random = mulberry32(hashString(`${gameId}:${displayName}:card`));
  const grid = Array.from({ length: 5 }, () => Array(5).fill(0));

  for (let column = 0; column < 5; column += 1) {
    const min = column * 15 + 1;
    const pool = shuffle(
      Array.from({ length: 15 }, (_, index) => min + index),
      random,
    );
    for (let row = 0; row < 5; row += 1) {
      grid[row][column] = pool[row];
    }
  }

  grid[2][2] = 0;
  return { grid };
}

function generateCallSheet(gameId) {
  const random = mulberry32(hashString(`${gameId}:calls`));
  const balls = Array.from({ length: 75 }, (_, index) => {
    const number = index + 1;
    const letter = letterForNumber(number);
    return { letter, number, label: callLabel(letter, number) };
  });
  return shuffle(balls, random);
}

function createGameId() {
  return Math.random().toString(36).slice(2, 10);
}

function callsMade(callIndex) {
  return callIndex >= 0 ? callIndex + 1 : 0;
}

function calledNumbersFromSheet(callSheet, callIndex) {
  const called = new Set();
  if (!Array.isArray(callSheet) || callIndex < 0) {
    return called;
  }
  for (let index = 0; index <= callIndex && index < callSheet.length; index += 1) {
    const number = Number(callSheet[index]?.number || 0);
    if (number >= 1 && number <= 75) {
      called.add(number);
    }
  }
  return called;
}

function cellMarked(grid, row, column, calledNumbers) {
  if (row === 2 && column === 2) {
    return true;
  }
  const value = grid[row][column];
  return calledNumbers.has(value);
}

function hasBingoLine(grid, calledNumbers) {
  const lineComplete = (pickCell) => {
    for (let index = 0; index < 5; index += 1) {
      if (!pickCell(index)) {
        return false;
      }
    }
    return true;
  };

  for (let row = 0; row < 5; row += 1) {
    if (lineComplete((column) => cellMarked(grid, row, column, calledNumbers))) {
      return true;
    }
  }
  for (let column = 0; column < 5; column += 1) {
    if (lineComplete((row) => cellMarked(grid, row, column, calledNumbers))) {
      return true;
    }
  }
  if (lineComplete((index) => cellMarked(grid, index, index, calledNumbers))) {
    return true;
  }
  if (lineComplete((index) => cellMarked(grid, index, 4 - index, calledNumbers))) {
    return true;
  }
  return false;
}

function bingoAchievedWithinBudget(callSheet, callIndex, ballsEarned, grid) {
  const balls = Math.max(0, Number(ballsEarned || 0));
  if (balls < 1 || callIndex < 0) {
    return false;
  }
  const lastInBudgetIndex = Math.min(callIndex, balls - 1);
  for (let index = 0; index <= lastInBudgetIndex; index += 1) {
    const called = calledNumbersFromSheet(callSheet, index);
    if (hasBingoLine(grid, called)) {
      return true;
    }
  }
  return false;
}

function evaluateBingoClaim({ gameId, displayName, callSheet, callIndex, ballsEarned }) {
  const made = callsMade(callIndex);
  const balls = Math.max(0, Number(ballsEarned || 0));

  if (balls < 1) {
    return { ok: false, error: "You need at least 1 ball from Lingo to win bingo." };
  }
  if (made < 1) {
    return { ok: false, error: "No numbers have been called yet." };
  }

  const { grid } = generateBingoCard(gameId, displayName);
  if (!bingoAchievedWithinBudget(callSheet, callIndex, balls, grid)) {
    const called = calledNumbersFromSheet(callSheet, callIndex);
    if (!hasBingoLine(grid, called)) {
      return { ok: false, error: "No completed line on your card yet." };
    }
    return {
      ok: false,
      error: `You got bingo after your ${balls}-ball window — you needed a line by call ${balls}.`,
    };
  }

  return { ok: true, callsMade: made, ballsEarned: balls };
}

module.exports = {
  generateBingoCard,
  generateCallSheet,
  createGameId,
  callsMade,
  calledNumbersFromSheet,
  hasBingoLine,
  bingoAchievedWithinBudget,
  evaluateBingoClaim,
  callLabel,
};
