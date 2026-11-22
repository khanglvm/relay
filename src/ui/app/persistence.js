  // ---------- persistence-lost block ----------
  // The dead-end this guards against: the client can lose its connection to the
  // board's local HTTP server (server gone, port taken over, socket dropped,
  // machine slept). Autosaves then fail silently and the user keeps typing
  // answers/comments that are never persisted, then Submit fails too — all of it
  // thrown away. When persistence is CONFIRMED lost we DISABLE every control (and
  // freeze new comments) and show a small, non-dismissable top-right notice with
  // a Reconnect button — without blocking the page, so the user can still read
  // and scroll. Local `state` is never touched, and a mid-typed comment is saved
  // before the freeze, so nothing the user entered during the outage is lost; the
  // moment the connection recovers we flush state and re-enable everything.
  let persistenceLost = false;
  let probing = false;
  let lostNote = null;
  let lostRetryBtn = null;

  // A direct, side-effect-free reachability probe. Resolves true when the local
  // server answers /api/status, false on any network/HTTP failure. Used to
  // CONFIRM loss before blocking (so a single dropped request never blocks) and
  // to detect recovery from the Retry button / heartbeat.
  async function probeServer() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store', headers: authHeaders() });
      return r.ok;
    } catch {
      return false;
    }
  }

  function buildLostNote() {
    if (lostNote) return lostNote;
    lostRetryBtn = el('button', { class: 'lost-retry', type: 'button' }, 'Reconnect');
    lostRetryBtn.addEventListener('click', retryConnection);
    lostNote = el('div', { class: 'lost-note', role: 'status', 'aria-live': 'polite' },
      el('span', { class: 'lost-note-dot', 'aria-hidden': 'true' }),
      el('div', { class: 'lost-note-body' },
        el('div', { class: 'lost-note-title' }, 'Connection lost'),
        el('div', { class: 'lost-note-sub' }, 'Editing paused — your input is kept.')
      ),
      lostRetryBtn
    );
    return lostNote;
  }

  // Enter the blocked state: save a mid-typed comment, freeze comments, disable
  // controls, and pin the small notice. Idempotent. Does NOT block the page —
  // the user can still read and scroll; only editing is paused.
  function blockForLostPersistence() {
    if (persistenceLost || submitted) return;
    persistenceLost = true;
    document.documentElement.classList.add('relay-blocked');
    // Save whatever the user was typing into the comment popover BEFORE freezing
    // it, so the in-progress comment is kept (in `state` + localStorage) instead
    // of discarded; then stop any new comment from being started.
    if (Annotate) {
      if (typeof Annotate.flushOpen === 'function') { try { Annotate.flushOpen(); } catch { /* non-fatal */ } }
      if (typeof Annotate.setDisabled === 'function') { try { Annotate.setDisabled(true); } catch { /* non-fatal */ } }
    }
    // Disable every interactive control inside the form. Values already entered
    // stay in the DOM (and in `state`), so nothing typed so far is lost.
    for (const node of app.querySelectorAll('input, textarea, button, select')) {
      node.disabled = true;
    }
    document.body.append(buildLostNote());
    if (saveEl) saveEl.textContent = 'connection lost — not saving';
  }

  // Leave the blocked state: re-enable controls + comments, drop the notice, and
  // flush whatever the user typed during the outage so it's persisted right away.
  function unblockAfterRecovery() {
    if (!persistenceLost) return;
    persistenceLost = false;
    document.documentElement.classList.remove('relay-blocked');
    if (Annotate && typeof Annotate.setDisabled === 'function') { try { Annotate.setDisabled(false); } catch { /* non-fatal */ } }
    for (const node of app.querySelectorAll('input, textarea, button, select')) {
      node.disabled = false;
    }
    applyAccessRestrictions();
    if (lostNote) lostNote.remove();
    // Re-arm the heartbeat (it stops itself when it confirms loss) and persist
    // everything typed during the outage. saveDraft() updates the save label.
    startHeartbeat();
    misses = 0;
    saveFailures = 0;
    saveDraft();
  }

  // Retry button: probe once; recover on success, otherwise tell the user it's
  // still down (without un-blocking).
  async function retryConnection() {
    if (probing) return;
    probing = true;
    if (lostRetryBtn) { lostRetryBtn.disabled = true; lostRetryBtn.textContent = 'Checking…'; }
    const ok = await probeServer();
    probing = false;
    if (lostRetryBtn) { lostRetryBtn.disabled = false; lostRetryBtn.textContent = 'Retry connection'; }
    if (ok) unblockAfterRecovery();
    else if (lostRetryBtn) {
      lostRetryBtn.textContent = 'Still unreachable — try again';
      setTimeout(() => { if (lostRetryBtn && persistenceLost) lostRetryBtn.textContent = 'Retry connection'; }, 2500);
    }
  }

  // Called when a save/heartbeat fails. Confirms loss with a probe (so one
  // dropped request never blocks) before hard-blocking. `force` skips the probe
  // for callers (the heartbeat) that already represent repeated failures.
  async function considerPersistenceLost(force) {
    if (persistenceLost || submitted || probing) return;
    if (!force) {
      probing = true;
      const ok = await probeServer();
      probing = false;
      if (ok || persistenceLost || submitted) return; // recovered or already handled
    }
    blockForLostPersistence();
  }

