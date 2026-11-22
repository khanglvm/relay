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
        if (codeOrNull === null || codeOrNull === undefined) delete state.blockEdits[blockId];
        else state.blockEdits[blockId] = codeOrNull;
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

