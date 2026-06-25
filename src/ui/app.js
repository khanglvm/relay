(() => {
  'use strict';

  const boot = JSON.parse(document.getElementById('boot').textContent);
  const spec = boot.spec;
  const QS = spec.questions || [];
  const app = document.getElementById('app');
  const banner = document.getElementById('banner');
  // Live-update baseline: the server's rev at page-build time. The heartbeat
  // compares /api/status.rev to this and reloads the board when it advances
  // (an agent ran `rly update`).
  const bootRev = typeof boot.rev === 'number' ? boot.rev : null;

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(c));
    }
    return n;
  }

  // Small, self-dismissing toast pinned to the top-center of the viewport.
  // Used to flag a live `rly update` after the reload (accent-soft bg).
  function showToast(message) {
    const toast = el('div', { class: 'toast' }, message);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // True once the board has soft-timed-out (the agent stopped waiting) or the
  // live connection dropped — used to tailor the post-submit message. The board
  // stays fully usable either way; we never disable Submit.
  let handedBack = false;
  // Calm, persistent status note (reuses the #banner bar). tone 'info' is the
  // default neutral style; 'warn' is a softer amber, NOT the old red error.
  // Shown at most once per message so the heartbeat can call it every tick.
  const notesShown = new Set();
  function showNotice(message, tone) {
    if (notesShown.has(message)) return;
    notesShown.add(message);
    banner.textContent = message;
    banner.className = 'banner ' + (tone === 'warn' ? 'warn' : 'info');
    banner.style.display = 'block';
  }

  // ---------- theme (auto -> light -> dark) ----------
  // Server-side pref wins: boards run on random ports, so localStorage alone
  // can't carry the choice across boards. The server persists it globally.
  const THEME_KEY = 'qb-theme';
  const THEMES = ['auto', 'light', 'dark'];
  let theme = (boot.pref && boot.pref.theme) || localStorage.getItem(THEME_KEY);
  if (!THEMES.includes(theme)) theme = 'auto';
  function effectiveTheme() {
    if (theme !== 'auto') return theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme() {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    if (themeBtn) themeBtn.textContent = { auto: '◐ auto', light: '☀ light', dark: '☾ dark' }[theme];
    // Custom-HTML iframes get ?theme=light|dark so authors can match the theme.
    for (const f of document.querySelectorAll('iframe.viz')) {
      try {
        const u = new URL(f.src);
        if (u.searchParams.get('theme') !== effectiveTheme()) {
          u.searchParams.set('theme', effectiveTheme());
          f.src = u.toString();
        }
      } catch {
        // ignore malformed src
      }
    }
    // Re-theme native blocks (mermaid re-render, chart grid/tick restyle).
    if (window.RelayBlocks && typeof RelayBlocks.onThemeChange === 'function') {
      try {
        RelayBlocks.onThemeChange(effectiveTheme());
      } catch {
        // blocks may not be rendered yet
      }
    }
  }
  let themeBtn = null;

  // ---------- font scale (A− / A+) ----------
  // A page-zoom knob: scales the root font-size (every rem) so the whole board
  // grows/shrinks. Persists like the theme — server pref + localStorage mirror —
  // so the choice carries across the random-port boards.
  const FS_KEY = 'qb-fontscale';
  const FS_MIN = 0.85, FS_MAX = 1.5, FS_STEP = 0.1;
  let fontScale = Number((boot.pref && boot.pref.fontScale) || localStorage.getItem(FS_KEY));
  if (!Number.isFinite(fontScale) || fontScale <= 0) fontScale = 1;
  const clampFs = (n) => Math.min(FS_MAX, Math.max(FS_MIN, Math.round(n * 100) / 100));
  fontScale = clampFs(fontScale);
  function applyFontScale() {
    document.documentElement.style.setProperty('--fs', String(fontScale));
  }
  function setFontScale(next) {
    fontScale = clampFs(next);
    applyFontScale();
    try { localStorage.setItem(FS_KEY, String(fontScale)); } catch { /* private mode */ }
    fetch('/api/pref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fontScale }),
    }).catch(() => {});
  }
  applyFontScale();

  // ---------- localStorage draft mirror ----------
  // Every autosave is ALSO written to localStorage, keyed by board id. This is
  // the durability layer the server file alone can't provide: if the connection
  // drops and the user keeps typing, the in-memory state is mirrored locally, so
  // even a tab reload / browser restart / a freshly opened tab on the same board
  // prefills the LATEST input instead of a blank board or a stale server save.
  // Guards (per design): newest-of-(local,server) wins; the mirror is discarded
  // if the board's spec rev changed (agent edited it); cleared on submit.
  const LOCAL_DRAFT_KEY = 'relay-draft-' + (boot.boardId || 'unknown');
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
  if (initialPrefill) seedFromPrefill(initialPrefill);
  else for (const q of QS) if (q.default !== undefined) state.answers[q.id] = q.default;
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

  // ---------- persistence-lost block ----------
  // The dead-end this guards against: the client can lose its connection to the
  // board's local HTTP server (server gone, port taken over, socket dropped,
  // machine slept). Autosaves then fail silently and the user keeps typing
  // answers/comments that are never persisted, then Submit fails too — all of it
  // thrown away. When persistence is CONFIRMED lost we hard-block: disable every
  // control and overlay an unmissable scrim with a Retry. Local `state` is never
  // touched, so the moment the connection recovers we flush it and unblock —
  // nothing the user typed during the outage is lost.
  let persistenceLost = false;
  let probing = false;
  let lostOverlay = null;
  let lostRetryBtn = null;

  // A direct, side-effect-free reachability probe. Resolves true when the local
  // server answers /api/status, false on any network/HTTP failure. Used to
  // CONFIRM loss before blocking (so a single dropped request never blocks) and
  // to detect recovery from the Retry button / heartbeat.
  async function probeServer() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  }

  function buildLostOverlay() {
    if (lostOverlay) return lostOverlay;
    lostRetryBtn = el('button', { class: 'lost-retry', type: 'button' }, 'Retry connection');
    lostRetryBtn.addEventListener('click', retryConnection);
    lostOverlay = el('div', { class: 'lost-overlay', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Connection lost' },
      el('div', { class: 'lost-card' },
        el('div', { class: 'lost-mark' }, '⚠'),
        el('h2', {}, 'Connection lost — input isn’t being saved'),
        el('p', {}, 'This board can no longer reach your agent’s session, so anything you type now won’t be saved. Editing is paused to keep you from losing work.'),
        el('p', { class: 'lost-sub' }, 'Your input up to this point is kept in this tab. Click Retry once the agent’s session is back, or prompt the agent to reopen this board — your draft and unsaved edits will be restored.'),
        lostRetryBtn
      )
    );
    return lostOverlay;
  }

  // Enter the blocked state: disable controls, mount the overlay. Idempotent.
  function blockForLostPersistence() {
    if (persistenceLost || submitted) return;
    persistenceLost = true;
    document.documentElement.classList.add('relay-blocked');
    // Disable every interactive control inside the form (inputs the user could
    // otherwise keep typing into) plus Submit.
    for (const node of app.querySelectorAll('input, textarea, button, select')) {
      node.disabled = true;
    }
    document.body.append(buildLostOverlay());
    if (saveEl) saveEl.textContent = 'connection lost — not saving';
  }

  // Leave the blocked state: re-enable controls, remove the overlay, and flush
  // whatever the user typed during the outage so it's persisted right away.
  function unblockAfterRecovery() {
    if (!persistenceLost) return;
    persistenceLost = false;
    document.documentElement.classList.remove('relay-blocked');
    for (const node of app.querySelectorAll('input, textarea, button, select')) {
      node.disabled = false;
    }
    if (lostOverlay) lostOverlay.remove();
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

  // ---------- real-time autosave ----------
  let saveTimer = null;
  let saveSeq = 0;
  let saveEl = null;
  // Consecutive failed /api/draft saves. Two in a row triggers a confirming
  // probe → block. Any success resets it.
  let saveFailures = 0;
  function scheduleSave() {
    if (submitted) return;
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
    const seq = ++saveSeq;
    // Keep the local mirror current on every flush too (covers programmatic
    // saveDraft() calls that don't go through scheduleSave, e.g. recovery flush).
    writeLocalDraft(payload());
    try {
      const r = await fetch('/api/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      if (!r.ok) throw new Error('draft rejected');
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        visible: !document.hidden,
        focused: document.hasFocus(),
        idleMs: Date.now() - lastInteractionAt,
      }),
    }).catch(() => {
      // presence is best-effort — a failed ping must never surface to the user
    });
  }

  // ---------- annotations ----------
  // RelayAnnotate owns the live annotation list; mirror it into state on every
  // change so payload()/autosave/submit carry it exactly like answers.
  const Annotate = typeof window.RelayAnnotate !== 'undefined' ? window.RelayAnnotate : null;
  if (Annotate) {
    Annotate.init({
      initial: state.annotations,
      onChange: (list) => {
        state.annotations = list;
        scheduleSave();
        // Refresh per-element comment badges inside custom-HTML iframes (bridge
        // sets this once the iframe annotate plumbing is wired below).
        if (window.__relayBroadcastCounts) window.__relayBroadcastCounts();
      },
    });
  }

  // Editable-mermaid: record (or clear) the user's edit for a block, then
  // autosave. A null/empty code clears the entry (block matches the original
  // again — e.g. after Reset), so payload()/draft carry only real divergences.
  function onBlockEdit(blockId, codeOrNull) {
    if (codeOrNull === null || codeOrNull === undefined) delete state.blockEdits[blockId];
    else state.blockEdits[blockId] = codeOrNull;
    scheduleSave();
  }

  // ctx for RelayBlocks.render — theme()/htmlSrc per the shared contract, plus
  // the editable-mermaid plumbing (edits map + onBlockEdit callback).
  function blockCtx(questionId) {
    return {
      theme: effectiveTheme,
      htmlSrc: (blockId) => '/html/b/' + encodeURIComponent(blockId) + '?theme=' + effectiveTheme(),
      questionId: questionId == null ? null : questionId,
      annotate: Annotate,
      edits: state.blockEdits,
      onBlockEdit,
    };
  }

  // Renders blocks async without blocking the page; on rejection (or a missing
  // RelayBlocks) shows a muted "failed to render" card in place.
  function renderBlocks(container, blocks, questionId) {
    if (!Array.isArray(blocks) || !blocks.length) return;
    const target = el('div', { class: 'blocks' });
    container.append(target);
    if (typeof window.RelayBlocks === 'undefined' || !window.RelayBlocks) {
      target.append(el('div', { class: 'blk' }, el('div', { class: 'blk-error' }, 'block failed to render')));
      return;
    }
    Promise.resolve()
      .then(() => window.RelayBlocks.render(target, blocks, blockCtx(questionId)))
      .catch(() => {
        target.append(el('div', { class: 'blk' }, el('div', { class: 'blk-error' }, 'block failed to render')));
      });
  }

  // ---------- controls ----------
  const cards = {};

  function clearErr(qid) {
    if (cards[qid]) cards[qid].classList.remove('error');
  }

  function syncOptSel(group) {
    for (const lab of group.querySelectorAll('label.opt')) {
      const input = lab.querySelector('input');
      lab.classList.toggle('sel', input.checked);
      // options with visuals: the bordered card is the wrapper, not the label
      const wrap = lab.closest('.optwrap');
      if (wrap) wrap.classList.toggle('sel', input.checked);
    }
  }

  // Options may carry their own blocks (visual examples of the choice). The
  // blocks render in a wrapper card OUTSIDE the <label> so interacting with a
  // chart/diagram/image doesn't toggle the option.
  function withOptionBlocks(labelEl, o, questionId) {
    if (!Array.isArray(o.blocks) || !o.blocks.length) return labelEl;
    const wrap = el('div', { class: 'optwrap' + (labelEl.classList.contains('sel') ? ' sel' : '') }, labelEl);
    renderBlocks(wrap, o.blocks, questionId);
    return wrap;
  }

  function controlSingle(q) {
    const group = el('div');
    const entries = [];
    let otherRadio = null;
    const otherOn = () => Boolean(state.other[q.id] && state.other[q.id].on);
    const syncSingle = () => {
      for (const { input, value } of entries) input.checked = state.answers[q.id] === value && !otherOn();
      if (otherRadio) otherRadio.checked = otherOn();
      syncOptSel(group);
      clearErr(q.id);
      scheduleSave();
    };
    for (const o of q.options) {
      const input = el('input', { type: 'radio', name: q.id });
      entries.push({ input, value: o.value });
      input.checked = state.answers[q.id] === o.value && !otherOn();
      // Click-to-toggle: clicking the selected option unselects it (answers
      // are optional by default). preventDefault keeps `checked` ours to set.
      input.addEventListener('click', (e) => {
        e.preventDefault();
        if (state.answers[q.id] === o.value && !otherOn()) {
          delete state.answers[q.id];
        } else {
          state.answers[q.id] = o.value;
          if (state.other[q.id]) state.other[q.id].on = false;
        }
        // Defer: after a canceled activation the browser restores the
        // pre-click checked state AFTER this handler, clobbering direct sets.
        setTimeout(syncSingle, 0);
      });
      input.addEventListener('change', () => {
        // keyboard path (arrow keys / space) — no click event fires
        if (!input.checked) return;
        state.answers[q.id] = o.value;
        if (state.other[q.id]) state.other[q.id].on = false;
        syncSingle();
      });
      group.append(
        withOptionBlocks(
          el('label', { class: 'opt' + (input.checked ? ' sel' : '') },
            input,
            el('div', {},
              el('div', { class: 'ol' }, o.label),
              o.description ? el('div', { class: 'od' }, o.description) : null
            )
          ),
          o,
          q.id
        )
      );
    }
    if (q.other) {
      otherRadio = el('input', { type: 'radio', name: q.id });
      const text = el('input', { type: 'text', placeholder: 'your own answer…' });
      text.value = (state.other[q.id] && state.other[q.id].text) || '';
      otherRadio.checked = otherOn();
      const ensureOther = () => state.other[q.id] || (state.other[q.id] = { on: false, text: text.value });
      otherRadio.addEventListener('click', (e) => {
        e.preventDefault();
        const oth = ensureOther();
        oth.on = !oth.on;
        if (oth.on) delete state.answers[q.id];
        setTimeout(syncSingle, 0);
      });
      otherRadio.addEventListener('change', () => {
        if (!otherRadio.checked) return;
        const oth = ensureOther();
        oth.on = true;
        delete state.answers[q.id];
        syncSingle();
      });
      text.addEventListener('input', () => {
        const oth = ensureOther();
        oth.text = text.value;
        if (!oth.on) {
          oth.on = true;
          delete state.answers[q.id];
        }
        syncSingle();
      });
      group.append(
        el('label', { class: 'opt' + (otherRadio.checked ? ' sel' : '') },
          otherRadio,
          el('div', { style: 'flex:1' }, el('div', { class: 'ol' }, 'Other'), el('div', { class: 'otherbox' }, text))
        )
      );
    }
    return group;
  }

  function controlMulti(q) {
    const group = el('div');
    const selected = new Set(Array.isArray(state.answers[q.id]) ? state.answers[q.id] : []);
    const readChecked = () => {
      state.answers[q.id] = [...group.querySelectorAll('input[data-val]')]
        .filter((i) => i.checked)
        .map((i) => i.dataset.val);
      syncOptSel(group);
      clearErr(q.id);
      scheduleSave();
    };
    for (const o of q.options) {
      const input = el('input', { type: 'checkbox', 'data-val': o.value });
      input.checked = selected.has(o.value);
      input.addEventListener('change', readChecked);
      group.append(
        withOptionBlocks(
          el('label', { class: 'opt' + (input.checked ? ' sel' : '') },
            input,
            el('div', {},
              el('div', { class: 'ol' }, o.label),
              o.description ? el('div', { class: 'od' }, o.description) : null
            )
          ),
          o,
          q.id
        )
      );
    }
    if (q.other) {
      const oth = state.other[q.id];
      const box = el('input', { type: 'checkbox' });
      const text = el('input', { type: 'text', placeholder: 'your own answer…' });
      box.checked = Boolean(oth && oth.on);
      text.value = (oth && oth.text) || '';
      const sync = () => {
        state.other[q.id] = { on: box.checked, text: text.value };
        syncOptSel(group);
        clearErr(q.id);
        scheduleSave();
      };
      box.addEventListener('change', sync);
      text.addEventListener('input', () => {
        if (!box.checked) box.checked = true;
        sync();
      });
      group.append(
        el('label', { class: 'opt' + (box.checked ? ' sel' : '') },
          box,
          el('div', { style: 'flex:1' }, el('div', { class: 'ol' }, 'Other'), el('div', { class: 'otherbox' }, text))
        )
      );
    }
    return group;
  }

  function segButtons(q, values, labels) {
    const seg = el('div', { class: q.type === 'scale' ? 'scale' : 'seg' });
    const buttons = [];
    values.forEach((v, i) => {
      const b = el('button', { type: 'button' }, labels[i]);
      if (state.answers[q.id] === v) b.classList.add('sel');
      b.addEventListener('click', () => {
        // click again to unselect (everything is optional by default)
        if (state.answers[q.id] === v) delete state.answers[q.id];
        else state.answers[q.id] = v;
        for (const x of buttons) x.classList.toggle('sel', state.answers[q.id] === values[buttons.indexOf(x)]);
        clearErr(q.id);
        scheduleSave();
      });
      buttons.push(b);
      seg.append(b);
    });
    return seg;
  }

  function controlScale(q) {
    const values = [];
    for (let i = q.min; i <= q.max; i++) values.push(i);
    const seg = segButtons(q, values, values.map(String));
    const row = el('div', { class: 'scale' });
    if (q.minLabel) row.append(el('span', { class: 'slabel' }, q.minLabel));
    row.append(...seg.children);
    if (q.maxLabel) row.append(el('span', { class: 'slabel' }, q.maxLabel));
    return row;
  }

  function controlText(q, multiline) {
    const input = multiline
      ? el('textarea', { placeholder: q.placeholder || '' })
      : el('input', { type: 'text', placeholder: q.placeholder || '' });
    input.value = typeof state.answers[q.id] === 'string' ? state.answers[q.id] : '';
    input.addEventListener('input', () => {
      state.answers[q.id] = input.value;
      clearErr(q.id);
      scheduleSave();
    });
    return input;
  }

  // Normalize any CSS color to the #rrggbb the native <input type=color> needs.
  function toHex6(c) {
    const s = String(c || '').trim();
    let m = /^#?([0-9a-fA-F]{6})$/.exec(s);
    if (m) return '#' + m[1].toLowerCase();
    m = /^#?([0-9a-fA-F]{3})$/.exec(s);
    if (m) return '#' + m[1].split('').map((x) => x + x).join('').toLowerCase();
    return '#000000';
  }
  function controlColor(q) {
    const wrap = el('div', { class: 'colorpick' });
    const init = (typeof state.answers[q.id] === 'string' && state.answers[q.id]) || (typeof q.default === 'string' ? q.default : '');
    const swatch = el('input', { type: 'color', class: 'colorswatch' });
    const hex = el('input', { type: 'text', class: 'colorhex', placeholder: q.placeholder || '#rrggbb', spellcheck: 'false', autocapitalize: 'off' });
    swatch.value = toHex6(init || '#888888');
    if (init) { hex.value = init; state.answers[q.id] = init; }
    const set = (val) => { state.answers[q.id] = val; clearErr(q.id); scheduleSave(); };
    swatch.addEventListener('input', () => { hex.value = swatch.value; set(swatch.value); });
    hex.addEventListener('input', () => { const v = hex.value.trim(); if (/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) swatch.value = toHex6(v); set(v); });
    wrap.append(el('div', { class: 'colorrow' }, swatch, hex));
    if (Array.isArray(q.presets) && q.presets.length) {
      const presets = el('div', { class: 'colorpresets' });
      for (const c of q.presets) {
        const b = el('button', { type: 'button', class: 'colorpreset', style: 'background:' + c, title: c });
        b.addEventListener('click', () => { swatch.value = toHex6(c); hex.value = c; set(c); });
        presets.append(b);
      }
      wrap.append(presets);
    }
    return wrap;
  }

  // ---------- render ----------
  themeBtn = el('button', { class: 'theme-btn', type: 'button' }, '');
  themeBtn.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    localStorage.setItem(THEME_KEY, theme);
    fetch('/api/pref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).catch(() => {});
    applyTheme();
  });
  applyTheme();

  const fsDown = el('button', { class: 'fs-btn', type: 'button', title: 'Smaller text', 'aria-label': 'Decrease text size' }, 'A−');
  const fsUp = el('button', { class: 'fs-btn', type: 'button', title: 'Larger text', 'aria-label': 'Increase text size' }, 'A+');
  fsDown.addEventListener('click', () => setFontScale(fontScale - FS_STEP));
  fsUp.addEventListener('click', () => setFontScale(fontScale + FS_STEP));
  const fsCtrl = el('div', { class: 'fs-ctrl' }, fsDown, fsUp);

  // Just reloaded after a live `rly update`? Flag set before reload below.
  try {
    if (sessionStorage.getItem('relay-updated') === '1') {
      sessionStorage.removeItem('relay-updated');
      showToast('Board updated by the agent');
    }
  } catch {
    // sessionStorage may be unavailable (privacy mode) — non-fatal
  }

  const titleEl = el('h1', {}, spec.title);
  app.append(el('header', { class: 'qb-header' }, titleEl, el('div', { class: 'qb-controls' }, fsCtrl, themeBtn)));
  // The board title is commentable too: hovering it shows the pin, like the
  // intro and every other content element. (themeBtn stays out of it.)
  if (spec.title) {
    Annotate?.register(titleEl, { blockId: null, questionId: null, target: { kind: 'html-element', label: spec.title } });
  }
  if (spec.intro) {
    // Render the intro as markdown (bold/italic/code/links/lists) — agents write
    // markdown here by default. Falls back to plain text if blocks.js is absent.
    // The .blk-markdown class scopes the shared markdown typography to it.
    const md = typeof window.RelayBlocks !== 'undefined' && window.RelayBlocks.renderMarkdown;
    const intro = md
      ? el('div', { class: 'intro blk-markdown' }, window.RelayBlocks.renderMarkdown(spec.intro))
      : el('p', { class: 'intro' }, spec.intro);
    app.append(intro);
    Annotate?.enableTextSelection(intro, { blockId: null, questionId: null });
  }
  // Board-level blocks render above the questions (async; never blocks submit).
  renderBlocks(app, spec.blocks || [], null);

  QS.forEach((q, idx) => {
    const required = q.required || !spec.allowPartial;
    const card = el('div', { class: 'card' },
      el('div', { class: 'qnum' }, `Q${idx + 1}`),
      el('p', { class: 'qlabel' }, q.label, required ? el('span', { class: 'req' }, ' *') : null),
      q.description ? el('p', { class: 'qdesc' }, q.description) : null
    );
    // Per-question blocks render between the description and the control.
    renderBlocks(card, q.blocks || [], q.id);
    const control = el('div', { class: 'control' });
    if (q.type === 'single') control.append(controlSingle(q));
    else if (q.type === 'multi') control.append(controlMulti(q));
    else if (q.type === 'yesno') control.append(segButtons(q, ['yes', 'no'], ['Yes', 'No']));
    else if (q.type === 'scale') control.append(controlScale(q));
    else if (q.type === 'color') control.append(controlColor(q));
    else control.append(controlText(q, q.type === 'textarea'));
    card.append(control);
    if (q.note) {
      const noteInput = el('textarea', { class: 'qnote', rows: 2, placeholder: 'optional note about this answer…' });
      noteInput.value = typeof state.notes[q.id] === 'string' ? state.notes[q.id] : '';
      noteInput.addEventListener('input', () => {
        state.notes[q.id] = noteInput.value;
        scheduleSave();
      });
      card.append(el('div', { class: 'qnotewrap' }, noteInput));
    }
    card.append(el('p', { class: 'errmsg' }, 'This question is required.'));
    cards[q.id] = card;
    app.append(card);
  });

  if (spec.note) {
    const note = el('textarea', { placeholder: 'optional note back to the agent…' });
    note.value = state.comment || '';
    note.addEventListener('input', () => {
      state.comment = note.value;
      scheduleSave();
    });
    app.append(el('div', { class: 'card' },
      el('p', { class: 'qlabel' }, 'Anything else?'),
      el('p', { class: 'qdesc' }, 'Free-text note returned to the agent along with your answers.'),
      el('div', { class: 'control' }, note)
    ));
  }

  // Element-level comments live in the Outline-style right rail (created and
  // managed by RelayAnnotate); no inline summary list here anymore.

  const submitBtn = el('button', { class: 'submit', type: 'button' }, spec.submitLabel);
  saveEl = el('span', { class: 'savestate' }, '');
  const hint = el('span', { class: 'hint' },
    QS.length && spec.allowPartial ? 'Unanswered questions are returned as skipped.' : '');
  app.append(el('div', { class: 'submitbar' }, submitBtn, hint, saveEl));
  app.append(el('footer', { class: 'qb-footer' }, `relay · ${boot.boardId}`));

  // ---------- validation & submit ----------
  function validate() {
    let firstBad = null;
    for (const q of QS) {
      const required = q.required || !spec.allowPartial;
      const bad = required && getValue(q) === undefined;
      cards[q.id].classList.toggle('error', bad);
      if (bad && !firstBad) firstBad = cards[q.id];
    }
    if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return !firstBad;
  }

  function showDone(closing) {
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
    const note = handedBack
      ? 'Saved. Your agent had stopped waiting — send it a message so it picks up your answers.'
      : closing
        ? 'Handing back to your agent — this tab will close itself…'
        : 'Handed back to your agent. You can close this tab.';
    app.replaceChildren(
      el('div', { class: 'done' },
        el('div', { class: 'mark' }, '✓'),
        el('h2', {}, QS.length ? 'Submitted' : 'Acknowledged'),
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
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload()),
        });
      } catch (netErr) {
        // A thrown fetch (vs. an HTTP error response) means we never reached the
        // server — the connection is gone, so this submit was never delivered.
        reached = false;
        throw netErr;
      }
      if (!res.ok) throw new Error('submit rejected');
      submitted = true;
      // Submitted successfully → the local mirror is no longer needed and would
      // otherwise resurrect stale answers on a future reopen. Clear it.
      clearLocalDraft();
      // Don't auto-close when the agent had stopped waiting — the user needs to
      // read the "send your agent a message" note and act on it.
      const autoClose = spec.autoClose && !handedBack;
      showDone(autoClose);
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
      submitBtn.textContent = spec.submitLabel;
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

  // ---------- prefilled load: jump past what's already answered ----------
  // On reload/reopen with saved answers, scroll to the first unanswered
  // question so the user doesn't re-scan questions they already did.
  if (initialPrefill && QS.length) {
    const answered = QS.filter((q) => getValue(q) !== undefined).length;
    const firstOpen = QS.find((q) => getValue(q) === undefined);
    if (answered > 0 && firstOpen) {
      setTimeout(() => {
        cards[firstOpen.id].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 350);
    }
  }

  // If the chosen prefill came from the local mirror (newer than the server, or
  // the server had nothing — e.g. a freshly reopened board the user had typed
  // into in another tab during an outage), the server doesn't yet have this
  // input. Flush it once so a brand-new tab's view is also the server's truth.
  if (initialPrefill && initialPrefill.__from === 'local' && !submitted) {
    saveDraft();
  }

  // ---------- iframe annotate bridge ----------
  // Custom-HTML iframes (via /kit.js relayKit.annotate, auto-injected by the
  // server) talk to the parent over postMessage:
  //   iframe → {relay:'annotate-ready'}                      we send it counts
  //   iframe → {relay:'annotate-request', ref, label, detail?, rect}
  //   parent → {relay:'annotate-counts', counts:{ref:n}}     it draws badges
  // We own the annotation state, popover, and the submitted result; the iframe
  // owns hover/pin/badges over its own (cross-origin) DOM.
  if (Annotate) {
    const frameOf = (source) => {
      for (const f of document.querySelectorAll('iframe.viz')) {
        if (f.contentWindow === source) return f;
      }
      return null;
    };
    // Per-element comment counts for one iframe, keyed by target.ref.
    const postCountsTo = (frame) => {
      if (!frame || !frame.contentWindow) return;
      const blockId = frame.getAttribute('data-block-id') || null;
      const counts = {};
      for (const a of Annotate.list()) {
        if ((a.blockId ?? null) !== (blockId ?? null)) continue;
        const t = a.target || {};
        if (t.kind !== 'html-element' || !t.ref) continue;
        counts[t.ref] = (counts[t.ref] || 0) + 1;
      }
      try { frame.contentWindow.postMessage({ relay: 'annotate-counts', counts }, '*'); } catch {}
    };
    // Refresh badges in every html iframe (called whenever annotations change).
    window.__relayBroadcastCounts = () => {
      for (const f of document.querySelectorAll('iframe.viz')) postCountsTo(f);
    };

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object' || typeof msg.relay !== 'string') return;
      const frame = frameOf(e.source);
      if (!frame) return;
      if (msg.relay === 'annotate-ready') { postCountsTo(frame); return; }
      if (msg.relay !== 'annotate-request') return;

      const blockId = frame.getAttribute('data-block-id') || null;
      const questionId = frame.getAttribute('data-question-id') || null;
      const target = { kind: 'html-element', label: typeof msg.label === 'string' ? msg.label : 'Element' };
      if (typeof msg.ref === 'string') target.ref = msg.ref;
      if (typeof msg.detail === 'string') target.detail = msg.detail;

      // Anchor the popover to the actual element: translate the iframe-local
      // viewport rect the iframe sent into page coords. Fall back to the iframe.
      let anchor = frame;
      if (msg.rect && typeof msg.rect === 'object') {
        const fr = frame.getBoundingClientRect();
        const r = msg.rect;
        const left = fr.left + (r.left || 0);
        const top = fr.top + (r.top || 0);
        const width = r.width || 0;
        const height = r.height || 0;
        const pageRect = { left, top, width, height, right: left + width, bottom: top + height };
        anchor = { getBoundingClientRect: () => pageRect };
      }
      Annotate.openExternal({ blockId, questionId: questionId || null, target }, anchor);
    });
  }

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
      const r = await fetch('/api/status', { cache: 'no-store' });
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
        showNotice(
          'You’ve had this open a while, so the agent stopped waiting. Your changes save automatically — submit when you’re ready, then prompt the agent to pick them up.',
          'info'
        );
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
})();
