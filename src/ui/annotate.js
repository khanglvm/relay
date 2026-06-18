/* relay annotate — element-level comments (window.RelayAnnotate).
   Self-contained vanilla JS: hover pin, count badges, comment popover,
   text-selection capture, and an editable summary list. Zero dependencies.
   Load order: blocks.js, annotate.js, app.js (all inlined by the server). */
(() => {
  'use strict';

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(c));
    }
    return n;
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // Humanized target label shown in the popover and the summary list.
  function humanize(t) {
    if (!t || typeof t !== 'object') return 'Element';
    switch (t.kind) {
      case 'chart-element': {
        const parts = [];
        if (t.label !== undefined && t.label !== null && t.label !== '') parts.push(truncate(t.label, 40));
        if (typeof t.datasetIndex === 'number') parts.push(`series ${t.datasetIndex + 1}`);
        if (t.value !== undefined && t.value !== null) {
          parts.push(truncate(typeof t.value === 'object' ? JSON.stringify(t.value) : t.value, 30));
        }
        return 'Chart · ' + (parts.join(' · ') || 'element');
      }
      case 'mermaid-node':
        return 'Diagram · ' + truncate(t.text || t.nodeId || 'node', 50);
      case 'graphviz-node':
        return 'Graph · ' + truncate(t.text || t.nodeId || 'node', 50);
      case 'plantuml-node':
        return 'Diagram · ' + truncate(t.text || 'element', 50);
      case 'image':
        return truncate(t.label || 'Image', 50);
      case 'table-cell': {
        let s = `Table · row ${(Number(t.row) || 0) + 1} · ${t.col}`;
        if (t.value !== undefined && t.value !== null && t.value !== '') s += ` — “${truncate(t.value, 30)}”`;
        return s;
      }
      case 'text':
        return `“${truncate(t.quote || '', 60)}”`;
      case 'html-element':
        return truncate(t.label || 'Element', 50) + (t.detail ? ` — ${truncate(t.detail, 40)}` : '');
      case 'block':
        return 'Whole ' + truncate(t.label || 'block', 40);
      default:
        return t.kind || 'Element';
    }
  }

  // Target equality for badge re-binding = stringify equality within a block.
  const sameTarget = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameBlock = (a, b) => (a ?? null) === (b ?? null);

  // Author chip: "you" (muted) for user comments, "agent" (accent) for agent.
  function chip(author) {
    const agent = author === 'agent';
    return el('span', { class: 'ann-chip' + (agent ? ' ann-chip-agent' : '') }, agent ? 'agent' : 'you');
  }

  // Short HH:MM timestamp (empty string when the date is unparsable).
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function timeEl(iso) {
    const t = fmtTime(iso);
    return t ? el('span', { class: 'ann-time' }, t) : null;
  }

  // ---------- state ----------
  let annotations = [];        // contract annotation objects
  let idCounter = 0;           // continues from max existing "aN"
  let onChange = null;
  let registered = [];         // [{el, info: {blockId, questionId, target}}]
  const summaryEls = new Set();
  let badges = [];             // live badge nodes (rebuilt on every refresh)
  let pendingSelection = null; // {info} captured at mouseup time

  // Text-selection comments are anchored back into the document as inline
  // <mark> highlights. textRoots maps a blockId (null = intro/board) to the
  // element whose text can be highlighted; highlightMap maps a target
  // signature to its live <mark> nodes so we can flash or unwrap them.
  const textRoots = new Map();
  const highlightMap = new Map();

  let dom = null;              // {pin, selBtn, pop, rail, railList, railToggle, railScrim, ...}
  let pinTimer = null;
  let pinEntry = null;
  let popOpen = false;
  let popScrollY = 0;
  let popSave = null;
  let badgeTimer = 0;
  let railOpen = false;

  // Stable signature for a (blockId, target) pair — same key matching() groups by.
  const sigOf = (blockId, target) => JSON.stringify({ b: blockId ?? null, t: target });

  // Brief highlight pulse used by the rail's jump-to.
  function flashEl(target) {
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('ann-flash');
    void target.getBoundingClientRect(); // restart the animation
    target.classList.add('ann-flash');
    setTimeout(() => target.classList.remove('ann-flash'), 1000);
  }

  // ---------- text-selection highlights ----------
  // Re-locate a saved text quote inside a root using its prefix/suffix anchors,
  // returning a live Range (or null when the text can't be found anymore).
  function findRangeByQuote(root, target) {
    const quote = target && target.quote ? String(target.quote) : '';
    if (!quote) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const map = []; // [{ node, start }] start = offset in `full`
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      map.push({ node, start: full.length });
      full += node.nodeValue;
    }
    if (!map.length) return null;
    const prefix = target.prefix || '';
    const suffix = target.suffix || '';
    const hits = [];
    let from = 0;
    let idx;
    while ((idx = full.indexOf(quote, from)) !== -1) {
      hits.push(idx);
      from = idx + 1;
    }
    if (!hits.length) return null;
    let chosen = hits[0];
    for (const h of hits) {
      const before = full.slice(Math.max(0, h - prefix.length), h);
      const after = full.slice(h + quote.length, h + quote.length + suffix.length);
      if ((!prefix || before.endsWith(prefix)) && (!suffix || after.startsWith(suffix))) {
        chosen = h;
        break;
      }
    }
    const locate = (off) => {
      for (const m of map) {
        if (off <= m.start + m.node.nodeValue.length) return { node: m.node, offset: off - m.start };
      }
      const last = map[map.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    };
    const s = locate(chosen);
    const e = locate(chosen + quote.length);
    const range = document.createRange();
    try {
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
    } catch {
      return null;
    }
    return range;
  }

  // Wrap every text-node segment inside `range` in its own <mark>; clicking a
  // mark opens the comment popover for that target. Returns the mark nodes.
  function wrapRange(range, sig, info) {
    const sC = range.startContainer;
    const sO = range.startOffset;
    const eC = range.endContainer;
    const eO = range.endOffset;
    const anc = range.commonAncestorContainer;
    const root = anc.nodeType === 1 ? anc : anc.parentNode;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const all = [];
    let n;
    while ((n = walker.nextNode())) all.push(n);
    // Decide membership BEFORE mutating the DOM (splitText adds new siblings).
    const inRange = all.filter((node) => {
      try {
        return range.intersectsNode(node);
      } catch {
        return false;
      }
    });
    const marks = [];
    for (const orig of inRange) {
      let fromOff = 0;
      let toOff = orig.nodeValue.length;
      if (orig === sC) fromOff = sO;
      if (orig === eC) toOff = eO;
      if (fromOff >= toOff) continue;
      let seg = orig;
      if (fromOff > 0) seg = seg.splitText(fromOff);
      if (toOff - fromOff < seg.nodeValue.length) seg.splitText(toOff - fromOff);
      const mark = el('mark', { class: 'ann-hl', 'data-sig': sig });
      seg.parentNode.insertBefore(mark, seg);
      mark.appendChild(seg);
      mark.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPopover(info, mark);
      });
      marks.push(mark);
    }
    return marks;
  }

  function unwrapHighlight(sig) {
    const marks = highlightMap.get(sig);
    if (!marks) return;
    for (const m of marks) {
      if (!m.isConnected) continue;
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    highlightMap.delete(sig);
  }

  // Highlight every saved text annotation whose blockId matches this root and
  // that isn't already wrapped (idempotent — safe to call on every register).
  function applyHighlightsForRoot(root, blockId) {
    const key = blockId ?? null;
    const seen = new Set();
    for (const a of annotations) {
      if (!a.target || a.target.kind !== 'text') continue;
      if ((a.blockId ?? null) !== key) continue;
      const sig = sigOf(a.blockId, a.target);
      if (seen.has(sig) || highlightMap.has(sig)) continue;
      seen.add(sig);
      const range = findRangeByQuote(root, a.target);
      if (!range) continue;
      const info = { blockId: a.blockId ?? null, questionId: a.questionId ?? null, target: a.target };
      const marks = wrapRange(range, sig, info);
      if (marks.length) highlightMap.set(sig, marks);
    }
  }

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
    window.addEventListener('scroll', (e) => {
      hidePin();
      hideSelBtn();
      if (!popOpen) return;
      if (dom.pop.contains(e.target)) return; // textarea scrolling inside
      const isPage = e.target === document || e.target === document.documentElement || e.target === document.body;
      if (!isPage || Math.abs(window.scrollY - popScrollY) > 80) closePopover();
    }, true);

    window.addEventListener('resize', scheduleBadgeRefresh);
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

  // ---------- popover ----------
  function closePopover() {
    if (!popOpen) return;
    popOpen = false;
    popSave = null;
    dom.pop.style.display = 'none';
    dom.pop.replaceChildren();
  }

  function openPopover(info, anchorEl) {
    ensureDom();
    closePopover();
    hidePin();
    const pop = dom.pop;
    pop.replaceChildren(el('div', { class: 'ann-pop-label' }, humanize(info.target)));

    // Existing comments on this exact target, rendered as threads: author
    // chip + time + delete, the comment text, its replies indented below,
    // and a compact reply input per thread. Deleting a comment deletes its
    // whole thread.
    const existingWrap = el('div', { class: 'ann-pop-existing' });
    const renderExisting = () => {
      existingWrap.replaceChildren();
      for (const a of matching(info)) {
        const del = el('button', { class: 'ann-del', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' }, '×');
        del.addEventListener('click', () => {
          removeAnnotation(a.id);
          renderExisting();
        });
        const thread = el('div', { class: 'ann-thread' },
          el('div', { class: 'ann-thread-head' }, chip(a.author), timeEl(a.createdAt), del),
          el('div', { class: 'ann-pop-text' }, a.text)
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
        thread.append(el('div', { class: 'ann-reply-form' }, input, btn));
        existingWrap.append(thread);
      }
    };
    renderExisting();
    pop.append(existingWrap);

    const ta = el('textarea', { class: 'ann-ta', placeholder: 'Add a comment…', rows: '3' });
    const save = el('button', { class: 'ann-save', type: 'button' }, 'Save');
    const cancel = el('button', { class: 'ann-cancel', type: 'button' }, 'Cancel');
    popSave = () => {
      const text = ta.value.trim();
      if (text) addAnnotation(info, text);
      closePopover();
    };
    save.addEventListener('click', () => popSave && popSave());
    cancel.addEventListener('click', closePopover);
    pop.append(ta, el('div', { class: 'ann-pop-actions' }, save, cancel));

    // Position: prefer below the anchor, flip above when out of room,
    // clamp to the viewport with an 8px margin. Fixed positioning, so we
    // recompute on open and simply close on big scrolls.
    pop.style.display = 'block';
    pop.style.visibility = 'hidden';
    const rect = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 8 && rect.top - ph - 8 >= 8) top = rect.top - ph - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = '';
    popOpen = true;
    popScrollY = window.scrollY;
    ta.focus();
  }

  // ---------- mutations ----------
  function addAnnotation(info, text) {
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
    openRail(); // surface the new comment in the sidebar, Outline-style
  }

  // Append a user reply to a top-level annotation's thread (cap 50, like the
  // server). Empty text is ignored by callers.
  function addReply(id, text) {
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

  function removeAnnotation(id) {
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
      const del = el('button', { class: 'ann-del', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment' }, '×');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeAnnotation(a.id);
      });
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
        del
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

  // ---------- public API ----------
  function init(opts = {}) {
    ensureDom();
    // Normalize threads: missing author -> 'user', missing replies -> [].
    annotations = Array.isArray(opts.initial)
      ? opts.initial.map((a) => ({
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
    onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    idCounter = 0;
    for (const a of annotations) {
      const m = /^a(\d+)$/.exec(String(a.id || ''));
      if (m) idCounter = Math.max(idCounter, parseInt(m[1], 10));
    }
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

  function renderSummary(target) {
    ensureDom();
    summaryEls.add(target);
    renderSummaryInto(target);
  }

  window.RelayAnnotate = { init, register, enableTextSelection, openExternal, list, renderSummary, onBadgeRefresh, teardown };
})();
