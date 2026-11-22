  // ---------- singleton DOM ----------
  function ensureDom() {
    if (dom) return;
    const pin = el('button', { class: 'ann-pin', type: 'button', title: 'Add a comment', 'aria-label': 'Add a comment' });
    pin.innerHTML =
      '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
      '<path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v5a1.5 1.5 0 0 1-1.5 1.5H8.4L5 13.4v-2.9H3A1.5 1.5 0 0 1 1.5 9V4A1.5 1.5 0 0 1 3 2.5Z" fill="currentColor"/></svg>';
    pin.addEventListener('mouseenter', () => clearTimeout(pinTimer));
    pin.addEventListener('mouseleave', scheduleHidePin);
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      const entry = pinEntry;
      hidePin();
      if (entry) openPopover(entry.info, entry.el);
    });

    const selBtn = el('button', { class: 'ann-selbtn', type: 'button' }, 'Comment');
    // preventDefault keeps the text selection alive through the click.
    selBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = pendingSelection;
      if (p) openPopover(p.info, selBtn); // anchor rect read while still visible
      hideSelBtn();
    });

    const pop = el('div', { class: 'ann-pop', role: 'dialog', 'aria-label': 'Comment' });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePopover();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (popSave) popSave();
      }
    });

    // Comments rail (Outline-style right sidebar) + its floating toggle and
    // narrow-screen scrim. The list is a summary target, so renderSummaries()
    // keeps it in sync; chrome (count, visibility) is refreshed separately.
    const railToggleCount = el('span', { class: 'ann-rail-toggle-count' }, '0');
    const railToggle = el('button', { class: 'ann-rail-toggle', type: 'button', 'aria-label': 'Comments' });
    railToggle.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v5a1.5 1.5 0 0 1-1.5 1.5H8.4L5 13.4v-2.9H3A1.5 1.5 0 0 1 1.5 9V4A1.5 1.5 0 0 1 3 2.5Z" fill="currentColor"/></svg>';
    railToggle.append(el('span', { class: 'ann-rail-toggle-label' }, 'Comments'), railToggleCount);
    railToggle.addEventListener('click', toggleRail);

    const railScrim = el('div', { class: 'ann-rail-scrim' });
    railScrim.addEventListener('click', closeRail);

    const railClose = el('button', { class: 'ann-rail-close', type: 'button', 'aria-label': 'Close comments', title: 'Close' }, '×');
    railClose.addEventListener('click', closeRail);
    const railHeadCount = el('span', { class: 'ann-rail-headcount' }, '');
    const railList = el('div', { class: 'ann-rail-list' });
    const rail = el('aside', { class: 'ann-rail', 'aria-label': 'Comments' },
      el('div', { class: 'ann-rail-head' },
        el('span', { class: 'ann-rail-title' }, 'Comments'),
        railHeadCount,
        railClose
      ),
      railList
    );

    document.body.append(pin, selBtn, pop, railToggle, railScrim, rail);
    dom = { pin, selBtn, pop, railToggle, railToggleCount, railScrim, rail, railList, railHeadCount };
    summaryEls.add(railList);

    document.addEventListener('selectionchange', () => {
      if (dom.selBtn.style.display === '' || dom.selBtn.style.display === 'none') return;
      const sel = window.getSelection();
      const txt = sel && !sel.isCollapsed ? sel.toString() : '';
      if (!pendingSelection || txt.slice(0, 500) !== pendingSelection.info.target.quote) hideSelBtn();
    });

    document.addEventListener('mousedown', (e) => {
      if (popOpen && !dom.pop.contains(e.target)) closePopover();
      if (!dom.selBtn.contains(e.target)) hideSelBtn();
    });

    // Capture-phase: also fires for nested scroll containers (mermaid pane…).
    // Keep an open composer re-anchored instead of closing it: scrolling is a
    // normal review action, and DOM-only draft text must never disappear merely
    // because the user looked elsewhere on the board.
    window.addEventListener('scroll', (e) => {
      hidePin();
      hideSelBtn();
      if (!popOpen) return;
      if (dom.pop.contains(e.target)) return; // textarea scrolling inside
      schedulePositionPopover();
    }, true);

    window.addEventListener('resize', () => {
      scheduleBadgeRefresh();
      schedulePositionPopover();
    });
  }

  // ---------- comments rail ----------
  function openRail() {
    if (!dom || torndown || !annotations.length) return;
    railOpen = true;
    dom.rail.classList.add('open');
    dom.railScrim.classList.add('show');
    document.body.classList.add('ann-rail-open');
  }
  function closeRail() {
    railOpen = false;
    if (!dom) return;
    dom.rail.classList.remove('open');
    dom.railScrim.classList.remove('show');
    document.body.classList.remove('ann-rail-open');
  }
  function toggleRail() {
    if (railOpen) closeRail();
    else openRail();
  }
  // Briefly flash the floating Comments button (used when a comment is added so
  // the user sees it landed, without auto-opening the rail / shifting layout).
  function pulseToggle() {
    if (!dom || !dom.railToggle) return;
    dom.railToggle.classList.remove('pulse');
    void dom.railToggle.offsetWidth; // reflow so the animation restarts
    dom.railToggle.classList.add('pulse');
  }
  // Sync the toggle badge + rail count with the live list; hide the whole rail
  // affordance when there are no comments.
  function refreshRailChrome() {
    if (!dom) return;
    const n = annotations.length;
    dom.railToggleCount.textContent = String(n);
    dom.railHeadCount.textContent = n ? `${n}` : '';
    dom.railToggle.style.display = n ? 'inline-flex' : 'none';
    if (!n) closeRail();
  }

  // ---------- hover pin ----------
  function showPin(entry) {
    if (disabled || !permissions.add) return;
    clearTimeout(pinTimer);
    pinEntry = entry;
    const rect = entry.el.getBoundingClientRect();
    const w = 22;
    const pin = dom.pin;
    pin.style.display = 'flex';
    pin.style.left = Math.max(4, Math.min(rect.right - w / 2, window.innerWidth - w - 4)) + 'px';
    pin.style.top = Math.max(4, Math.min(rect.top - w / 2, window.innerHeight - w - 4)) + 'px';
  }
  function scheduleHidePin() {
    clearTimeout(pinTimer);
    pinTimer = setTimeout(hidePin, 250); // delay so the pin itself is clickable
  }
  function hidePin() {
    clearTimeout(pinTimer);
    pinEntry = null;
    if (dom) dom.pin.style.display = 'none';
  }

