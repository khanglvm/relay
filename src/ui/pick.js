// pick.js — window.RelayPick: the `pick` question for both pages (web board and MCP App).
// A grid of media tiles; a tile is one button (Tab to reach it, Space or Enter to pick),
// with an optional note under each picked tile and one overall note under the grid.
// The answer is {picks:[{id, note?}], overall?}, ids in the order picked. Every string is
// set through textContent and every link is http(s) only, so agent text never becomes markup.
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HTTP = /^https?:\/\//i;
  const MEDIA_FILE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
  const NOTE_MAX = 2000;
  const OVERALL_MAX = 5000;
  const PATHS = {
    check: 'M20 6 9 17l-5-5',
    external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    play: 'm6 3 14 9-14 9z',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  };

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'pk-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', PATHS[name]);
    svg.append(path);
    return svg;
  }

  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const limitOf = (q) => (Number.isInteger(q.max) && q.max > 0 ? q.max : (q.items || []).length);

  /** Cuts a stored or default answer down to what the question allows. */
  function seed(q, prior) {
    const raw = asObject(prior);
    const known = new Set((q.items || []).map((t) => t.id));
    const seen = new Set();
    const picks = [];
    for (const entry of Array.isArray(raw.picks) ? raw.picks : []) {
      const id = typeof entry === 'string' ? entry : asObject(entry).id;
      if (typeof id !== 'string' || !known.has(id) || seen.has(id) || picks.length >= limitOf(q)) continue;
      seen.add(id);
      picks.push({ id, note: typeof entry === 'string' || q.itemNote === false ? '' : clip(entry.note, NOTE_MAX) });
    }
    return { picks, overall: q.overall === false ? '' : clip(raw.overall, OVERALL_MAX) };
  }

  /** The answer to submit, or undefined while the question counts as unanswered. */
  function value(q, stored) {
    const s = seed(q, stored);
    if (!s.picks.length && !s.overall) return undefined;
    const out = { picks: s.picks.map((p) => (p.note ? { id: p.id, note: p.note } : { id: p.id })) };
    if (s.overall) out.overall = s.overall;
    return out;
  }

  /** True while fewer tiles are picked than the question asks for. */
  function short(q, stored) {
    return seed(q, stored).picks.length < (q.min || 0);
  }

  const safeUrl = (u) => (typeof u === 'string' && HTTP.test(u) ? u : '');

  function mediaOf(q, tile) {
    const wrap = h('span', 'pk-media');
    const src = tile.image || (tile.hasImage ? `/img/p/${encodeURIComponent(q.id)}/${encodeURIComponent(tile.id)}` : '');
    if (src) {
      const img = h('img', 'pk-img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = src;
      wrap.append(img);
    } else if (tile.video && MEDIA_FILE.test(tile.video)) {
      const vid = h('video', 'pk-img');
      vid.muted = true;
      vid.loop = true;
      vid.playsInline = true;
      vid.preload = 'metadata';
      vid.src = safeUrl(tile.video);
      vid.setAttribute('aria-hidden', 'true');
      wrap.append(vid);
      const badge = h('span', 'pk-badge');
      badge.append(icon('play'));
      wrap.append(badge);
      wrap.addEventListener('mouseenter', () => vid.play().catch(() => {}));
      wrap.addEventListener('mouseleave', () => vid.pause());
    } else {
      wrap.classList.add('pk-nomedia');
      wrap.append(icon(tile.video ? 'play' : 'link'));
    }
    return wrap;
  }

  function openLink(tile) {
    const href = safeUrl(tile.url) || safeUrl(tile.video);
    if (!href) return null;
    const a = h('a', 'pk-open');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', `Open ${tile.title} in a new tab`);
    a.append(h('span', null, tile.url ? 'Open page' : 'Watch'), icon('external'));
    return a;
  }

  /**
   * Builds the control for one pick question.
   * @param {object} q normalized question
   * @param {{ answers: Record<string, any> }} state the page's answer state; this control owns state.answers[q.id]
   * @param {{ canEdit?: boolean, onChange?: () => void }} [hooks]
   */
  function control(q, state, hooks = {}) {
    const canEdit = hooks.canEdit !== false;
    const limit = limitOf(q);
    const items = q.items || [];
    state.answers[q.id] = seed(q, state.answers[q.id]);
    const cur = () => state.answers[q.id];

    const root = h('div', 'pk');
    const status = h('p', 'pk-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const grid = h('div', 'pk-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', q.label || 'Choices');
    const cells = new Map();

    const rule = () => {
      const min = q.min || 0;
      if (limit === 1) return 'Pick one.';
      if (min && min === limit) return `Pick ${min}.`;
      if (min) return `Pick ${min} to ${limit}.`;
      return limit < items.length ? `Pick up to ${limit}.` : 'Pick any number.';
    };

    function paint() {
      const picks = cur().picks;
      const full = picks.length >= limit && limit > 1;
      for (const [id, cell] of cells) {
        const at = picks.findIndex((p) => p.id === id);
        const on = at >= 0;
        cell.root.classList.toggle('sel', on);
        cell.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        cell.btn.setAttribute('aria-disabled', !on && full ? 'true' : 'false');
        cell.order.textContent = on && limit > 1 ? String(at + 1) : '';
        cell.noteWrap.hidden = !(on && q.itemNote !== false);
        if (!on) cell.note.value = '';
      }
      status.textContent = `${picks.length} picked. ${rule()}`;
    }

    function toggle(id) {
      if (!canEdit) return;
      const picks = cur().picks;
      const at = picks.findIndex((p) => p.id === id);
      if (at >= 0) picks.splice(at, 1);
      else if (limit === 1) picks.splice(0, picks.length, { id, note: '' });
      else if (picks.length < limit) picks.push({ id, note: '' });
      else return;
      paint();
      if (hooks.onChange) hooks.onChange();
    }

    for (const tile of items) {
      const btn = h('button', 'pk-pick');
      btn.type = 'button';
      btn.disabled = !canEdit;
      btn.setAttribute('aria-pressed', 'false');
      const order = h('span', 'pk-order');
      order.setAttribute('aria-hidden', 'true');
      const check = h('span', 'pk-check');
      check.append(icon('check'));
      check.append(order);
      const title = h('span', 'pk-title', tile.title);
      const head = h('span', 'pk-head');
      head.append(title, check);
      btn.append(mediaOf(q, tile), head);
      if (tile.caption) btn.append(h('span', 'pk-caption', tile.caption));
      btn.addEventListener('click', () => toggle(tile.id));

      const noteWrap = h('div', 'pk-notewrap');
      const note = h('textarea', 'pk-note');
      note.rows = 2;
      note.placeholder = 'Why this one? (optional)';
      note.setAttribute('aria-label', `Note on ${tile.title}`);
      const pickOf = () => cur().picks.find((p) => p.id === tile.id);
      note.value = (pickOf() && pickOf().note) || '';
      note.disabled = !canEdit;
      note.addEventListener('input', () => {
        const p = pickOf();
        if (!p) return;
        p.note = note.value;
        if (hooks.onChange) hooks.onChange();
      });
      noteWrap.append(note);

      const root = h('div', 'pk-tile');
      root.append(btn);
      const link = openLink(tile);
      if (link) root.append(link);
      root.append(noteWrap);
      cells.set(tile.id, { root, btn, order, noteWrap, note });
      grid.append(root);
    }

    root.append(grid, status);
    if (q.overall !== false) {
      const overall = h('textarea', 'pk-overall');
      overall.rows = 3;
      overall.placeholder = 'Anything to add about the whole set? (optional)';
      overall.setAttribute('aria-label', 'Overall note');
      overall.value = cur().overall || '';
      overall.disabled = !canEdit;
      overall.addEventListener('input', () => {
        cur().overall = overall.value;
        if (hooks.onChange) hooks.onChange();
      });
      root.append(overall);
    }
    paint();
    return root;
  }

  window.RelayPick = { control, seed, value, short };
})();
