  // ---------- presence / awareness ----------
  // Track the last time the user interacted with the page so the agent (via
  // /api/presence) can tell whether someone is still actively viewing the board
  // and keep waiting instead of timing out. Every existing 3s heartbeat tick
  // also POSTs /api/ping {visible, focused, idleMs}; pinging stops after submit.
  let lastInteractionAt = Date.now();
  let lastMoveAt = 0;
  function noteInteraction() {
    lastInteractionAt = Date.now();
  }
  window.addEventListener('pointerdown', noteInteraction, { passive: true });
  window.addEventListener('keydown', noteInteraction, { passive: true });
  window.addEventListener('scroll', noteInteraction, { passive: true });
  window.addEventListener('touchstart', noteInteraction, { passive: true });
  // pointermove fires continuously — throttle to at most once per second.
  window.addEventListener('pointermove', () => {
    const now = Date.now();
    if (now - lastMoveAt >= 1000) {
      lastMoveAt = now;
      lastInteractionAt = now;
    }
  }, { passive: true });

  function pingPresence() {
    if (submitted) return;
    fetch('/api/ping', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        visible: !document.hidden,
        focused: document.hasFocus(),
        idleMs: Date.now() - lastInteractionAt,
      }),
    }).catch(() => {
      // presence is best-effort — a failed ping must never surface to the user
    });
  }

