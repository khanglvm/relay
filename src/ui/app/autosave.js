  // ---------- real-time autosave ----------
  let saveTimer = null;
  let saveSeq = 0;
  let saveEl = null;
  // Consecutive failed /api/draft saves. Two in a row triggers a confirming
  // probe → block. Any success resets it.
  let saveFailures = 0;
  function scheduleSave() {
    if (submitted || !canPersistFeedback) return;
    // Mirror to localStorage SYNCHRONOUSLY on every edit, before (and regardless
    // of) the network save. This is what survives a tab reload / crash / a new
    // tab during a connection outage — it must happen even while blocked.
    writeLocalDraft(payload());
    if (persistenceLost) return; // network save is futile while disconnected
    if (saveEl) saveEl.textContent = 'saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 450);
  }
  async function saveDraft() {
    if (!canPersistFeedback) return;
    const seq = ++saveSeq;
    // Keep the local mirror current on every flush too (covers programmatic
    // saveDraft() calls that don't go through scheduleSave, e.g. recovery flush).
    writeLocalDraft(payload());
    try {
      const r = await fetch('/api/draft', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload()),
      });
      if (!r.ok) throw new Error('draft rejected');
      const body = await r.json().catch(() => null);
      if (body && typeof body.draftRev === 'number') seenDraftRev = body.draftRev;
      saveFailures = 0;
      if (seq === saveSeq && saveEl && !submitted && !persistenceLost) saveEl.textContent = 'draft saved ✓';
    } catch {
      if (seq === saveSeq && saveEl && !submitted && !persistenceLost) saveEl.textContent = 'draft save failed';
      // A save couldn't be persisted to the SERVER — the core data-loss signal.
      // (The local mirror above still captured it.) After two in a row, confirm
      // with a probe and block so the user stops typing into the void.
      if (++saveFailures >= 2) considerPersistenceLost(false);
    }
  }

