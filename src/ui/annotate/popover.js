  // ---------- popover ----------
  function positionPopover() {
    popPositionFrame = 0;
    if (!popOpen || !dom || !popAnchorEl || !popAnchorEl.isConnected) return;
    const pop = dom.pop;
    const rect = popAnchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 8 && rect.top - ph - 8 >= 8) top = rect.top - ph - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function schedulePositionPopover() {
    if (!popOpen || popPositionFrame) return;
    popPositionFrame = requestAnimationFrame(positionPopover);
  }

  function closePopover(reason = 'dismissed') {
    if (!popOpen) return;
    const closeHook = popCloseHook;
    popOpen = false;
    popSave = null;
    popCloseHook = null;
    popAnchorEl = null;
    if (popPositionFrame) cancelAnimationFrame(popPositionFrame);
    popPositionFrame = 0;
    dom.pop.style.display = 'none';
    dom.pop.replaceChildren();
    if (closeHook) {
      try { closeHook(reason); } catch (_) { /* lifecycle hooks are best-effort */ }
    }
  }

  // ---------- delete a comment (with confirm) ----------
  // The × that used to delete a comment read as "close the popup". Delete is now
  // a distinct trash button that opens a confirm modal; "Don't ask again"
  // (default OFF) suppresses future confirms for the session (persisted best-effort).
  const ICON_TRASH =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.5 4h11M6 4V2.5h4V4M5 4l.5 9h5l.5-9"/></svg>';
  const ICON_PENCIL =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11.5 2.5l2 2L6 12l-2.5.5.5-2.5 7.5-7.5z"/></svg>';
  const DEL_SKIP_KEY = 'relay-ann-del-skip';
  let delConfirmSkip = false;
  try { delConfirmSkip = localStorage.getItem(DEL_SKIP_KEY) === '1'; } catch { /* sandbox: no storage */ }

  function requestDelete(id, after) {
    if (!permissions.delete) return;
    const done = () => { removeAnnotation(id); if (after) after(); };
    if (delConfirmSkip) { done(); return; }
    showDeleteConfirm(done);
  }
  function showDeleteConfirm(onConfirm) {
    const scrim = el('div', { class: 'ann-confirm-scrim' });
    const skip = el('input', { type: 'checkbox' });
    const cancel = el('button', { class: 'ann-confirm-cancel', type: 'button' }, 'Cancel');
    const del = el('button', { class: 'ann-confirm-del', type: 'button' }, 'Delete');
    const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    cancel.addEventListener('click', close);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    del.addEventListener('click', () => {
      if (skip.checked) { delConfirmSkip = true; try { localStorage.setItem(DEL_SKIP_KEY, '1'); } catch { /* sandbox */ } }
      close();
      onConfirm();
    });
    scrim.append(el('div', { class: 'ann-confirm', role: 'alertdialog', 'aria-label': 'Delete comment' },
      el('div', { class: 'ann-confirm-title' }, 'Delete this comment?'),
      el('div', { class: 'ann-confirm-msg' }, 'This removes the comment and its replies. It can’t be undone.'),
      el('label', { class: 'ann-confirm-skip' }, skip, el('span', {}, 'Don’t ask again')),
      el('div', { class: 'ann-confirm-actions' }, cancel, del)
    ));
    document.body.append(scrim);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { try { cancel.focus(); } catch { /* ignore */ } }, 0);
  }

  function openPopover(info, anchorEl) {
    if (disabled) return;
    ensureDom();
    const hasExisting = matching(info).length > 0;
    const draftKey = sigOf(info.blockId, info.target);
    // Read-only viewers can open existing threads from their badges, but a
    // target with no feedback has nothing to show and must not expose an empty
    // add-comment dialog.
    if (!permissions.add && !hasExisting) return;
    closePopover();
    popCloseHook = typeof info.onClose === 'function' ? info.onClose : null;
    hidePin();
    const pop = dom.pop;
    // Header: target label + an explicit CLOSE button, so × always means "close".
    const popClose = el('button', { class: 'ann-pop-close', type: 'button', title: 'Close', 'aria-label': 'Close' }, '×');
    popClose.addEventListener('click', () => closePopover('dismissed'));
    pop.replaceChildren(el('div', { class: 'ann-pop-head' }, el('div', { class: 'ann-pop-label' }, humanize(info.target)), popClose));

    // Existing comments on this exact target, rendered as threads: author
    // chip + time + delete, the comment text, its replies indented below,
    // and a compact reply input per thread. Deleting a comment deletes its
    // whole thread.
    const existingWrap = el('div', { class: 'ann-pop-existing' });
    const renderExisting = () => {
      existingWrap.replaceChildren();
      for (const a of matching(info)) {
        const del = el('button', { class: 'ann-del', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' });
        del.innerHTML = ICON_TRASH;
        del.addEventListener('click', () => requestDelete(a.id, renderExisting));
        const edit = el('button', { class: 'ann-edit', type: 'button', title: 'Edit comment', 'aria-label': 'Edit comment' });
        edit.innerHTML = ICON_PENCIL;
        const textEl = el('div', { class: 'ann-pop-text' }, a.text);
        // Inline edit: swap the text for a textarea + Save/Cancel; Save commits
        // via editAnnotation, then re-renders. Only the user's own comment is editable.
        edit.addEventListener('click', () => {
          const ta = el('textarea', { class: 'ann-ta ann-edit-ta', rows: '3' });
          ta.value = a.text;
          const save = el('button', { class: 'ann-save', type: 'button' }, 'Save');
          const cancel = el('button', { class: 'ann-cancel', type: 'button' }, 'Cancel');
          save.addEventListener('click', () => { editAnnotation(a.id, ta.value); renderExisting(); });
          cancel.addEventListener('click', renderExisting);
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); renderExisting(); }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); editAnnotation(a.id, ta.value); renderExisting(); }
          });
          textEl.replaceWith(el('div', { class: 'ann-edit-form' }, ta, el('div', { class: 'ann-pop-actions' }, save, cancel)));
          ta.focus();
        });
        // agent replies aren't editable here — only the top-level user comment
        const actions = el('div', { class: 'ann-thread-actions' },
          permissions.edit && a.author === 'user' ? edit : null,
          permissions.delete ? del : null
        );
        const thread = el('div', { class: 'ann-thread' },
          el('div', { class: 'ann-thread-head' }, chip(a.author), timeEl(a.createdAt), actions),
          textEl
        );
        if (Array.isArray(a.replies) && a.replies.length) {
          const list = el('div', { class: 'ann-replies' });
          for (const r of a.replies) {
            list.append(el('div', { class: 'ann-reply' },
              el('div', { class: 'ann-reply-head' }, chip(r.author), timeEl(r.createdAt)),
              el('div', { class: 'ann-reply-text' }, r.text)
            ));
          }
          thread.append(list);
        }
        const input = el('input', { class: 'ann-reply-input', type: 'text', placeholder: 'Reply…', 'aria-label': 'Reply' });
        const btn = el('button', { class: 'ann-reply-btn', type: 'button' }, 'Reply');
        const submitReply = () => {
          const text = input.value.trim();
          if (!text) return;
          addReply(a.id, text);
          renderExisting();
        };
        btn.addEventListener('click', submitReply);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            submitReply();
          }
        });
        if (permissions.reply) thread.append(el('div', { class: 'ann-reply-form' }, input, btn));
        existingWrap.append(thread);
      }
    };
    renderExisting();
    pop.append(existingWrap);

    const ta = el('textarea', { class: 'ann-ta', placeholder: 'Add a comment…', rows: '3' });
    ta.value = commentDrafts.get(draftKey) || '';
    ta.addEventListener('input', () => {
      if (ta.value) commentDrafts.set(draftKey, ta.value);
      else commentDrafts.delete(draftKey);
    });
    const save = el('button', { class: 'ann-save', type: 'button' }, 'Save');
    const cancel = el('button', { class: 'ann-cancel', type: 'button' }, 'Cancel');
    popSave = () => {
      const text = ta.value.trim();
      if (text) addAnnotation(info, text);
      commentDrafts.delete(draftKey);
      if (text) closePopover('saved');
      else closePopover('empty');
    };
    save.addEventListener('click', () => popSave && popSave());
    cancel.addEventListener('click', () => {
      commentDrafts.delete(draftKey);
      closePopover('cancelled');
    });
    if (permissions.add) pop.append(ta, el('div', { class: 'ann-pop-actions' }, save, cancel));

    // Position: prefer below the anchor, flip above when out of room, and clamp
    // to the viewport. Scroll/resize re-run this through one animation frame so
    // the composer tracks browser scrolling smoothly without losing its draft.
    pop.style.display = 'block';
    pop.style.visibility = 'hidden';
    popOpen = true;
    popAnchorEl = anchorEl;
    positionPopover();
    pop.style.visibility = '';
    if (permissions.add) ta.focus();
    else popClose.focus();
  }

