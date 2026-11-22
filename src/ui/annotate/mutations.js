  // ---------- mutations ----------
  function addAnnotation(info, text) {
    if (!permissions.add) return;
    annotations.push({
      id: 'a' + (++idCounter),
      questionId: info.questionId !== undefined ? info.questionId : null,
      blockId: info.blockId !== undefined ? info.blockId : null,
      target: info.target,
      text,
      createdAt: new Date().toISOString(),
      author: 'user',
      replies: [],
    });
    // Highlight the selected text in place (re-located via its quote anchors,
    // since the live selection is already gone by save time).
    if (info.target && info.target.kind === 'text') {
      const sig = sigOf(info.blockId, info.target);
      const root = textRoots.get(info.blockId ?? null);
      if (root && !highlightMap.has(sig)) {
        const range = findRangeByQuote(root, info.target);
        if (range) {
          const marks = wrapRange(range, sig, { blockId: info.blockId ?? null, questionId: info.questionId ?? null, target: info.target });
          if (marks.length) highlightMap.set(sig, marks);
        }
      }
    }
    changed();
    // Don't auto-open the rail — that shifts the board layout. Just flash the
    // floating Comments button so the user notices, and opens it when they want.
    pulseToggle();
  }

  // Append a user reply to a top-level annotation's thread (cap 50, like the
  // server). Empty text is ignored by callers.
  function addReply(id, text) {
    if (!permissions.reply) return;
    const a = annotations.find((x) => x.id === id);
    if (!a) return;
    if (!Array.isArray(a.replies)) a.replies = [];
    if (a.replies.length >= 50) return;
    a.replies.push({
      author: 'user',
      text: String(text).slice(0, 5000),
      createdAt: new Date().toISOString(),
    });
    changed();
  }

  // Edit a top-level comment's text in place (author edits their own comment).
  function editAnnotation(id, text) {
    if (!permissions.edit) return;
    const a = annotations.find((x) => x.id === id);
    if (!a) return;
    const t = String(text).slice(0, 5000).trim();
    if (!t) return;
    a.text = t;
    changed();
  }

  function removeAnnotation(id) {
    if (!permissions.delete) return;
    const i = annotations.findIndex((a) => a.id === id);
    if (i < 0) return;
    const removed = annotations[i];
    annotations.splice(i, 1);
    // Drop the inline highlight once the last comment on that text is gone.
    if (removed.target && removed.target.kind === 'text') {
      const sig = sigOf(removed.blockId, removed.target);
      if (!annotations.some((a) => sigOf(a.blockId, a.target) === sig)) unwrapHighlight(sig);
    }
    changed();
  }

  function changed() {
    scheduleBadgeRefresh();
    renderSummaries();
    refreshRailChrome();
    if (onChange) onChange(annotations.slice());
  }

  // ---------- text selection ----------
  function hideSelBtn() {
    pendingSelection = null;
    if (dom) dom.selBtn.style.display = 'none';
  }

  function maybeShowSelBtn(rootEl, baseInfo) {
    if (disabled || !permissions.add) return hideSelBtn();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelBtn();
    if (!rootEl.contains(sel.anchorNode) || !rootEl.contains(sel.focusNode)) return hideSelBtn();
    const range = sel.getRangeAt(0);
    const quote = range.toString();
    if (!quote.trim()) return hideSelBtn();

    const pre = document.createRange();
    pre.selectNodeContents(rootEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const post = document.createRange();
    post.selectNodeContents(rootEl);
    post.setStart(range.endContainer, range.endOffset);
    pendingSelection = {
      info: {
        blockId: baseInfo.blockId !== undefined ? baseInfo.blockId : null,
        questionId: baseInfo.questionId !== undefined ? baseInfo.questionId : null,
        target: {
          kind: 'text',
          quote: quote.slice(0, 500),
          prefix: pre.toString().slice(-30),
          suffix: post.toString().slice(0, 30),
        },
      },
    };

    // Float the button near the end of the selection.
    const rects = range.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const btn = dom.selBtn;
    btn.style.display = 'block';
    const bw = btn.offsetWidth || 90;
    const bh = btn.offsetHeight || 30;
    let top = last.bottom + 6;
    if (top + bh > window.innerHeight - 8) top = last.top - bh - 6;
    btn.style.left = Math.max(8, Math.min(last.right - bw / 2, window.innerWidth - bw - 8)) + 'px';
    btn.style.top = Math.max(8, top) + 'px';
  }

