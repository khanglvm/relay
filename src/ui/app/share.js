  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch {}
    ta.remove();
  }

  function openSharePanel(host) {
    const panel = el('div', { class: 'share-panel' },
      el('div', { class: 'share-title' }, 'Share this board'),
      el('div', { class: 'share-desc' }, 'Choose a permission. The link starts working immediately.'),
      el('button', { class: 'share-choice', type: 'button', 'data-role': 'collab' },
        el('span', { class: 'share-choice-title' }, 'Collaborator'),
        el('span', { class: 'share-choice-sub' }, 'Can edit answers, comment, and submit as owner.')
      ),
      el('button', { class: 'share-choice', type: 'button', 'data-role': 'review' },
        el('span', { class: 'share-choice-title' }, 'Reviewer'),
        el('span', { class: 'share-choice-sub' }, 'Can answer, comment, and submit a reference-only side review. Does not finalize the board.')
      ),
      el('button', { class: 'share-choice', type: 'button', 'data-role': 'read' },
        el('span', { class: 'share-choice-title' }, 'Read only'),
        el('span', { class: 'share-choice-sub' }, 'Can view the board and existing feedback. Cannot answer, comment, edit, or submit.')
      ),
      el('div', { class: 'share-result' })
    );
    const close = () => panel.remove();
    const closeBtn = el('button', { class: 'share-close', type: 'button', 'aria-label': 'Close share panel' }, '×');
    closeBtn.addEventListener('click', close);
    panel.prepend(closeBtn);
    const result = panel.querySelector('.share-result');
    for (const btn of panel.querySelectorAll('.share-choice')) {
      btn.addEventListener('click', async () => {
        const role = btn.getAttribute('data-role');
        btn.disabled = true;
        result.textContent = 'Activating...';
        try {
          const res = await fetch('/api/share', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body || !body.url) throw new Error(body && body.error ? body.error : 'share failed');
          const copy = el('button', { class: 'share-copy', type: 'button' }, 'Copy link');
          copy.addEventListener('click', () => copyText(body.url, copy));
          result.replaceChildren(
            el('div', { class: 'share-ready' }, role === 'collab' ? 'Collaborator link active' : role === 'review' ? 'Reviewer link active' : 'Read-only link active'),
            el('a', { class: 'share-url', href: body.url, target: '_blank', rel: 'noreferrer' }, body.url),
            copy
          );
        } catch (err) {
          result.textContent = err && err.message ? err.message : 'Could not activate sharing.';
        } finally {
          btn.disabled = false;
        }
      });
    }
    host.append(panel);
  }

  function buildFooter() {
    const footer = el('footer', { class: 'qb-footer' }, el('span', {}, `relay · ${boot.boardId}`));
    return footer;
  }

  function applyAccessRestrictions() {
    if (!access.canSubmit) submitbar.style.display = 'none';
    if (!access.canEditAnswers) {
      for (const node of app.querySelectorAll('.card input, .card textarea, .card button, .card select')) {
        // Viewer controls inside question/option blocks remain useful in a
        // read-only board (zoom, fit, full-screen, filtering, diff view). Block
        // mutation controls are independently gated by canEditBlocks.
        if (node.closest('.blocks')) continue;
        node.disabled = true;
      }
      for (const item of app.querySelectorAll('.rank-item')) {
        item.draggable = false;
        item.setAttribute('aria-disabled', 'true');
      }
    }
    document.documentElement.classList.toggle('relay-review', access.canEditComments === false || access.canDeleteComments === false);
  }
  if (access.role === 'review') {
    submitBtn.textContent = 'Submit side review';
    hint.textContent = 'Reference only — the owner still submits the final answer.';
    showNotice('Reviewer mode: your answers and comments are saved separately as a reference-only side review. Submitting here does not finalize the board or notify the waiting agent.', 'info');
  } else if (access.role === 'read') {
    showNotice('Read-only mode: you can view the board and existing feedback, but answers, comments, edits, and submission are disabled.', 'info');
  } else if (access.role === 'collab') {
    showNotice('Editor mode: answers, comments, and final submission are enabled for this shared board.', 'info');
  }
  applyAccessRestrictions();
  app.append(buildFooter());

