  // A button click in an a2ui block reaches the agent before the person submits.
  // Events already in the stored snapshot were sent when they happened.
  function forwardA2uiEvents(blockId, before, after) {
    if (!BOARD.token || !after || after.type !== 'a2ui' || !Array.isArray(after.events)) return;
    for (const e of unsentA2uiEvents(before, after.events)) {
      callServerTool('a2ui_action', { boardId: BOARD.id, token: BOARD.token, blockId, name: e.name, context: e.context }).catch(() => {});
    }
  }
  // A snapshot keeps only the newest events, so once it is full a click drops the
  // oldest one and the count stays the same. What was sent is the longest run at
  // the start of the new list that also ends the old one.
  function unsentA2uiEvents(before, events) {
    const prior = before && Array.isArray(before.events) ? before.events.map((e) => JSON.stringify(e)) : [];
    const next = events.map((e) => JSON.stringify(e));
    for (let kept = Math.min(prior.length, next.length); kept > 0; kept--) {
      if (next.slice(0, kept).every((e, i) => e === prior[prior.length - kept + i])) return events.slice(kept);
    }
    return events;
  }

  function blockCtx(questionId) {
    return {
      theme: effectiveTheme,
      htmlSrc: (blockId) => htmlBlobSrc(blockId),
      questionId: questionId == null ? null : questionId,
      // No annotation during the streaming preview (it re-renders); on the final
      // interactive render, wire the engine so blocks register their targets.
      annotate: composing || (spec && spec.responseRequired === false) ? null : Annotate,
      canComment: Boolean(spec && spec.responseRequired !== false),
      saveArtifact: async ({ dataUrl, mime, width, height }) => {
        const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
        if (comma < 0) throw new Error('invalid image crop');
        return { data: dataUrl.slice(comma + 1), mime: mime || 'image/png', width, height };
      },
      edits: state.blockEdits,
      onBlockEdit: (blockId, codeOrNull) => {
        const before = state.blockEdits[blockId];
        if (codeOrNull === null || codeOrNull === undefined) delete state.blockEdits[blockId];
        else state.blockEdits[blockId] = codeOrNull;
        forwardA2uiEvents(blockId, before, codeOrNull);
      },
    };
  }
  document.addEventListener('relay:block-edit', (e) => {
    const d = e.detail || {};
    if (!d.blockId) return;
    if (d.value === null || d.value === undefined) delete state.blockEdits[d.blockId];
    else state.blockEdits[d.blockId] = d.value;
  });
  function renderBlocks(container, blocks, questionId) {
    if (!Array.isArray(blocks) || !blocks.length) return;
    const target = el('div', { class: 'blocks' });
    container.append(target);
    if (!window.RelayBlocks) {
      target.append(el('div', { class: 'blk' }, el('div', { class: 'blk-error' }, 'block failed to render')));
      return;
    }
    Promise.resolve()
      .then(() => window.RelayBlocks.render(target, blocks, blockCtx(questionId)))
      .then(reportSize)
      .catch(() => {
        target.append(el('div', { class: 'blk' }, el('div', { class: 'blk-error' }, 'block failed to render')));
      });
  }

