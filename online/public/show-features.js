(function (root) {
  function patternSymbol(mark) {
    if (mark === "!") return "▪";
    if (mark === "?") return "○";
    if (mark === "/") return "✕";
    return "·";
  }

  function scrambledWord(word) {
    const letters = String(word || "").toUpperCase().split("").filter(Boolean);
    for (let i = letters.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    const result = letters.join("");
    if (result === String(word || "").toUpperCase() && letters.length > 1) {
      return scrambledWord(word);
    }
    return result;
  }

  function playHostAlert(kind) {
    try {
      const AudioCtx = root.AudioContext || root.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = kind === "critical" ? 880 : kind === "all-in" ? 660 : 520;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.stop(ctx.currentTime + 0.26);
      window.setTimeout(() => ctx.close().catch(() => {}), 300);
    } catch (_error) {
      // Audio is optional.
    }
  }

  function renderLeaderboardList(container, entries, options = {}) {
    if (!container) return;
    container.replaceChildren();
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
      const empty = document.createElement("li");
      empty.textContent = "No players yet.";
      container.appendChild(empty);
      return;
    }
    list.slice(0, options.limit || 20).forEach((entry, index) => {
      const item = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "leaderboard-rank";
      rank.textContent = `#${index + 1}`;
      const name = document.createElement("span");
      name.className = "leaderboard-name";
      name.textContent = entry.displayName || "Player";
      const balls = document.createElement("span");
      balls.className = "leaderboard-balls";
      balls.textContent = `${Number(entry.balls || 0)} balls`;
      item.append(rank, name, balls);
      container.appendChild(item);
    });
  }

  function triggerBallsplosion(container, count) {
    if (!container) return;
    container.replaceChildren();
    container.classList.add("is-active");
    const total = Math.max(8, Math.min(Number(count) || 12, 24));
    for (let i = 0; i < total; i += 1) {
      const ball = document.createElement("span");
      ball.className = "ballsplosion-ball";
      ball.style.left = `${45 + Math.random() * 10}%`;
      ball.style.top = `${45 + Math.random() * 10}%`;
      ball.style.setProperty("--dx", `${(Math.random() - 0.5) * 90}vw`);
      ball.style.setProperty("--dy", `${(Math.random() - 0.5) * 50}vh`);
      ball.style.animationDelay = `${Math.random() * 0.25}s`;
      container.appendChild(ball);
    }
    window.setTimeout(() => {
      container.classList.remove("is-active");
      container.replaceChildren();
    }, 1600);
  }

  function renderBingoCallHistory(container, calls, latest) {
    if (!container) return;
    container.replaceChildren();
    const list = Array.isArray(calls) ? calls.slice(-12).reverse() : [];
    if (!list.length) {
      const empty = document.createElement("li");
      empty.textContent = "Waiting for calls…";
      container.appendChild(empty);
      return;
    }
    list.forEach((label) => {
      const item = document.createElement("li");
      item.textContent = label;
      if (label && label === latest) item.classList.add("is-latest");
      container.appendChild(item);
    });
  }

  function animateBingoCallBall(heroEl, label) {
    if (!heroEl) return;
    heroEl.hidden = false;
    heroEl.textContent = label || "—";
    heroEl.classList.remove("is-shrinking");
    void heroEl.offsetWidth;
    heroEl.classList.add("is-shrinking");
    window.setTimeout(() => {
      heroEl.classList.remove("is-shrinking");
    }, 900);
  }

  root.TypeoShow = {
    patternSymbol,
    scrambledWord,
    playHostAlert,
    renderLeaderboardList,
    triggerBallsplosion,
    renderBingoCallHistory,
    animateBingoCallBall,
  };
})(typeof window !== "undefined" ? window : globalThis);
