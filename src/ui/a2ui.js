// a2ui.js — window.RelayA2ui.render(block, ctx, blockId): draws one `a2ui`
// block (A2UI v1.0 components from Relay's catalog) as plain DOM. Every string
// goes in through textContent and every link is https-only, so agent text can
// never become markup. State and event logging live in a2ui-state.js.
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TONES = ['info', 'ok', 'warn', 'error', 'needs'];
  const TONE_WORDS = { info: 'Info', ok: 'OK', warn: 'Warning', error: 'Failed', needs: 'Needs you' };
  const HTTPS = /^https:\/\//i;

  // Lucide-style 24x24 stroke paths for the catalog's Icon set.
  const ICONS = {
    check: 'M20 6 9 17l-5-5',
    alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    x: 'M18 6 6 18M6 6l12 12',
    clock: 'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    'git-branch': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
    play: 'm6 3 14 9-14 9z',
    star: 'm12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
    lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
    external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function icon(name, label) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'a2-icon');
    for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.info);
    svg.append(path);
    return svg;
  }

  const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const toneOf = (v) => (TONES.includes(v) ? v : '');

  function pill(label, tone) {
    return el('span', 'a2-pill' + (toneOf(tone) ? ' a2-tone-' + tone : ''), label);
  }

  // Runs `paint` now and again after every state change, so bound props stay live.
  function live(store, paint) {
    paint();
    store.subscribe(paint);
  }

  function renderList(c, store) {
    const wrap = el('div', 'a2-list');
    live(store, () => {
      const rows = store.resolve(c.items);
      const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
      const max = c.max || list.length;
      wrap.replaceChildren();
      for (const row of list.slice(0, max)) {
        const item = el('div', 'a2-item');
        const main = el('div', 'a2-row-main');
        const title = HTTPS.test(text(row.url)) ? Object.assign(el('a', 'a2-row-title', text(row.title)), { href: row.url, target: '_blank', rel: 'noopener noreferrer' }) : el('div', 'a2-row-title', text(row.title));
        main.append(title);
        if (row.subtitle) main.append(el('div', 'a2-row-sub', text(row.subtitle)));
        item.append(main);
        const tone = toneOf(row.tone);
        if (tone) item.append(pill(row.trailing ? text(row.trailing) : TONE_WORDS[tone], tone));
        else if (row.trailing) item.append(el('div', 'a2-row-trail', text(row.trailing)));
        wrap.append(item);
      }
      if (list.length > max) wrap.append(el('div', 'a2-row-more', `${list.length - max} more`));
      if (!list.length) wrap.append(el('div', 'a2-row-more', 'Nothing here yet'));
    });
    return wrap;
  }

  function renderTable(c, store) {
    const scroller = el('div', 'a2-table-wrap');
    const table = el('table', 'a2-table');
    scroller.append(table);
    live(store, () => {
      const rows = store.resolve(c.rows);
      const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
      table.replaceChildren();
      const head = el('tr');
      for (const col of c.columns) head.append(el('th', '', col.label));
      const thead = el('thead');
      thead.append(head);
      table.append(thead);
      const body = el('tbody');
      for (const row of list.slice(0, c.max || list.length)) {
        const tr = el('tr');
        for (const col of c.columns) tr.append(el('td', '', Object.hasOwn(row, col.key) ? text(row[col.key]) : ''));
        body.append(tr);
      }
      table.append(body);
    });
    return scroller;
  }

  function renderProgress(c, store) {
    const wrap = el('div', 'a2-progress');
    const head = el('div', 'a2-progress-head');
    const label = el('span', '');
    const figure = el('span', 'a2-muted');
    head.append(label, figure);
    const bar = el('div', 'a2-bar');
    bar.setAttribute('role', 'progressbar');
    const fill = el('div', 'a2-bar-fill');
    bar.append(fill);
    const note = el('div', 'a2-muted');
    wrap.append(head, bar, note);
    live(store, () => {
      const value = Number(store.resolve(c.value)) || 0;
      const total = Number(store.resolve(c.total)) || 0;
      const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
      label.textContent = text(store.resolve(c.label));
      figure.textContent = `${value} of ${total}`;
      fill.style.width = pct + '%';
      bar.className = 'a2-bar' + (toneOf(c.tone) ? ' a2-tone-' + c.tone : '');
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-label', text(store.resolve(c.label)));
      note.textContent = text(store.resolve(c.note));
      note.hidden = !note.textContent;
    });
    return wrap;
  }

  // A labelled input bound to `c.path`; `read` and `write` adapt the control's value.
  function field(c, store, control, { read, write, event = 'input' }) {
    const wrap = el('label', 'a2-field');
    const caption = el('span', 'a2-field-label');
    wrap.append(caption, control);
    live(store, () => {
      caption.textContent = text(store.resolve(c.label));
      const value = store.get(c.path);
      if (document.activeElement !== control) write(control, value);
    });
    control.addEventListener(event, () => store.set(c.path, read(control)));
    return wrap;
  }

  function renderInput(c, store, interactive) {
    let wrap;
    if (c.component === 'TextField') {
      const input = c.multiline ? el('textarea', 'a2-input') : Object.assign(el('input', 'a2-input'), { type: 'text' });
      if (c.multiline) input.rows = 3;
      if (c.placeholder) input.placeholder = text(store.resolve(c.placeholder));
      wrap = field(c, store, input, { read: (n) => n.value, write: (n, v) => { n.value = text(v); } });
    } else if (c.component === 'Toggle') {
      const box = Object.assign(el('input', 'a2-check'), { type: 'checkbox' });
      wrap = field(c, store, box, { read: (n) => n.checked, write: (n, v) => { n.checked = v === true; }, event: 'change' });
      wrap.classList.add('a2-field-inline');
    } else if (c.component === 'Select') {
      const select = el('select', 'a2-input');
      for (const o of c.options) select.append(Object.assign(el('option', '', o.label), { value: o.key }));
      // An untouched Select still answers with its first option, as the control shows it.
      if (store.get(c.path) === undefined) window.RelayA2uiState.set(store.data, c.path, c.options[0].key);
      wrap = field(c, store, select, { read: (n) => n.value, write: (n, v) => { n.value = text(v); }, event: 'change' });
    } else {
      const range = Object.assign(el('input', 'a2-range'), { type: 'range', min: c.min, max: c.max, step: c.step || 'any' });
      const readout = el('span', 'a2-muted');
      wrap = field(c, store, range, { read: (n) => Number(n.value), write: (n, v) => { n.value = typeof v === 'number' ? v : c.min; readout.textContent = n.value; } });
      wrap.append(readout);
      range.addEventListener('input', () => { readout.textContent = range.value; });
    }
    wrap.querySelectorAll('input,select,textarea').forEach((n) => { n.disabled = !interactive; });
    return wrap;
  }

  function renderButton(c, store, interactive, onFired) {
    const button = el('button', 'a2-btn' + (c.style === 'primary' ? ' a2-btn-primary' : ''));
    button.type = 'button';
    live(store, () => { button.textContent = text(store.resolve(c.label)); });
    const call = c.action.functionCall;
    if (call) {
      button.addEventListener('click', () => { if (HTTPS.test(call.args.url)) window.open(call.args.url, '_blank', 'noopener,noreferrer'); });
      button.prepend(icon('external'));
      return button;
    }
    button.disabled = !interactive;
    button.addEventListener('click', () => {
      store.fire(c.action.event.name, c.action.event.context);
      onFired(button);
    });
    return button;
  }

  const GAPS = { xs: '4px', sm: '8px', md: '12px', lg: '16px' };

  function build(c, byId, store, env) {
    const kids = () => (c.children || []).map((id) => byId.has(id) ? build(byId.get(id), byId, store, env) : null).filter(Boolean);
    switch (c.component) {
      case 'Card': {
        const card = el('div', 'a2-card');
        if (c.title) { const t = el('div', 'a2-card-title'); live(store, () => { t.textContent = text(store.resolve(c.title)); }); card.append(t); }
        card.append(...kids());
        return card;
      }
      case 'Stack': {
        const s = el('div', 'a2-stack a2-' + (c.direction === 'row' ? 'row' : 'col'));
        s.style.gap = GAPS[c.gap] || GAPS.sm;
        if (c.align) s.style.alignItems = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' }[c.align];
        s.append(...kids());
        return s;
      }
      case 'Grid': {
        const g = el('div', 'a2-grid a2-cols-' + c.columns);
        g.style.gap = GAPS[c.gap] || GAPS.sm;
        g.append(...kids());
        return g;
      }
      case 'Text': {
        const t = el('div', 'a2-text a2-text-' + (['title', 'muted'].includes(c.variant) ? c.variant : 'body'));
        live(store, () => { t.textContent = text(store.resolve(c.text)); });
        return t;
      }
      case 'Pill': {
        const p = pill('', c.tone);
        live(store, () => { p.textContent = text(store.resolve(c.text)); });
        return p;
      }
      case 'Metric': {
        const m = el('div', 'a2-metric');
        const [l, v, n] = [el('div', 'a2-metric-label'), el('div', 'a2-metric-value'), el('div', 'a2-muted')];
        m.append(l, v, n);
        live(store, () => { l.textContent = text(store.resolve(c.label)); v.textContent = text(store.resolve(c.value)); n.textContent = text(store.resolve(c.note)); n.hidden = !n.textContent; });
        return m;
      }
      case 'List': return renderList(c, store);
      case 'Table': return renderTable(c, store);
      case 'Progress': return renderProgress(c, store);
      case 'Code': {
        const pre = el('pre', 'a2-code');
        const code = el('code');
        pre.append(code);
        live(store, () => { code.textContent = text(store.resolve(c.code)); });
        return pre;
      }
      case 'Image': {
        const img = el('img', 'a2-image');
        img.loading = 'lazy';
        img.alt = text(store.resolve(c.alt));
        if (HTTPS.test(c.url)) img.src = c.url;
        return img;
      }
      case 'Icon': { const i = icon(c.name, text(store.resolve(c.label))); if (toneOf(c.tone)) i.classList.add('a2-tone-' + c.tone); return i; }
      case 'Divider': return el('hr', 'a2-divider');
      case 'Button': return renderButton(c, store, env.interactive, env.onFired);
      default: return renderInput(c, store, env.interactive);
    }
  }

  function render(block, ctx, blockId) {
    const wrap = el('div', 'blk-a2ui a2');
    const components = Array.isArray(block.components) ? block.components : [];
    const byId = new Map(components.map((c) => [c.id, c]));
    const root = byId.get('root');
    if (!root) { wrap.append(el('div', 'blk-error', 'This A2UI widget has no root.')); return wrap; }
    const prior = ctx.edits && ctx.edits[blockId] && ctx.edits[blockId].type === 'a2ui' ? ctx.edits[blockId] : null;
    const store = window.RelayA2uiState.createStore(block.dataModel || {}, prior, (snapshot) => ctx.onBlockEdit(blockId, snapshot));
    const interactive = ctx.canEditBlocks !== false && ctx.canComment !== false;
    const status = el('div', 'a2-status a2-muted');
    status.setAttribute('role', 'status');
    const showSent = () => { status.textContent = 'Recorded. It goes back with your answer when you submit.'; };
    if (store.eventCount()) showSent();
    const onFired = (button) => { showSent(); button.classList.add('a2-btn-sent'); setTimeout(() => button.classList.remove('a2-btn-sent'), 1200); };
    const card = build(root, byId, store, { interactive, onFired });
    wrap.append(card, status);
    if (ctx.annotate) ctx.annotate.register(card, { blockId, questionId: ctx.questionId, target: { kind: 'html-element', label: text(block.title || root.title || 'A2UI widget') } });
    return wrap;
  }

  window.RelayA2ui = { render };
})();
