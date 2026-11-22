  // ======================================================================
  // render
  // ======================================================================
  function render() {
    app.replaceChildren();
    const annotateOn = !composing && Annotate;
    const titleEl = el('h1', {}, spec.title);
    app.append(el('header', { class: 'qb-header' }, titleEl));
    if (annotateOn) Annotate.register(titleEl, { blockId: null, questionId: null, target: { kind: 'html-element', label: spec.title } });
    if (spec.intro) {
      const md = window.RelayBlocks && RelayBlocks.renderMarkdown;
      const introEl = md
        ? el('div', { class: 'intro blk-markdown' }, RelayBlocks.renderMarkdown(spec.intro))
        : el('p', { class: 'intro' }, spec.intro);
      app.append(introEl);
      if (annotateOn) Annotate.enableTextSelection(introEl, { blockId: null, questionId: null });
    }
    renderBlocks(app, spec.blocks || [], null);

    QS.forEach((q, idx) => {
      const required = q.required || !spec.allowPartial;
      const card = el('div', { class: 'card' },
        el('div', { class: 'qnum' }, 'Q' + (idx + 1)),
        el('p', { class: 'qlabel' }, q.label, required ? el('span', { class: 'req' }, ' *') : null),
        q.description ? el('p', { class: 'qdesc' }, q.description) : null);
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
        noteInput.addEventListener('input', () => { state.notes[q.id] = noteInput.value; });
        card.append(el('div', { class: 'qnotewrap' }, noteInput));
      }
      card.append(el('p', { class: 'errmsg' }, 'This question is required.'));
      cards[q.id] = card;
      app.append(card);
    });

    if (spec.note && spec.responseRequired !== false) {
      const note = el('textarea', { placeholder: 'optional note back to the agent…' });
      note.value = state.comment || '';
      note.addEventListener('input', () => { state.comment = note.value; });
      app.append(el('div', { class: 'card' },
        el('p', { class: 'qlabel' }, 'Anything else?'),
        el('p', { class: 'qdesc' }, 'Free-text note returned to the agent along with your answers.'),
        el('div', { class: 'control' }, note)));
    }

    if (composing) {
      // still streaming in — show a live "composing" note, no submit yet
      app.append(el('div', { class: 'submitbar' }, el('span', { class: 'mcp-composing' }, 'Composing this board…')));
      reportSize();
      return;
    }
    if (spec.responseRequired === false) {
      app.append(el('div', { class: 'submitbar display-only' },
        el('span', { class: 'hint' }, 'Display only · no response requested')));
      reportSize();
      return;
    }
    const submitBtn = el('button', { class: 'submit', type: 'button' }, spec.submitLabel);
    const saveEl = el('span', { class: 'savestate' }, '');
    const hint = el('span', { class: 'hint' }, QS.length && spec.allowPartial ? 'Unanswered questions are returned as skipped.' : '');
    submitBtn.addEventListener('click', () => onSubmit(submitBtn, saveEl));
    app.append(el('div', { class: 'submitbar' }, submitBtn, hint, saveEl));
    reportSize();
  }

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

  // A human-readable transcript of the submission — so the agent reads the
  // answers even on a host that doesn't surface structuredContent.
  function summarize(data) {
    const lines = [];
    lines.push('The user submitted the relay board "' + spec.title + '".');
    if (QS.length) {
      lines.push('', 'Answers:');
      for (const q of QS) {
        const v = data.answers[q.id];
        let shown;
        if (v === undefined) shown = '(skipped)';
        else if (Array.isArray(v)) shown = v.join(', ');
        else shown = String(v);
        lines.push('- ' + q.label + ' [' + q.id + ']: ' + shown);
        if (data.notes[q.id]) lines.push('    note: ' + data.notes[q.id]);
      }
    }
    if (data.comment) lines.push('', 'Comment: ' + data.comment);
    if (data.annotations && data.annotations.length) {
      lines.push('', 'Inline comments (' + data.annotations.length + '):');
      for (const a of data.annotations) {
        const where = (a.target && (a.target.label || a.target.text || a.target.kind)) || a.blockId || 'element';
        const crop = a.target && a.target.crop;
        const cropNote = crop && crop.path ? ' · crop: ' + crop.path : crop && crop.data ? ' · image crop attached' : '';
        lines.push('- [' + where + ']: ' + a.text + cropNote);
      }
    }
    if (data.blockEdits) lines.push('', 'Edited diagrams: ' + Object.keys(data.blockEdits).join(', '));
    return lines.join('\n');
  }

  async function onSubmit(submitBtn, saveEl) {
    if (submitted) return;
    if (!validate()) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    const data = payload();
    const structured = {
      boardId: BOOT.boardId || null,
      status: QS.length ? 'submitted' : 'acknowledged',
      answers: data.answers,
      skipped: data.skipped,
      notes: data.notes,
      comment: data.comment,
      blockEdits: data.blockEdits,
      annotations: data.annotations,
    };
    const text = summarize(data);
    const messageContent = [{ type: 'text', text }];
    for (const a of data.annotations || []) {
      const crop = a && a.target && a.target.crop;
      if (!crop || typeof crop.data !== 'string' || !crop.data) continue;
      messageContent.push({ type: 'image', data: crop.data, mimeType: crop.mime || 'image/png' });
    }
    let messageDelivered = false;
    let contextDelivered = false;
    try {
      // A completed relay form is a user reply, not passive context. Some hosts
      // ACK `ui/update-model-context` without starting a new model turn, so send
      // the transcript as a user message first to wake the agent reliably.
      await request('ui/message', { role: 'user', content: messageContent });
      messageDelivered = true;
    } catch {
      // Older hosts may not advertise image content or may implement the early
      // single-content draft. Preserve the text wake path before giving up.
      try {
        await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
        messageDelivered = true;
      } catch {
        try {
          await request('ui/message', { role: 'user', content: { type: 'text', text } });
          messageDelivered = true;
        } catch { /* app-initiated messages unavailable */ }
      }
    }
    try {
      // Keep the structured payload available to hosts that attach app context.
      // This is best-effort because context updates are intentionally silent.
      await request('ui/update-model-context', { content: messageContent, structuredContent: structured });
      contextDelivered = true;
    } catch {
      try {
        await request('ui/update-model-context', { content: [{ type: 'text', text }], structuredContent: structured });
        contextDelivered = true;
      } catch { /* ui/message may still have delivered the result */ }
    }
    submitted = true;
    showDone(messageDelivered, contextDelivered);
  }

  function showDone(messageDelivered, contextDelivered) {
    // Collapse: leave fullscreen, drop the whole form for a one-line confirmation
    // so the host shrinks the iframe to a small footprint in the transcript.
    if (Annotate) { try { Annotate.teardown(); } catch { /* nothing to tear down */ } }
    document.documentElement.classList.remove('mcp-fullscreen');
    app.replaceChildren(el('div', { class: 'mcp-done' },
      el('span', { class: 'mark' }, '✓'),
      el('span', { class: 'lead' }, QS.length ? 'Submitted' : 'Acknowledged'),
      el('span', { class: 'sub' }, messageDelivered
        ? '· sent back to the agent'
        : contextDelivered
          ? '· saved; send the agent a message to continue'
        : '· tell the agent you’ve responded')));
    // Report the small height immediately, then again next frame / after layout
    // settles — beats hosts that only grow on debounced size events.
    reportSizeNow();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reportSizeNow);
    setTimeout(reportSizeNow, 150);
  }

