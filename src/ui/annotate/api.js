  // ---------- public API ----------
  function normalizeList(value) {
    return Array.isArray(value)
      ? value.map((a) => ({
          ...a,
          author: a.author === 'agent' ? 'agent' : 'user',
          replies: Array.isArray(a.replies)
            ? a.replies
                .filter((r) => r && typeof r === 'object' && typeof r.text === 'string')
                .map((r) => ({
                  author: r.author === 'agent' ? 'agent' : 'user',
                  text: r.text,
                  createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
                }))
            : [],
        }))
      : [];
  }

  function resetCounter() {
    idCounter = 0;
    for (const a of annotations) {
      const m = /^a(\d+)$/.exec(String(a.id || ''));
      if (m) idCounter = Math.max(idCounter, parseInt(m[1], 10));
    }
  }

  function init(opts = {}) {
    ensureDom();
    // Normalize threads: missing author -> 'user', missing replies -> [].
    annotations = normalizeList(opts.initial);
    onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    permissions = {
      add: !(opts.permissions && opts.permissions.add === false),
      edit: !(opts.permissions && opts.permissions.edit === false),
      delete: !(opts.permissions && opts.permissions.delete === false),
      reply: !(opts.permissions && opts.permissions.reply === false),
    };
    resetCounter();
    scheduleBadgeRefresh();
    renderSummaries();
    refreshRailChrome();
  }

  // Remove every floating element (pin, badges, popover, selection button)
  // and stop reacting — called when the board reaches its submitted screen so
  // nothing leaks over it (they live on <body> with elevated z-index).
  let torndown = false;
  function teardown() {
    torndown = true;
    try {
      closePopover();
    } catch {
      // popover may not be open
    }
    hidePin();
    hideSelBtn();
    closeRail();
    for (const b of badges) b.remove();
    badges = [];
    registered = [];
    textRoots.clear();
    highlightMap.clear();
    commentDrafts.clear();
    if (dom) {
      dom.pin.remove();
      dom.selBtn.remove();
      dom.pop.remove();
      dom.railToggle.remove();
      dom.railScrim.remove();
      dom.rail.remove();
      summaryEls.delete(dom.railList);
      dom = null;
    }
  }

  function register(targetEl, info) {
    if (torndown) return;
    ensureDom();
    targetEl.classList.add('ann-target');
    const entry = { el: targetEl, info };
    registered.push(entry);
    targetEl.addEventListener('mouseenter', () => showPin(entry));
    targetEl.addEventListener('mouseleave', scheduleHidePin);
    scheduleBadgeRefresh();
  }

  function enableTextSelection(rootEl, baseInfo) {
    if (torndown) return;
    ensureDom();
    const blockId = (baseInfo && baseInfo.blockId != null) ? baseInfo.blockId : null;
    textRoots.set(blockId, rootEl);
    rootEl.addEventListener('mouseup', () => {
      if (torndown) return;
      // defer: the selection settles after mouseup
      setTimeout(() => maybeShowSelBtn(rootEl, baseInfo), 0);
    });
    // Re-anchor any saved text comments for this root (reload / prefill path).
    applyHighlightsForRoot(rootEl, blockId);
  }

  function openExternal(info, anchorEl) {
    if (torndown) return;
    openPopover(info, anchorEl);
  }

  function list() {
    return annotations.slice();
  }

  function setList(next) {
    annotations = normalizeList(next);
    resetCounter();
    scheduleBadgeRefresh();
    renderSummaries();
    refreshRailChrome();
  }

  // True while the user is mid-comment: the popover is open, which hosts both
  // the "Add a comment" box and every thread's reply input. That text lives
  // only in the DOM until Save, so the board must not reload it away.
  function isComposing() {
    return popOpen;
  }

  // Commit a mid-typed comment (the open popover's "Add a comment" box) as a
  // saved annotation, then close it — so freezing the board doesn't throw away
  // text the user was in the middle of writing. ponytail: only the main comment
  // box is flushed, not an in-progress thread reply (the rare case).
  function flushOpen() {
    if (popOpen && popSave) { try { popSave(); } catch { closePopover(); } }
  }

  // Freeze/unfreeze comment creation. While disabled, no pin, selection button,
  // or popover appears, so the user can't start feedback that won't be saved.
  function setDisabled(v) {
    disabled = Boolean(v);
    // Also close the rail flushOpen() may have just opened — otherwise it covers
    // the host's top-right "connection lost" notice.
    if (disabled) { closePopover(); hideSelBtn(); hidePin(); closeRail(); }
  }

  function renderSummary(target) {
    ensureDom();
    summaryEls.add(target);
    renderSummaryInto(target);
  }

  window.RelayAnnotate = { init, register, enableTextSelection, openExternal, list, setList, renderSummary, onBadgeRefresh, teardown, isComposing, flushOpen, setDisabled };
