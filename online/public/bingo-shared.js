(function (root) {
  const LETTERS = ["B", "I", "N", "G", "O"];

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

  function callLabel(letter, number) {
    return `${letter}-${number}`;
  }

  function letterForNumber(number) {
    if (number <= 15) return "B";
    if (number <= 30) return "I";
    if (number <= 45) return "N";
    if (number <= 60) return "G";
    return "O";
  }

  function generateBingoCard(gameId, displayName) {
    const random = mulberry32(hashString(`${gameId}:${displayName}:card`));
    const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
    const marked = Array.from({ length: 5 }, () => Array(5).fill(false));

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
    marked[2][2] = true;

    return { grid, marked };
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

  root.BingoShared = {
    LETTERS,
    hashString,
    generateBingoCard,
    generateCallSheet,
    createGameId,
    callLabel,
  };
}(typeof window !== "undefined" ? window : globalThis));
