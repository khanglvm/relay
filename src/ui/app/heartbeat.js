  // ---------- heartbeat ----------
  // True when the user is actively typing — an open annotation comment popover,
  // or focus in any text-entry field (comment box, notes, text/color answers,
  // "Other" inputs). Used to defer the live-update reload so in-progress
  // comments aren't destroyed mid-keystroke.
  function isEditable(node) {
    if (!node) return false;
    if (node.tagName === 'TEXTAREA') return true;
    if (node.tagName === 'INPUT') {
      const t = (node.type || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url', 'tel', 'number', 'color'].includes(t);
    }
    return node.isContentEditable === true;
  }
  function userIsComposing() {
    if (window.RelayAnnotate && typeof RelayAnnotate.isComposing === 'function' && RelayAnnotate.isComposing()) return true;
    return isEditable(document.activeElement);
  }

  let misses = 0;
  let reloading = false;
  let hb = null;
  async function heartbeatTick() {
    // Piggyback presence on the heartbeat (best-effort; no-ops after submit).
    pingPresence();
    try {
      const r = await fetch('/api/status', { cache: 'no-store', headers: authHeaders() });
      if (!r.ok) throw new Error('bad status');
      misses = 0;
      // The heartbeat reaching the server is itself proof persistence is back —
      // if we were blocked (saves had been failing), recover now and flush.
      if (persistenceLost) {
        unblockAfterRecovery();
        return;
      }
      // Live update: the agent ran `rly update`, advancing the server rev.
      // Flush whatever the user has typed so far (the reload re-prefills from
      // the live draft — answers for now-removed question ids are ignored),
      // then reload to render the new spec. Guarded so it fires once.
      const body = await r.json().catch(() => null);
      // Soft timeout: the board ran past its deadline so the agent was handed a
      // result and stopped waiting — but the server is still up and the board
      // stays fully usable. Surface a calm note (never disable Submit) so the
      // user knows to prompt the agent after submitting.
      if (body && body.softTimedOut && !submitted) {
        handedBack = true;
        if (access.role === 'review') {
          showNotice('This remains a reference-only side review. Submit when ready; the owner still needs to provide the final answer.', 'info');
        } else if (access.role !== 'read') {
          showNotice(
            'You’ve had this open a while, so the agent stopped waiting. Your changes save automatically — submit when you’re ready, then prompt the agent to pick them up.',
            'info'
          );
        }
      }
      if (body && typeof body.rev === 'number' && bootRev !== null && body.rev !== bootRev && !submitted && !reloading) {
        // Don't yank the board out from under someone mid-comment: an open
        // annotation popover (its add-comment box + reply inputs) holds text
        // that isn't in the draft until Save, so a reload would discard it —
        // and reloading while any field is focused drops the user's cursor and
        // last keystrokes. Defer until they're done; the heartbeat re-checks
        // every tick, so the update applies the moment they close/blur.
        if (userIsComposing()) {
          showNotice('The agent updated this board — it’ll refresh as soon as you finish your comment.', 'info');
          return;
        }
        reloading = true;
        stopHeartbeat();
        clearTimeout(saveTimer);
        try {
          await saveDraft();
        } catch {
          // a failed final save shouldn't block the reload to the new spec
        }
        try {
          sessionStorage.setItem('relay-updated', '1');
        } catch {
          // sessionStorage may be unavailable — the reload still applies the update
        }
        location.reload();
        return;
      }
      if (body && typeof body.draftRev === 'number' && body.draftRev > seenDraftRev && !submitted && !reloading) {
        if (userIsComposing()) {
          showNotice('Another viewer updated this board — it’ll refresh as soon as you finish typing.', 'info');
          return;
        }
        reloading = true;
        stopHeartbeat();
        clearTimeout(saveTimer);
        clearLocalDraft();
        try {
          sessionStorage.setItem('relay-draft-updated', '1');
        } catch {
          // sessionStorage may be unavailable — the reload still applies the update
        }
        location.reload();
      }
    } catch {
      // Lost the live connection (the session ended, or the machine slept). Two
      // consecutive misses means the local server is unreachable — so input can
      // no longer be persisted. Hard-block: disable editing and overlay the
      // unmissable "connection lost" scrim, so the user can't keep typing
      // feedback that would be silently discarded. The block re-arms its own
      // probe loop and the heartbeat recovers it once the server answers again.
      if (++misses >= 2 && !submitted && !persistenceLost) {
        handedBack = true;
        stopHeartbeat();
        // force=true: two heartbeat misses already confirm the server is gone,
        // so block immediately without a redundant probe.
        considerPersistenceLost(true);
        // While blocked, keep probing so an automatic recovery (server back,
        // machine woke) lifts the block even if the user never clicks Retry.
        startBlockedProbeLoop();
      }
    }
  }
  function startHeartbeat() {
    if (hb || submitted) return;
    hb = setInterval(heartbeatTick, 3000);
  }
  function stopHeartbeat() {
    if (hb) clearInterval(hb);
    hb = null;
  }

  // While blocked, the heartbeat is stopped — so run a lightweight probe loop
  // that lifts the block automatically the moment the server is reachable again
  // (no Retry click needed). Stops itself on recovery or after submit.
  let blockedProbe = null;
  function startBlockedProbeLoop() {
    if (blockedProbe) return;
    blockedProbe = setInterval(async () => {
      if (!persistenceLost || submitted) {
        clearInterval(blockedProbe);
        blockedProbe = null;
        return;
      }
      if (probing) return;
      probing = true;
      const ok = await probeServer();
      probing = false;
      if (ok) {
        clearInterval(blockedProbe);
        blockedProbe = null;
        unblockAfterRecovery();
      }
    }, 3000);
  }
  startHeartbeat();
