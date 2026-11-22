  // ---------- validation & submit ----------
  function validate() {
    let firstBad = null;
    for (const q of QS) {
      const required = q.required || !spec.allowPartial;
      const bad = required && (getValue(q) === undefined || (q.type === 'pick' && window.RelayPick.short(q, state.answers[q.id])));
      cards[q.id].classList.toggle('error', bad);
      if (bad && !firstBad) firstBad = cards[q.id];
    }
    if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return !firstBad;
  }

  function showDone(closing, sideReview = false) {
    stopHeartbeat();
    // Annotation pins/badges/popover float on <body> with elevated z-index —
    // remove them so they don't leak over the submitted screen.
    if (window.RelayAnnotate && typeof RelayAnnotate.teardown === 'function') {
      try {
        RelayAnnotate.teardown();
      } catch {
        // best effort
      }
    }
    // If the agent already stopped waiting (soft timeout / dropped connection),
    // the submission won't be picked up automatically — tell the user to nudge
    // the agent. Otherwise the normal hand-back copy applies.
    const note = sideReview
      ? 'Saved for reference. This did not finalize the board or notify the waiting agent; the owner still needs to submit the final answer.'
      : handedBack
      ? 'Saved. Your agent had stopped waiting — send it a message so it picks up your answers.'
      : closing
        ? 'Handing back to your agent — this tab will close itself…'
        : 'Handed back to your agent. You can close this tab.';
    app.replaceChildren(
      el('div', { class: 'done' },
        el('div', { class: 'mark' }, '✓'),
        el('h2', {}, sideReview ? 'Side review saved' : QS.length ? 'Submitted' : 'Acknowledged'),
        el('p', { id: 'done-note' }, note)
      )
    );
  }

  submitBtn.addEventListener('click', async () => {
    if (!validate()) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    clearTimeout(saveTimer);
    let reached = true;
    try {
      let res;
      try {
        res = await fetch('/api/submit', {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify(payload()),
        });
      } catch (netErr) {
        // A thrown fetch (vs. an HTTP error response) means we never reached the
        // server — the connection is gone, so this submit was never delivered.
        reached = false;
        throw netErr;
      }
      if (!res.ok) throw new Error('submit rejected');
      const submitResult = await res.json().catch(() => null);
      const sideReview = Boolean(submitResult && submitResult.sideReview === true && submitResult.final === false);
      submitted = true;
      // Submitted successfully → the local mirror is no longer needed and would
      // otherwise resurrect stale answers on a future reopen. Clear it.
      clearLocalDraft();
      // Don't auto-close when the agent had stopped waiting — the user needs to
      // read the "send your agent a message" note and act on it.
      const autoClose = !sideReview && spec.autoClose && !handedBack;
      showDone(autoClose, sideReview);
      if (autoClose) {
        setTimeout(() => {
          window.close();
          // window.close() is best-effort (browsers may block it for
          // user-opened tabs) — fall back to the "close this tab" note.
          setTimeout(() => {
            const note = document.getElementById('done-note');
            if (note) note.textContent = 'Handed back to your agent. You can close this tab.';
          }, 400);
        }, 700);
      }
    } catch {
      // Restore the button so the user can retry.
      submitBtn.disabled = false;
      submitBtn.textContent = access.role === 'review' ? 'Submit side review' : spec.submitLabel;
      if (!reached) {
        // The connection is gone — the submit (and any further input) can't be
        // persisted. Block hard so the user stops adding feedback that would be
        // lost; the block's probe loop / heartbeat lifts it on recovery, and the
        // user can then submit. force=true: the failed submit already confirms
        // the server is unreachable.
        stopHeartbeat();
        considerPersistenceLost(true);
        startBlockedProbeLoop();
      } else {
        // The server answered with an error (e.g. 409 board already finished) —
        // it's reachable, so don't show the scary block; just guide the user.
        showNotice(
          'Couldn’t submit — the board may have already closed. Prompt the agent to reopen this board so your input isn’t lost.',
          'warn'
        );
      }
    }
  });

