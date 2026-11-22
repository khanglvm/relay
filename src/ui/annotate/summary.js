  // ---------- summary ----------
  function renderSummaries() {
    for (const t of summaryEls) {
      if (!t.isConnected) {
        summaryEls.delete(t);
        continue;
      }
      renderSummaryInto(t);
    }
  }

  function renderSummaryInto(target) {
    const isRail = target.classList.contains('ann-rail-list');
    target.classList.add('ann-summary');
    target.replaceChildren();
    if (!annotations.length) {
      target.style.display = 'none';
      return;
    }
    target.style.display = '';
    // The rail has its own header chrome; standalone summaries get a heading.
    if (!isRail) target.append(el('h3', { class: 'ann-sum-head' }, `Comments (${annotations.length})`));
    for (const a of annotations) {
      const del = el('button', { class: 'ann-del', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' });
      del.innerHTML = ICON_TRASH;
      del.addEventListener('click', (e) => { e.stopPropagation(); requestDelete(a.id); });
      // Thread meta: reply count, plus an "agent" chip when the latest entry
      // in the thread (last reply, or the comment itself) is agent-authored.
      const replyCount = Array.isArray(a.replies) ? a.replies.length : 0;
      const latest = replyCount ? a.replies[replyCount - 1] : a;
      const meta = [];
      if (replyCount) meta.push(el('span', { class: 'ann-sum-replies' }, `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`));
      if (latest.author === 'agent') meta.push(chip('agent'));
      const row = el('div', { class: 'ann-sum-row' },
        el('div', { class: 'ann-sum-main' },
          el('div', { class: 'ann-sum-target' }, humanize(a.target)),
          el('div', { class: 'ann-sum-text' }, a.text),
          meta.length ? el('div', { class: 'ann-sum-meta' }, meta) : null
        ),
        permissions.delete ? del : null
      );
      // Clicking a row jumps to (and flashes) the matching element: a
      // registered block element, or the inline highlight for a text comment.
      row.addEventListener('click', () => {
        const entry = registered.find(
          (r) => r.el.isConnected && sameBlock(r.info.blockId, a.blockId) && sameTarget(r.info.target, a.target)
        );
        let jump = entry ? entry.el : null;
        if (!jump && a.target && a.target.kind === 'text') {
          const marks = highlightMap.get(sigOf(a.blockId, a.target));
          jump = marks && marks.find((m) => m.isConnected);
        }
        // Fallback for targets with no registered element (e.g. chart data
        // points / whole-block comments): flash the whole block container.
        if (!jump && a.blockId != null) {
          jump = document.querySelector('[data-block-id="' + String(a.blockId).replace(/"/g, '\\"') + '"]');
        }
        if (!jump) return;
        // On narrow screens the rail overlays the page — close it so the
        // flashed target is actually visible.
        if (isRail && window.matchMedia('(max-width: 1179px)').matches) closeRail();
        flashEl(jump);
      });
      target.append(row);
    }
  }

