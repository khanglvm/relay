  // ---------- annotations ----------
  // RelayAnnotate owns the live annotation list; mirror it into state on every
  // change so payload()/autosave/submit carry it exactly like answers.
  const Annotate = typeof window.RelayAnnotate !== 'undefined' ? window.RelayAnnotate : null;
  if (Annotate && responseRequired) {
    Annotate.init({
      initial: state.annotations,
      permissions: {
        add: access.canComment !== false,
        edit: access.canEditComments !== false,
        delete: access.canDeleteComments !== false,
        reply: access.canComment !== false,
      },
      onChange: (list) => {
        state.annotations = list;
        scheduleSave();
        // Refresh per-element comment badges inside custom-HTML iframes (bridge
        // sets this once the iframe annotate plumbing is wired below).
        if (window.__relayBroadcastCounts) window.__relayBroadcastCounts();
      },
    });
  } else if (Annotate && !responseRequired && typeof Annotate.teardown === 'function') {
    Annotate.teardown();
  }

  // Editable-mermaid: record (or clear) the user's edit for a block, then
  // autosave. A null/empty code clears the entry (block matches the original
  // again — e.g. after Reset), so payload()/draft carry only real divergences.
  function onBlockEdit(blockId, codeOrNull) {
    if (codeOrNull === null || codeOrNull === undefined) delete state.blockEdits[blockId];
    else state.blockEdits[blockId] = codeOrNull;
    scheduleSave();
  }

  document.addEventListener('relay:block-edit', (e) => {
    const d = e.detail || {};
    if (!d.blockId) return;
    onBlockEdit(d.blockId, d.value);
  });

  async function saveRegionArtifact(artifact) {
    const res = await fetch('/api/artifact', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(artifact),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.path) throw new Error(body && body.error ? body.error : 'could not save image crop');
    return body;
  }

  // ctx for RelayBlocks.render — theme()/htmlSrc per the shared contract, plus
  // the editable-mermaid plumbing (edits map + onBlockEdit callback).
  function blockCtx(questionId) {
    return {
      theme: effectiveTheme,
      htmlSrc: (blockId, isolated) => {
        const params = new URLSearchParams();
        if (!isolated) params.set('theme', effectiveTheme());
        if (access.token) params.set('token', access.token);
        const query = params.toString();
        return '/html/b/' + encodeURIComponent(blockId) + (query ? '?' + query : '');
      },
      questionId: questionId == null ? null : questionId,
      annotate: responseRequired ? Annotate : null,
      canComment: responseRequired && access.canComment !== false,
      saveArtifact: responseRequired && access.canComment !== false ? saveRegionArtifact : null,
      edits: state.blockEdits,
      onBlockEdit,
      canEditBlocks: access.canEditBlocks !== false,
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

