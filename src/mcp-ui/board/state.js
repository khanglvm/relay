  // ======================================================================
  // board state + answer controls (ported from the browser board)
  // ======================================================================
  let spec = null;
  let QS = [];
  const state = { answers: {}, other: {}, notes: {}, comment: '', blockEdits: {}, annotations: [] };
  // Element-level comments: the SAME self-contained annotate engine the browser
  // board uses (no server — it reports the thread list via onChange). Charts,
  // diagram nodes, table cells, images and text selections become commentable;
  // the comments ride back in the submission alongside answers.
  const Annotate = (window.RelayAnnotate && typeof window.RelayAnnotate.init === 'function') ? window.RelayAnnotate : null;
  let submitted = false;
  const cards = {};
  const app = document.getElementById('app');

  // ---------- display mode (host-driven) ----------
  // GUI hosts (Claude, Codex) render their OWN full-screen control, so relay
  // adds no redundant button. We still declare fullscreen support in
  // ui/initialize and react to the host's mode change: in fullscreen the iframe
  // fills the window, so we center the content to a readable column.
  let displayMode = 'inline';
  function applyDisplayMode() {
    document.documentElement.classList.toggle('mcp-fullscreen', displayMode === 'fullscreen');
    reportSize();
  }

  function seedDefaults() {
    for (const q of QS) if (q.default !== undefined) state.answers[q.id] = q.default;
    // Rank questions carry a full, valid permutation so an untouched rank still
    // submits a meaningful order (mirrors the browser board's seedRankOrder).
    for (const q of QS) {
      if (q.type !== 'rank') continue;
      const opts = (q.options || []).map((o) => o.value);
      const prior = Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [];
      const order = prior.filter((v, i) => opts.includes(v) && prior.indexOf(v) === i);
      for (const v of opts) if (!order.includes(v)) order.push(v);
      state.answers[q.id] = order;
    }
    for (const q of QS) if (q.type === 'allocate') state.answers[q.id] = seedAllocate(q, state.answers[q.id]);
    for (const q of QS) if (q.type === 'checklist') state.answers[q.id] = seedChecklist(q, state.answers[q.id]);
  }
  function seedAllocate(q, prior) {
    const m = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
    const out = {};
    for (const o of q.options || []) out[o.value] = Math.max(0, Number(m[o.value]) || 0);
    return out;
  }
  function seedChecklist(q, prior) {
    const m = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
    const optVals = new Set((q.options || []).map((o) => o.value));
    const stVals = new Set((q.statuses || []).map((s) => s.value));
    const out = {};
    for (const k of Object.keys(m)) if (optVals.has(k) && stVals.has(m[k])) out[k] = m[k];
    return out;
  }

  function getValue(q) {
    const v = state.answers[q.id];
    const oth = state.other[q.id];
    switch (q.type) {
      case 'single': {
        if (oth && oth.on) { const t = (oth.text || '').trim(); return t || undefined; }
        return typeof v === 'string' && v ? v : undefined;
      }
      case 'multi': {
        const arr = Array.isArray(v) ? [...v] : [];
        if (oth && oth.on) { const t = (oth.text || '').trim(); if (t) arr.push(t); }
        return arr.length ? arr : undefined;
      }
      case 'yesno':
        return v === 'yes' || v === 'no' ? v : undefined;
      case 'scale':
        return typeof v === 'number' ? v : undefined;
      case 'rank':
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
    const skipped = QS.filter((q) => !(q.id in answers)).map((q) => q.id);
    const blockEdits = Object.keys(state.blockEdits).length ? state.blockEdits : null;
    const annotations = Array.isArray(state.annotations) && state.annotations.length ? state.annotations : null;
    return { answers, skipped, comment: (state.comment || '').trim(), notes, blockEdits, annotations };
  }

