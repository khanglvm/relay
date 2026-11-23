  // ======================================================================
  // draft restore: the answers the person had entered before the board was reloaded
  // ======================================================================
  // Mirrors the browser board's seedFromPrefill (ui/app/drafts.js): an answer that
  // matches no option goes back into the "Other" field, and one for a question the
  // agent has since removed is dropped.
  function restoreDraft(draft) {
    if (!draft || typeof draft !== 'object') return;
    state.comment = typeof draft.comment === 'string' ? draft.comment : '';
    if (draft.notes && typeof draft.notes === 'object') state.notes = { ...draft.notes };
    if (draft.blockEdits && typeof draft.blockEdits === 'object') state.blockEdits = { ...draft.blockEdits };
    state.annotations = Array.isArray(draft.annotations) ? draft.annotations : [];
    const saved = draft.answers && typeof draft.answers === 'object' ? draft.answers : {};
    for (const q of QS) {
      const v = saved[q.id];
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
    completeAnswers();
  }
