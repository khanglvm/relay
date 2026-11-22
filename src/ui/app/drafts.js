  // ---------- localStorage draft mirror ----------
  // Every autosave is ALSO written to localStorage, keyed by board id + access
  // role/session. This keeps a reviewer side draft from leaking into a
  // collaborator/read-only tab on the same LAN origin.
  // the durability layer the server file alone can't provide: if the connection
  // drops and the user keeps typing, the in-memory state is mirrored locally, so
  // even a tab reload / browser restart / a freshly opened tab on the same board
  // prefills the LATEST input instead of a blank board or a stale server save.
  // Guards (per design): newest-of-(local,server) wins; the mirror is discarded
  // if the board's spec rev changed (agent edited it); cleared on submit.
  const LOCAL_DRAFT_KEY = 'relay-draft-' + (boot.boardId || 'unknown') + '-' +
    (access.role || 'owner') + (access.reviewSessionId ? '-' + access.reviewSessionId : '');
  function writeLocalDraft(p, updatedAt) {
    try {
      localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify({
        v: 1,
        boardId: boot.boardId,
        rev: bootRev,
        updatedAt: updatedAt || new Date().toISOString(),
        payload: p,
      }));
    } catch {
      // localStorage may be full or unavailable (privacy mode) — non-fatal; the
      // server file remains the primary persistence path.
    }
  }
  function clearLocalDraft() {
    try { localStorage.removeItem(LOCAL_DRAFT_KEY); } catch { /* non-fatal */ }
  }
  // Returns the saved local mirror only if it's valid for THIS board+rev,
  // otherwise null (and clears a now-stale entry). rev mismatch ⇒ the agent
  // re-published the board, so old local answers may not map — discard them.
  function loadLocalDraft() {
    let raw;
    try { raw = localStorage.getItem(LOCAL_DRAFT_KEY); } catch { return null; }
    if (!raw) return null;
    let obj;
    try { obj = JSON.parse(raw); } catch { clearLocalDraft(); return null; }
    if (!obj || obj.boardId !== boot.boardId || !obj.payload || typeof obj.payload !== 'object') {
      clearLocalDraft();
      return null;
    }
    // rev-guard: a changed spec rev means the local answers may reference a
    // different question set — don't resurrect them.
    if (bootRev !== null && obj.rev !== undefined && obj.rev !== null && obj.rev !== bootRev) {
      clearLocalDraft();
      return null;
    }
    return obj;
  }

  // Choose the prefill source: the NEWER of the server draft (boot.prefill) and
  // the local mirror. The server draft shape mirrors a payload() plus updatedAt.
  function chooseInitialPrefill() {
    const server = boot.prefill || null;
    const local = loadLocalDraft();
    if (!local) return server;
    if (!server) return { ...local.payload, __from: 'local' };
    const sT = Date.parse(server.updatedAt || '') || 0;
    const lT = Date.parse(local.updatedAt || '') || 0;
    // Newest wins; ties favor local (the tab that was last typing into).
    return lT >= sT ? { ...local.payload, __from: 'local' } : server;
  }
  const initialPrefill = chooseInitialPrefill();

  // ---------- state ----------
  // state.answers holds raw control state; state.other holds the "Other"
  // free-text per question; getValue() derives the final answer value.
  // state.annotations holds element-level comments (managed by RelayAnnotate).
  const state = {
    answers: {},
    other: {},
    notes: {},
    comment: '',
    annotations: (initialPrefill && initialPrefill.annotations) || [],
    // Editable-mermaid edits: blockId -> edited source. Seeded from the live
    // draft so a reload/reopen restores the user's edited diagram. Mutated via
    // the blocks ctx.onBlockEdit callback below; returned in payload().
    blockEdits: (initialPrefill && initialPrefill.blockEdits) || {},
  };
  let submitted = false;

  function seedFromPrefill(prefill) {
    state.comment = prefill.comment || '';
    if (prefill.notes && typeof prefill.notes === 'object') state.notes = { ...prefill.notes };
    const ans = prefill.answers || {};
    for (const q of QS) {
      const v = ans[q.id];
      if (v === undefined || v === null) continue;
      if (q.type === 'multi' && Array.isArray(v)) {
        const known = new Set((q.options || []).map((o) => o.value));
        state.answers[q.id] = v.filter((x) => known.has(x));
        const extra = v.filter((x) => !known.has(x));
        if (extra.length && q.other) state.other[q.id] = { on: true, text: extra.join(', ') };
      } else if (q.type === 'single' && typeof v === 'string') {
        if ((q.options || []).some((o) => o.value === v)) state.answers[q.id] = v;
        else if (q.other) state.other[q.id] = { on: true, text: v };
      } else {
        state.answers[q.id] = v;
      }
    }
  }
  // Coerce any prior rank value (draft/default) into a complete, deduped
  // permutation of the option values: keep the known ones in their given order,
  // then append any options the prior list missed (in authored order).
  function seedRankOrder(q, prior) {
    const opts = (q.options || []).map((o) => o.value);
    const arr = Array.isArray(prior) ? prior : [];
    const order = arr.filter((v, i) => opts.includes(v) && arr.indexOf(v) === i);
    for (const v of opts) if (!order.includes(v)) order.push(v);
    return order;
  }
  // Allocate: a complete map {optionValue: number≥0}, seeded from a prior/default.
  function seedAllocate(q, prior) {
    const m = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
    const out = {};
    for (const o of q.options || []) out[o.value] = Math.max(0, Number(m[o.value]) || 0);
    return out;
  }
  // Checklist: keep only {knownOption: knownStatus} entries from a prior/default.
  function seedChecklist(q, prior) {
    const m = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
    const optVals = new Set((q.options || []).map((o) => o.value));
    const stVals = new Set((q.statuses || []).map((s) => s.value));
    const out = {};
    for (const k of Object.keys(m)) if (optVals.has(k) && stVals.has(m[k])) out[k] = m[k];
    return out;
  }

  if (initialPrefill) seedFromPrefill(initialPrefill);
  else for (const q of QS) if (q.default !== undefined) state.answers[q.id] = q.default;
  // Rank questions always carry a full, valid permutation of their option values
  // (from a draft/default if present, else the authored order), so a never-touched
  // rank still returns a meaningful ordering.
  for (const q of QS) if (q.type === 'rank') state.answers[q.id] = seedRankOrder(q, state.answers[q.id]);
  for (const q of QS) if (q.type === 'allocate') state.answers[q.id] = seedAllocate(q, state.answers[q.id]);
  for (const q of QS) if (q.type === 'checklist') state.answers[q.id] = seedChecklist(q, state.answers[q.id]);
  for (const q of QS) if (q.type === 'pick') state.answers[q.id] = window.RelayPick.seed(q, state.answers[q.id]);
  // If the local mirror was newer than the server (or the server had nothing),
  // the in-memory state now holds input the server hasn't seen — flush it once
  // the rest of the app is wired (see the post-init flush near the heartbeat).

  function getValue(q) {
    const v = state.answers[q.id];
    const oth = state.other[q.id];
    switch (q.type) {
      case 'single': {
        if (oth && oth.on) {
          const t = (oth.text || '').trim();
          return t || undefined;
        }
        return typeof v === 'string' && v ? v : undefined;
      }
      case 'multi': {
        const arr = Array.isArray(v) ? [...v] : [];
        if (oth && oth.on) {
          const t = (oth.text || '').trim();
          if (t) arr.push(t);
        }
        return arr.length ? arr : undefined;
      }
      case 'yesno':
        return v === 'yes' || v === 'no' ? v : undefined;
      case 'scale':
        return typeof v === 'number' ? v : undefined;
      case 'rank':
        // always a full, valid permutation (seeded below) → always answered
        return Array.isArray(v) && v.length ? [...v] : undefined;
      case 'checklist': {
        const m = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        return Object.keys(m).length ? { ...m } : undefined;
      }
      case 'allocate': {
        const m = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        const sum = Object.values(m).reduce((a, n) => a + (Number(n) || 0), 0);
        return sum > 0 ? { ...m } : undefined;
      }
      case 'pick':
        return window.RelayPick.value(q, v);
      default: {
        const t = typeof v === 'string' ? v.trim() : '';
        return t || undefined;
      }
    }
  }

  function payload() {
    const answers = {};
    const notes = {};
    for (const q of QS) {
      const v = getValue(q);
      if (v !== undefined) answers[q.id] = v;
      const n = typeof state.notes[q.id] === 'string' ? state.notes[q.id].trim() : '';
      if (n) notes[q.id] = n;
    }
    return {
      answers,
      comment: (state.comment || '').trim(),
      notes,
      annotations: state.annotations,
      blockEdits: state.blockEdits,
    };
  }

