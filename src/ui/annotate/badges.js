  // ---------- badges ----------
  function matching(info) {
    return annotations.filter((a) => sameBlock(a.blockId, info.blockId) && sameTarget(a.target, info.target));
  }

  function scheduleBadgeRefresh() {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = 0;
      refreshBadges();
    }, 0);
  }

  // Hosts (e.g. blocks.js chart badge / comment button) subscribe here to be
  // notified on every badge refresh — i.e. whenever annotations change — so
  // their own indicators stay in sync. Returns an unsubscribe fn.
  const badgeHooks = new Set();
  function onBadgeRefresh(fn) {
    if (typeof fn === 'function') badgeHooks.add(fn);
    return () => badgeHooks.delete(fn);
  }

  function refreshBadges() {
    for (const b of badges) b.remove();
    badges = [];
    if (torndown) { for (const fn of badgeHooks) { try { fn(); } catch (_) {} } return; }
    registered = registered.filter((r) => r.el.isConnected);
    // While a block is expanded full-screen, body-level overlay badges for
    // OTHER blocks would float above the overlay at stale positions — only
    // badge elements inside the expanded block.
    const fullEl = document.body.classList.contains('blk-full-open')
      ? document.querySelector('.blk-full')
      : null;
    for (const entry of registered) {
      if (fullEl && !fullEl.contains(entry.el)) continue;
      const count = matching(entry.info).length;
      if (!count) continue;
      const badge = el('span', { class: 'ann-badge', title: count + (count === 1 ? ' comment' : ' comments') }, String(count));
      badge.addEventListener('mousedown', (e) => e.stopPropagation());
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        hidePin();
        openPopover(entry.info, entry.el);
      });
      if (entry.el instanceof HTMLElement && !(entry.el instanceof HTMLImageElement)) {
        // a normal HTML element hosts the badge as a child — it tracks naturally
        if (getComputedStyle(entry.el).position === 'static') entry.el.classList.add('ann-rel');
        entry.el.append(badge);
      } else {
        // SVG node or <img> — neither can host an HTML child. Anchor the badge
        // INSIDE the scrollable diagram viewport in CONTENT coordinates: as an
        // absolutely-positioned child of the scroll box it rides with the content
        // on drag-pan / container-scroll / page-scroll, with no listener needed.
        // (A document-body overlay stayed put when the diagram itself scrolled.)
        badge.classList.add('ann-badge-overlay');
        const host = entry.el.closest ? entry.el.closest('.blk-viewer') : null;
        const r = entry.el.getBoundingClientRect();
        if (host) {
          const cr = host.getBoundingClientRect();
          const cs = getComputedStyle(host);
          const bL = parseFloat(cs.borderLeftWidth) || 0;
          const bT = parseFloat(cs.borderTopWidth) || 0;
          badge.style.left = (r.right - cr.left - bL + host.scrollLeft - 10) + 'px';
          badge.style.top = (r.top - cr.top - bT + host.scrollTop - 6) + 'px';
          host.append(badge);
        } else {
          badge.style.left = (r.right + window.scrollX - 10) + 'px';
          badge.style.top = (r.top + window.scrollY - 6) + 'px';
          document.body.append(badge);
        }
      }
      badges.push(badge);
    }
    for (const fn of badgeHooks) { try { fn(); } catch (_) {} }
  }

