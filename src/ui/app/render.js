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

  function buildShareControl() {
    if (!access.canShare) return null;
    const wrap = el('span', { class: 'share-wrap' });
    const shareBtn = el('button', { class: 'share-btn icon-btn', type: 'button', title: 'Share board', 'aria-label': 'Share board' });
    shareBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6.5 9.5 9.5 11.2M9.5 4.8 6.5 6.5"/>' +
      '<circle cx="4.5" cy="8" r="2"/><circle cx="11.5" cy="4" r="2"/><circle cx="11.5" cy="12" r="2"/>' +
      '</svg>';
    shareBtn.addEventListener('click', () => {
      const existing = wrap.querySelector('.share-panel');
      if (existing) existing.remove();
      else openSharePanel(wrap);
    });
    wrap.append(shareBtn);
    return wrap;
  }

  // Just reloaded after a live `rly update`? Flag set before reload below.
  try {
    if (sessionStorage.getItem('relay-updated') === '1') {
      sessionStorage.removeItem('relay-updated');
      showToast('Board updated by the agent');
    }
    if (sessionStorage.getItem('relay-draft-updated') === '1') {
      sessionStorage.removeItem('relay-draft-updated');
      showToast('Board refreshed with shared changes');
    }
  } catch {
    // sessionStorage may be unavailable (privacy mode) — non-fatal
  }

  const titleEl = el('h1', {}, spec.title);
  app.append(el('header', { class: 'qb-header' }, titleEl, el('div', { class: 'qb-controls' }, fsCtrl, buildShareControl(), themeBtn)));
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
    else if (q.type === 'rank') control.append(controlRank(q));
    else if (q.type === 'checklist') control.append(controlChecklist(q));
    else if (q.type === 'allocate') control.append(controlAllocate(q));
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

  if (spec.note && responseRequired) {
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
  const submitbar = el('div', { class: 'submitbar' }, submitBtn, hint, saveEl);
  if (!responseRequired) {
    submitbar.replaceChildren(el('span', { class: 'hint' }, 'Display only · no response requested'));
    submitbar.classList.add('display-only');
  }
  app.append(submitbar);

