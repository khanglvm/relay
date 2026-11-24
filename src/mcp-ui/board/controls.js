  function clearErr(qid) { if (cards[qid]) markError(cards[qid], false); }
  /** Shows or hides a question's required error, and adds it to the group's description while it shows. */
  function markError(card, bad) {
    card.classList.toggle('error', bad);
    const ids = [card.dataset.desc, bad ? card.dataset.err : ''].filter(Boolean).join(' ');
    if (ids) card.setAttribute('aria-describedby', ids);
    else card.removeAttribute('aria-describedby');
  }
  function requiredMark() {
    return el('span', { class: 'req' }, el('span', { 'aria-hidden': 'true' }, ' *'), el('span', { class: 'sr-only' }, ' (required)'));
  }
  let uidSeq = 0;
  const uid = (prefix) => prefix + '-' + (++uidSeq);
  /**
   * Gives a row of single-choice buttons radio semantics: each says whether it
   * is checked, Tab enters at the chosen one (or the first), and the arrow keys
   * move to and choose the next. Returns a function that repaints the state.
   * The caller puts role=radiogroup and a label on the buttons' container.
   */
  function radioButtons(buttons, isOn) {
    const sync = () => {
      const on = buttons.map((btn, i) => isOn(i));
      const entry = Math.max(0, on.indexOf(true));
      buttons.forEach((btn, i) => {
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', on[i] ? 'true' : 'false');
        btn.classList.toggle('sel', on[i]);
        btn.tabIndex = i === entry ? 0 : -1;
      });
    };
    buttons.forEach((btn, i) => btn.addEventListener('keydown', (ev) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      const next = buttons[(i + step + buttons.length) % buttons.length];
      next.focus();
      if (next.getAttribute('aria-checked') !== 'true') next.click();
    }));
    sync();
    return sync;
  }

  function syncOptSel(group) {
    for (const lab of group.querySelectorAll('label.opt')) {
      const input = lab.querySelector('input');
      lab.classList.toggle('sel', input.checked);
      const wrap = lab.closest('.optwrap');
      if (wrap) wrap.classList.toggle('sel', input.checked);
    }
  }
  function withOptionBlocks(labelEl, o, questionId) {
    if (!Array.isArray(o.blocks) || !o.blocks.length) return labelEl;
    const wrap = el('div', { class: 'optwrap' + (labelEl.classList.contains('sel') ? ' sel' : '') }, labelEl);
    renderBlocks(wrap, o.blocks, questionId);
    return wrap;
  }

  function controlSingle(q) {
    const group = el('div');
    const entries = [];
    let otherRadio = null;
    const otherOn = () => Boolean(state.other[q.id] && state.other[q.id].on);
    const syncSingle = () => {
      for (const { input, value } of entries) input.checked = state.answers[q.id] === value && !otherOn();
      if (otherRadio) otherRadio.checked = otherOn();
      syncOptSel(group);
      clearErr(q.id);
    };
    for (const o of q.options) {
      const input = el('input', { type: 'radio', name: q.id });
      entries.push({ input, value: o.value });
      input.checked = state.answers[q.id] === o.value && !otherOn();
      input.addEventListener('click', (e) => {
        e.preventDefault();
        if (state.answers[q.id] === o.value && !otherOn()) delete state.answers[q.id];
        else { state.answers[q.id] = o.value; if (state.other[q.id]) state.other[q.id].on = false; }
        setTimeout(syncSingle, 0);
      });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        state.answers[q.id] = o.value;
        if (state.other[q.id]) state.other[q.id].on = false;
        syncSingle();
      });
      group.append(withOptionBlocks(
        el('label', { class: 'opt' + (input.checked ? ' sel' : '') }, input,
          el('div', {}, el('div', { class: 'ol' }, o.label), o.description ? el('div', { class: 'od' }, o.description) : null)),
        o, q.id));
    }
    if (q.other) {
      otherRadio = el('input', { type: 'radio', name: q.id });
      const text = el('textarea', { class: 'otherinput', rows: '2', placeholder: 'your own answer…', 'aria-label': 'Your own answer' });
      text.value = (state.other[q.id] && state.other[q.id].text) || '';
      otherRadio.checked = otherOn();
      const ensureOther = () => state.other[q.id] || (state.other[q.id] = { on: false, text: text.value });
      otherRadio.addEventListener('click', (e) => { e.preventDefault(); const oth = ensureOther(); oth.on = !oth.on; if (oth.on) delete state.answers[q.id]; setTimeout(syncSingle, 0); });
      otherRadio.addEventListener('change', () => { if (!otherRadio.checked) return; const oth = ensureOther(); oth.on = true; delete state.answers[q.id]; syncSingle(); });
      text.addEventListener('input', () => { const oth = ensureOther(); oth.text = text.value; if (!oth.on) { oth.on = true; delete state.answers[q.id]; } syncSingle(); });
      group.append(el('label', { class: 'opt' + (otherRadio.checked ? ' sel' : '') }, otherRadio,
        el('div', { style: 'flex:1' }, el('div', { class: 'ol' }, 'Other'), el('div', { class: 'otherbox' }, text))));
    }
    return group;
  }

  function controlMulti(q) {
    const group = el('div');
    const selected = new Set(Array.isArray(state.answers[q.id]) ? state.answers[q.id] : []);
    const readChecked = () => {
      state.answers[q.id] = [...group.querySelectorAll('input[data-val]')].filter((i) => i.checked).map((i) => i.dataset.val);
      syncOptSel(group);
      clearErr(q.id);
    };
    for (const o of q.options) {
      const input = el('input', { type: 'checkbox', 'data-val': o.value });
      input.checked = selected.has(o.value);
      input.addEventListener('change', readChecked);
      group.append(withOptionBlocks(
        el('label', { class: 'opt' + (input.checked ? ' sel' : '') }, input,
          el('div', {}, el('div', { class: 'ol' }, o.label), o.description ? el('div', { class: 'od' }, o.description) : null)),
        o, q.id));
    }
    if (q.other) {
      const oth = state.other[q.id];
      const box = el('input', { type: 'checkbox' });
      const text = el('textarea', { class: 'otherinput', rows: '2', placeholder: 'your own answer…', 'aria-label': 'Your own answer' });
      box.checked = Boolean(oth && oth.on);
      text.value = (oth && oth.text) || '';
      const sync = () => { state.other[q.id] = { on: box.checked, text: text.value }; syncOptSel(group); clearErr(q.id); };
      box.addEventListener('change', sync);
      text.addEventListener('input', () => { if (!box.checked) box.checked = true; sync(); });
      group.append(el('label', { class: 'opt' + (box.checked ? ' sel' : '') }, box,
        el('div', { style: 'flex:1' }, el('div', { class: 'ol' }, 'Other'), el('div', { class: 'otherbox' }, text))));
    }
    return group;
  }

  function segButtons(q, values, labels) {
    const seg = el('div', { class: q.type === 'scale' ? 'scale' : 'seg', role: 'radiogroup' });
    const buttons = values.map((v, i) => el('button', { type: 'button' }, labels[i]));
    const sync = radioButtons(buttons, (i) => state.answers[q.id] === values[i]);
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        if (state.answers[q.id] === values[i]) delete state.answers[q.id];
        else state.answers[q.id] = values[i];
        sync();
        clearErr(q.id);
      });
      seg.append(btn);
    });
    return seg;
  }
  function controlScale(q) {
    const values = [];
    for (let i = q.min; i <= q.max; i++) values.push(i);
    const seg = segButtons(q, values, values.map(String));
    // Up to 11 steps fit one even row on a phone; the end labels move under it
    // so they do not squeeze the buttons. Longer scales keep the wrapping row.
    if (values.length <= 11) {
      const steps = '--n:' + values.length + ';--half:' + Math.ceil(values.length / 2);
      const grid = el('div', { class: 'scale scale-fit' + (values.length >= 8 ? ' scale-long' : ''), style: steps, role: 'radiogroup' }, ...seg.children);
      if (!q.minLabel && !q.maxLabel) return grid;
      return el('div', {}, grid, el('div', { class: 'scale-ends', style: steps },
        el('span', {}, q.minLabel || ''), el('span', {}, q.maxLabel || '')));
    }
    const row = el('div', { class: 'scale', role: 'radiogroup' });
    if (q.minLabel) row.append(el('span', { class: 'slabel' }, q.minLabel));
    row.append(...seg.children);
    if (q.maxLabel) row.append(el('span', { class: 'slabel' }, q.maxLabel));
    return row;
  }
  function controlText(q, multiline) {
    const input = multiline
      ? el('textarea', { placeholder: q.placeholder || '' })
      : el('input', { type: 'text', placeholder: q.placeholder || '' });
    input.value = typeof state.answers[q.id] === 'string' ? state.answers[q.id] : '';
    input.addEventListener('input', () => { state.answers[q.id] = input.value; clearErr(q.id); });
    return input;
  }
  // Checklist / allocate — see the browser board's controls (no autosave here).
  function controlChecklist(q) {
    const wrap = el('div', { class: 'checklist' });
    const cur = () => (state.answers[q.id] && typeof state.answers[q.id] === 'object' && !Array.isArray(state.answers[q.id])
      ? state.answers[q.id] : (state.answers[q.id] = {}));
    for (const o of q.options) {
      const labelId = uid('chk');
      const seg = el('div', { class: 'chk-seg', role: 'radiogroup', 'aria-labelledby': labelId });
      const buttons = q.statuses.map((st) => el('button', { type: 'button', class: 'chk-status' + (st.tone ? ' tone-' + st.tone : '') }, st.label));
      const sync = radioButtons(buttons, (i) => cur()[o.value] === q.statuses[i].value);
      buttons.forEach((btn, i) => {
        btn.addEventListener('click', () => {
          const m = cur();
          if (m[o.value] === q.statuses[i].value) delete m[o.value];
          else m[o.value] = q.statuses[i].value;
          sync();
          clearErr(q.id);
        });
        seg.append(btn);
      });
      wrap.append(el('div', { class: 'chk-row' },
        el('div', { class: 'chk-body' }, el('div', { class: 'ol', id: labelId }, o.label), o.description ? el('div', { class: 'od' }, o.description) : null),
        seg));
    }
    return wrap;
  }
  function controlAllocate(q) {
    const wrap = el('div', { class: 'allocate' });
    const total = q.total || 100;
    const unit = q.unit ? ' ' + q.unit : '';
    const cur = () => (state.answers[q.id] = seedAllocate(q, state.answers[q.id]));
    const sumEl = el('span', { class: 'alloc-sum' });
    const fill = el('div', { class: 'alloc-bar-fill' });
    const nums = [];
    const refresh = () => {
      const m = cur();
      const sum = (q.options || []).reduce((a, o) => a + (Number(m[o.value]) || 0), 0);
      const tail = sum > total ? ' (over by ' + (sum - total) + ')' : sum < total ? ' (' + (total - sum) + ' left)' : ' (all assigned)';
      sumEl.textContent = sum + ' / ' + total + unit + tail;
      sumEl.classList.toggle('over', sum > total);
      sumEl.classList.toggle('exact', sum === total);
      fill.style.width = Math.min(100, (sum / total) * 100) + '%';
      fill.classList.toggle('over', sum > total);
      for (const n of nums) n.el.textContent = String(m[n.value] || 0);
    };
    for (const o of q.options) {
      const m = cur();
      const range = el('input', { type: 'range', min: '0', max: String(total), step: '1', class: 'alloc-range', 'aria-label': o.label });
      range.value = String(m[o.value] || 0);
      const num = el('span', { class: 'alloc-num' }, String(m[o.value] || 0));
      range.addEventListener('input', () => { cur()[o.value] = Number(range.value) || 0; refresh(); clearErr(q.id); });
      nums.push({ value: o.value, el: num });
      wrap.append(el('div', { class: 'alloc-row' },
        el('div', { class: 'alloc-rowhead' }, el('div', { class: 'ol' }, o.label), num),
        range,
        o.description ? el('div', { class: 'od' }, o.description) : null));
    }
    wrap.append(el('div', { class: 'alloc-total' },
      el('div', { class: 'alloc-bar' }, fill),
      el('div', { class: 'alloc-sumwrap' }, 'Total: ', sumEl)));
    refresh();
    return wrap;
  }
  // Lucide chevron-up / chevron-down; the buttons carry their own aria-label.
  const RANK_ICON = (d) => '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:auto"><path d="' + d + '"/></svg>';
  const RANK_ICON_UP = RANK_ICON('m18 15-6-6-6 6');
  const RANK_ICON_DOWN = RANK_ICON('m6 9 6 6 6-6');
  // Reorderable priority list — see the browser board's controlRank. Answer is
  // the ordered array of option values (highest first); always a full permutation.
  function controlRank(q) {
    const wrap = el('div', { class: 'rank' });
    const byVal = new Map(q.options.map((o) => [o.value, o]));
    let dragFrom = null;
    function move(from, to) {
      const arr = state.answers[q.id];
      if (!Array.isArray(arr) || to < 0 || to >= arr.length || from === to) return;
      const [x] = arr.splice(from, 1);
      arr.splice(to, 0, x);
      paint();
      clearErr(q.id);
    }
    function paint() {
      wrap.replaceChildren();
      const order = state.answers[q.id] || [];
      order.forEach((val, i) => {
        const o = byVal.get(val);
        if (!o) return;
        const up = el('button', { type: 'button', class: 'rank-btn', title: 'Move up', 'aria-label': 'Move "' + o.label + '" up' });
        const down = el('button', { type: 'button', class: 'rank-btn', title: 'Move down', 'aria-label': 'Move "' + o.label + '" down' });
        up.innerHTML = RANK_ICON_UP;
        down.innerHTML = RANK_ICON_DOWN;
        up.disabled = i === 0;
        down.disabled = i === order.length - 1;
        up.addEventListener('click', () => move(i, i - 1));
        down.addEventListener('click', () => move(i, i + 1));
        const item = el('div', { class: 'rank-item', draggable: 'true' },
          el('span', { class: 'rank-badge', 'aria-hidden': 'true' }, String(i + 1)),
          el('div', { class: 'rank-body' },
            el('div', { class: 'ol' }, o.label),
            o.description ? el('div', { class: 'od' }, o.description) : null),
          el('div', { class: 'rank-ctrls' }, up, down)
        );
        item.addEventListener('dragstart', (e) => {
          dragFrom = i; item.classList.add('dragging');
          try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch (_) {}
        });
        item.addEventListener('dragend', () => { dragFrom = null; item.classList.remove('dragging'); });
        item.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); item.classList.add('drop-into'); } });
        item.addEventListener('dragleave', () => item.classList.remove('drop-into'));
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          const from = dragFrom; dragFrom = null;
          if (from !== null && from !== i) move(from, i);
        });
        wrap.append(item);
      });
    }
    paint();
    return wrap;
  }

  // Resolve any CSS color (named/rgb/hsl/hex) to #rrggbb via the browser parser.
  function cssColorToHex(str) {
    const s = String(str || '').trim();
    let m = /^#?([0-9a-fA-F]{6})$/.exec(s);
    if (m) return '#' + m[1].toLowerCase();
    m = /^#?([0-9a-fA-F]{3})$/.exec(s);
    if (m) return '#' + m[1].split('').map((x) => x + x).join('').toLowerCase();
    try {
      const d = document.createElement('div');
      d.style.color = '';
      d.style.color = s;
      if (!d.style.color) return null;
      d.style.display = 'none';
      document.body.appendChild(d);
      const rgb = getComputedStyle(d).color;
      document.body.removeChild(d);
      const mm = rgb.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (!mm) return null;
      const h = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
      return '#' + h(mm[1]) + h(mm[2]) + h(mm[3]);
    } catch { return null; }
  }
  function toHex6(c) { return cssColorToHex(c) || '#000000'; }
  function controlColor(q) {
    const wrap = el('div', { class: 'colorpick' });
    const init = (typeof state.answers[q.id] === 'string' && state.answers[q.id]) || (typeof q.default === 'string' ? q.default : '');
    const swatch = el('input', { type: 'color', class: 'colorswatch' });
    const hex = el('input', { type: 'text', class: 'colorhex', placeholder: q.placeholder || '#rrggbb / rgb() / name', spellcheck: 'false', autocapitalize: 'off' });
    swatch.value = toHex6(init || '#888888');
    if (init) { hex.value = init; state.answers[q.id] = init; }
    let syncPaletteSel = () => {};
    const set = (val) => { state.answers[q.id] = val; syncPaletteSel(); clearErr(q.id); };
    swatch.addEventListener('input', () => { hex.value = swatch.value; set(swatch.value); });
    hex.addEventListener('input', () => { const v = hex.value.trim(); const h = cssColorToHex(v); if (h) swatch.value = h; set(v); });
    if (Array.isArray(q.palette) && q.palette.length) {
      const grid = el('div', { class: 'colorpalette' });
      const cards = [];
      for (const p of q.palette) {
        const labelled = p.label && p.label !== p.value;
        const card = el('button', { type: 'button', class: 'colorpal-sw', style: 'background:' + p.value, title: (labelled ? p.label + ' · ' : '') + p.value });
        if (labelled) card.append(el('span', { class: 'colorpal-label' }, p.label));
        card.addEventListener('click', () => { const h = cssColorToHex(p.value); if (h) swatch.value = h; hex.value = p.value; set(p.value); });
        if (Annotate && !composing) Annotate.register(card, { blockId: null, questionId: q.id, target: { kind: 'swatch', label: (labelled ? p.label + ' · ' : '') + p.value } });
        cards.push({ card, val: p.value });
        grid.append(card);
      }
      syncPaletteSel = () => { for (const c of cards) c.card.classList.toggle('sel', state.answers[q.id] === c.val); };
      wrap.append(grid);
    }
    wrap.append(el('div', { class: 'colorrow' }, swatch, hex));
    if (Array.isArray(q.presets) && q.presets.length) {
      const presets = el('div', { class: 'colorpresets' });
      for (const c of q.presets) {
        const b = el('button', { type: 'button', class: 'colorpreset', style: 'background:' + c, title: c });
        b.addEventListener('click', () => { const h = cssColorToHex(c); if (h) swatch.value = h; hex.value = c; set(c); });
        presets.append(b);
      }
      wrap.append(presets);
    }
    syncPaletteSel();
    return wrap;
  }

