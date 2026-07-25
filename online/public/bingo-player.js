(function (root) {
  const MARK_MODE_STORAGE_KEY = "typeo_bingo_mark_mode";
  const AUTO_MARK_COPY = "Auto-mark is on — called numbers light up for you. Switch to Manual if you want to tap the squares yourself. Tap BINGO! when you have a line.";
  const MANUAL_MARK_COPY = "Manual mark is on — when a number is called, tap it on your card to daub it. Only called numbers can be marked. Tap BINGO! when you have a line.";

  function create(options) {
    const {
      els,
      getGameId,
      getPlayerToken,
      BingoShared,
      setOuterMessage,
      setBallsEarned,
    } = options;

    let grid = [];
    let playerState = null;
    let bingoState = null;
    let lastAnimatedCall = "";
    let lastCardSignature = "";
    let lastHistorySignature = "";
    let markMode = loadMarkMode();
    let manualMarks = new Set();
    let marksGameId = "";

    function loadMarkMode() {
      try {
        const stored = String(localStorage.getItem(MARK_MODE_STORAGE_KEY) || "").trim().toLowerCase();
        return stored === "manual" ? "manual" : "auto";
      } catch (_error) {
        return "auto";
      }
    }

    function saveMarkMode(mode) {
      markMode = mode === "manual" ? "manual" : "auto";
      try {
        localStorage.setItem(MARK_MODE_STORAGE_KEY, markMode);
      } catch (_error) {
        // Ignore storage failures.
      }
      syncMarkModeControls();
      updateMarkModeCopy();
      lastCardSignature = "";
      if (bingoState) {
        updateUi();
      }
    }

    function marksStorageKey(gameId) {
      return `typeo_bingo_marks:${gameId}`;
    }

    function loadManualMarks(gameId) {
      manualMarks = new Set();
      marksGameId = gameId || "";
      if (!gameId) return;
      try {
        const raw = localStorage.getItem(marksStorageKey(gameId));
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          parsed.forEach((value) => {
            const number = Number(value);
            if (number >= 1 && number <= 75) manualMarks.add(number);
          });
        }
      } catch (_error) {
        manualMarks = new Set();
      }
    }

    function persistManualMarks() {
      if (!marksGameId) return;
      try {
        localStorage.setItem(
          marksStorageKey(marksGameId),
          JSON.stringify([...manualMarks]),
        );
      } catch (_error) {
        // Ignore storage failures.
      }
    }

    function ensureMarksForGame(gameId) {
      if (!gameId) {
        manualMarks = new Set();
        marksGameId = "";
        return;
      }
      if (marksGameId !== gameId) {
        loadManualMarks(gameId);
      }
    }

    function isManualMode() {
      return markMode === "manual";
    }

    function updateMarkModeCopy() {
      const copy = isManualMode() ? MANUAL_MARK_COPY : AUTO_MARK_COPY;
      if (els.autoMarkNote) {
        els.autoMarkNote.textContent = copy;
      }
    }

    function syncMarkModeControls() {
      if (els.markModeAuto) {
        els.markModeAuto.checked = !isManualMode();
      }
      if (els.markModeManual) {
        els.markModeManual.checked = isManualMode();
      }
      if (els.bingoCard) {
        els.bingoCard.dataset.markMode = markMode;
        els.bingoCard.setAttribute(
          "aria-label",
          isManualMode()
            ? "Your bingo card — tap called numbers to mark them"
            : "Your bingo card — numbers mark automatically when called",
        );
      }
    }

    function findScrollParent(node) {
      let el = node;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
          return el;
        }
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }

    function withPreservedScroll(fn) {
      const anchor = els.bingoBody || els.budgetLine || els.status;
      const scroller = findScrollParent(anchor);
      const top = scroller ? scroller.scrollTop : 0;
      const windowX = window.scrollX;
      const windowY = window.scrollY;
      fn();
      if (scroller) scroller.scrollTop = top;
      window.scrollTo(windowX, windowY);
    }

    function setStatus(text, type = "") {
      if (els.status) {
        els.status.textContent = text || "";
        els.status.className = (els.statusClassBase || "message") + (type ? ` ${type}` : "");
      }
      if (setOuterMessage && text) {
        setOuterMessage(text, type);
      }
    }

    function toggleManualMark(number) {
      if (!isManualMode() || !number) return;
      const called = new Set(Array.isArray(bingoState?.calledNumbers) ? bingoState.calledNumbers : []);
      if (!called.has(number)) {
        setStatus("That number has not been called yet.", "error");
        return;
      }
      if (manualMarks.has(number)) {
        manualMarks.delete(number);
      } else {
        manualMarks.add(number);
      }
      persistManualMarks();
      lastCardSignature = "";
      renderCard(bingoState.calledNumbers);
    }

    function renderCard(calledNumbers) {
      if (!els.bingoBody || !grid.length) return;
      const called = Array.isArray(calledNumbers) ? calledNumbers : [];
      const marksKey = isManualMode() ? [...manualMarks].sort((a, b) => a - b).join(",") : "auto";
      const signature = `${markMode}|${grid.flat().join(",")}|${called.join(",")}|${marksKey}`;
      if (signature === lastCardSignature) return;
      lastCardSignature = signature;
      const calledSet = new Set(called);
      els.bingoBody.replaceChildren();
      for (let row = 0; row < 5; row += 1) {
        const tr = document.createElement("tr");
        for (let column = 0; column < 5; column += 1) {
          const td = document.createElement("td");
          const value = grid[row][column];
          const isFree = row === 2 && column === 2;
          td.textContent = isFree ? "FREE" : String(value);
          if (isFree) {
            td.classList.add("free", "called");
          } else if (isManualMode()) {
            const isCalled = calledSet.has(value);
            const isMarked = manualMarks.has(value);
            if (isMarked) {
              td.classList.add("called");
            } else if (isCalled) {
              td.classList.add("is-callable");
            }
            if (isCalled) {
              td.tabIndex = 0;
              td.setAttribute("role", "button");
              td.setAttribute(
                "aria-label",
                isMarked
                  ? `${value} marked — tap to unmark`
                  : `${value} called — tap to mark`,
              );
              td.addEventListener("click", () => toggleManualMark(value));
              td.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleManualMark(value);
                }
              });
            }
          } else if (calledSet.has(value)) {
            td.classList.add("called");
          }
          tr.appendChild(td);
        }
        els.bingoBody.appendChild(tr);
      }
      if (els.cardPanel) {
        els.cardPanel.hidden = false;
      }
    }

    function renderCallUi() {
      if (!bingoState) return;
      const lastCall = bingoState.lastCall || "—";
      if (els.lastCall) {
        els.lastCall.textContent = lastCall;
      }
      if (lastCall && lastCall !== "—") {
        if (els.callHeroWrap) els.callHeroWrap.hidden = false;
        if (els.callHero && lastCall !== lastAnimatedCall) {
          lastAnimatedCall = lastCall;
          root.TypeoShow?.animateBingoCallBall(els.callHero, lastCall);
        }
      }
      if (els.callHistory && root.TypeoShow) {
        const called = bingoState.called || [];
        const historySignature = `${called.join(",")}|${lastCall}`;
        if (historySignature !== lastHistorySignature) {
          lastHistorySignature = historySignature;
          root.TypeoShow.renderBingoCallHistory(els.callHistory, called, lastCall);
        }
      }
    }

    function renderBudgetCard(nextPlayerState) {
      if (!nextPlayerState) {
        if (els.budgetTarget) els.budgetTarget.textContent = "—";
        if (els.budgetCalls) els.budgetCalls.textContent = "—";
        if (els.budgetRemainingValue) els.budgetRemainingValue.textContent = "—";
        if (els.ballsRemainingValue) els.ballsRemainingValue.textContent = "—";
        return;
      }
      const {
        ballsEarned,
        callsMade,
        budgetRemaining,
      } = nextPlayerState;
      if (els.budgetTarget) {
        els.budgetTarget.textContent = ballsEarned > 0 ? String(ballsEarned) : "—";
      }
      if (els.budgetCalls) {
        els.budgetCalls.textContent = String(callsMade);
      }
      if (els.budgetRemainingValue) {
        els.budgetRemainingValue.textContent = ballsEarned > 0 ? String(budgetRemaining) : "—";
      }
      if (els.ballsRemainingValue) {
        els.ballsRemainingValue.textContent = String(budgetRemaining);
      }
    }

    function watchingStatusCopy() {
      return isManualMode()
        ? "Tap called numbers on your card to mark them."
        : "Watch your card — called numbers light up automatically.";
    }

    function updateUi() {
      if (!bingoState) return;
      withPreservedScroll(() => {
        syncMarkModeControls();
        updateMarkModeCopy();
        renderCallUi();

        if (bingoState.hasWinner) {
          if (els.winnerBanner) {
            els.winnerBanner.hidden = false;
            els.winnerBanner.textContent = `${bingoState.winnerDisplayName} won bingo!`;
          }
          if (els.bingoBtn) els.bingoBtn.disabled = true;
        } else if (els.winnerBanner) {
          els.winnerBanner.hidden = true;
        }

        if (!playerState) {
          renderBudgetCard(null);
          if (setBallsEarned) {
            setBallsEarned(null);
          }
          if (els.budgetLine) {
            els.budgetLine.innerHTML = "Join the game on this device to load your card.";
          }
          if (els.bingoBtn) els.bingoBtn.disabled = true;
          return;
        }

        const {
          ballsEarned,
          callsMade,
          hasLine,
          earnedBingoInBudget,
          canClaim,
          isWinner,
          budgetRemaining,
        } = playerState;

        if (setBallsEarned) {
          setBallsEarned(ballsEarned);
        }
        renderBudgetCard(playerState);

        if (isWinner) {
          if (els.budgetLine) {
            els.budgetLine.textContent = "You won bingo! Your TYPEO balls set the call window you had to beat.";
          }
          if (els.bingoBtn) els.bingoBtn.disabled = true;
          setStatus("Congratulations!", "success");
        } else if (ballsEarned < 1) {
          if (els.budgetLine) {
            els.budgetLine.textContent = "You need at least 1 ball from TYPEO to be eligible for bingo.";
          }
          if (els.bingoBtn) els.bingoBtn.disabled = true;
          setStatus("", "");
        } else if (bingoState.hasWinner) {
          if (els.budgetLine) {
            els.budgetLine.textContent = `${bingoState.winnerDisplayName} got bingo first.`;
          }
          setStatus(`${bingoState.winnerDisplayName} got bingo first.`, "error");
          if (els.bingoBtn) els.bingoBtn.disabled = true;
        } else {
          if (els.budgetLine) {
            if (canClaim) {
              els.budgetLine.textContent = callsMade > ballsEarned
                ? "You had bingo in time — tap BINGO! (A late tap is fine.)"
                : "You have bingo within your ball budget — tap BINGO!";
            } else if (hasLine && !earnedBingoInBudget) {
              els.budgetLine.textContent = `Your line completed after call ${ballsEarned} — too late to win.`;
            } else if (callsMade >= ballsEarned && !earnedBingoInBudget) {
              els.budgetLine.textContent = `No bingo by call ${ballsEarned} — you're out of the running.`;
            } else if (budgetRemaining === 0) {
              els.budgetLine.textContent = `This is your last call in budget — need bingo on call ${callsMade + 1} or earlier.`;
            } else {
              els.budgetLine.textContent = `Need a line before call ${ballsEarned + 1}. ${budgetRemaining} call${budgetRemaining === 1 ? "" : "s"} left in your budget.`;
            }
          }
          if (canClaim) {
            const late = callsMade > ballsEarned;
            setStatus(
              late
                ? "You had bingo in time — tap BINGO! (A late tap is fine.)"
                : "You have bingo within your ball budget — tap BINGO!",
              "success",
            );
            if (els.bingoBtn) els.bingoBtn.disabled = false;
          } else if (hasLine && !earnedBingoInBudget) {
            setStatus(`Your line came after call ${ballsEarned} — too late to win.`, "error");
            if (els.bingoBtn) els.bingoBtn.disabled = true;
          } else if (callsMade >= ballsEarned && !earnedBingoInBudget) {
            setStatus(`No bingo by call ${ballsEarned} — you're out.`, "error");
            if (els.bingoBtn) els.bingoBtn.disabled = true;
          } else {
            setStatus(watchingStatusCopy(), "");
            if (els.bingoBtn) els.bingoBtn.disabled = true;
          }
        }

        renderCard(bingoState.calledNumbers);
      });
    }

    async function loadPlayerState(gameId) {
      const token = getPlayerToken();
      if (!token) {
        playerState = null;
        return;
      }
      const playerRes = await fetch(
        `/api/bingo/player-state?game=${encodeURIComponent(gameId)}&playerToken=${encodeURIComponent(token)}`,
      );
      const playerPayload = await playerRes.json();
      if (playerRes.ok && playerPayload.ok) {
        playerState = playerPayload.player;
        const card = BingoShared.generateBingoCard(gameId, playerState.displayName);
        grid = card.grid;
        ensureMarksForGame(gameId);
      } else {
        playerState = null;
        setStatus(playerPayload.error || "Re-join the game on this device.", "error");
      }
    }

    async function refresh(options = {}) {
      const gameId = getGameId();
      if (!gameId) {
        setStatus("Bingo has not started yet.", "error");
        return;
      }

      if (options.publicState?.bingo && options.publicState.bingo.gameId === gameId) {
        bingoState = options.publicState.bingo;
      } else {
        const bingoRes = await fetch(`/api/bingo/state?game=${encodeURIComponent(gameId)}`);
        const bingoPayload = await bingoRes.json();
        if (!bingoRes.ok || !bingoPayload.ok) {
          throw new Error(bingoPayload.error || "Could not load bingo game.");
        }
        bingoState = bingoPayload.bingo;
      }

      await loadPlayerState(gameId);
      updateUi();
    }

    async function refreshFromPublicState(publicState) {
      const gameId = getGameId();
      if (!gameId || !publicState?.bingo) {
        return;
      }
      bingoState = publicState.bingo;
      await loadPlayerState(gameId);
      updateUi();
    }

    async function claim() {
      const gameId = getGameId();
      const token = getPlayerToken();
      if (!gameId) {
        setStatus("Bingo has not started yet.", "error");
        return;
      }
      if (!token) {
        setStatus("Join the game on this device first.", "error");
        return;
      }
      if (els.bingoBtn) els.bingoBtn.disabled = true;
      try {
        const response = await fetch("/api/bingo/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId, playerToken: token }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Claim rejected.");
        }
        setStatus(
          `BINGO accepted — you win! (${payload.bingo.callsMade} calls, ${playerState?.ballsEarned || "?"} balls)`,
          "success",
        );
        bingoState = payload.bingo;
        await loadPlayerState(gameId);
        updateUi();
      } catch (error) {
        setStatus(error.message || "Could not claim bingo.", "error");
        updateUi();
      }
    }

    function wireMarkModeControls() {
      if (els.markModeAuto) {
        els.markModeAuto.addEventListener("change", () => {
          if (els.markModeAuto.checked) saveMarkMode("auto");
        });
      }
      if (els.markModeManual) {
        els.markModeManual.addEventListener("change", () => {
          if (els.markModeManual.checked) saveMarkMode("manual");
        });
      }
      syncMarkModeControls();
      updateMarkModeCopy();
    }

    wireMarkModeControls();

    return {
      AUTO_MARK_COPY,
      MANUAL_MARK_COPY,
      refresh,
      refreshFromPublicState,
      claim,
      updateUi,
      setMarkMode: saveMarkMode,
      getMarkMode: () => markMode,
    };
  }

  root.BingoPlayerUi = {
    create,
    AUTO_MARK_COPY,
    MANUAL_MARK_COPY,
  };
})(typeof window !== "undefined" ? window : globalThis);
