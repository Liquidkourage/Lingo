(function (root) {
  const AUTO_MARK_COPY = "Numbers light up automatically when called — you do not tap squares on your card. Watch the screen and tap BINGO! when you have a line.";

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

    function setStatus(text, type = "") {
      if (els.status) {
        els.status.textContent = text || "";
        els.status.className = (els.statusClassBase || "message") + (type ? ` ${type}` : "");
      }
      if (setOuterMessage && text) {
        setOuterMessage(text, type);
      }
    }

    function renderCard(calledNumbers) {
      if (!els.bingoBody || !grid.length) return;
      const called = new Set(Array.isArray(calledNumbers) ? calledNumbers : []);
      els.bingoBody.replaceChildren();
      for (let row = 0; row < 5; row += 1) {
        const tr = document.createElement("tr");
        for (let column = 0; column < 5; column += 1) {
          const td = document.createElement("td");
          const value = grid[row][column];
          const isFree = row === 2 && column === 2;
          td.textContent = isFree ? "FREE" : String(value);
          if (isFree) td.classList.add("free");
          if (!isFree && called.has(value)) td.classList.add("called");
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
        root.TypeoShow.renderBingoCallHistory(els.callHistory, bingoState.called || [], lastCall);
      }
    }

    function renderBudgetCard(playerState) {
      if (!playerState) {
        if (els.budgetTarget) els.budgetTarget.textContent = '—';
        if (els.budgetCalls) els.budgetCalls.textContent = '—';
        if (els.budgetRemainingValue) els.budgetRemainingValue.textContent = '—';
        if (els.ballsRemainingValue) els.ballsRemainingValue.textContent = '—';
        return;
      }
      const {
        ballsEarned,
        callsMade,
        budgetRemaining,
      } = playerState;
      if (els.budgetTarget) {
        els.budgetTarget.textContent = ballsEarned > 0 ? String(ballsEarned) : '—';
      }
      if (els.budgetCalls) {
        els.budgetCalls.textContent = String(callsMade);
      }
      if (els.budgetRemainingValue) {
        els.budgetRemainingValue.textContent = ballsEarned > 0 ? String(budgetRemaining) : '—';
      }
      if (els.ballsRemainingValue) {
        els.ballsRemainingValue.textContent = String(budgetRemaining);
      }
    }

    function updateUi() {
      if (!bingoState) return;
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
          els.budgetLine.textContent = 'You won bingo! Your TYPEO balls set the call window you had to beat.';
        }
        if (els.bingoBtn) els.bingoBtn.disabled = true;
        setStatus("Congratulations!", "success");
      } else if (ballsEarned < 1) {
        if (els.budgetLine) {
          els.budgetLine.textContent = 'You need at least 1 ball from TYPEO to be eligible for bingo.';
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
              ? 'You had bingo in time — tap BINGO! (A late tap is fine.)'
              : 'You have bingo within your ball budget — tap BINGO!';
          } else if (hasLine && !earnedBingoInBudget) {
            els.budgetLine.textContent = `Your line completed after call ${ballsEarned} — too late to win.`;
          } else if (callsMade >= ballsEarned && !earnedBingoInBudget) {
            els.budgetLine.textContent = `No bingo by call ${ballsEarned} — you're out of the running.`;
          } else if (budgetRemaining === 0) {
            els.budgetLine.textContent = `This is your last call in budget — need bingo on call ${callsMade + 1} or earlier.`;
          } else {
            els.budgetLine.textContent = `Need a line before call ${ballsEarned + 1}. ${budgetRemaining} call${budgetRemaining === 1 ? '' : 's'} left in your budget.`;
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
          setStatus("Watch your card — called numbers light up automatically.", "");
          if (els.bingoBtn) els.bingoBtn.disabled = true;
        }
      }

      renderCard(bingoState.calledNumbers);
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

    return {
      AUTO_MARK_COPY,
      refresh,
      refreshFromPublicState,
      claim,
      updateUi,
    };
  }

  root.BingoPlayerUi = { create, AUTO_MARK_COPY };
})(typeof window !== "undefined" ? window : globalThis);
