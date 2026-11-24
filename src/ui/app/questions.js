  // ---------- controls ----------
  const cards = {};

  function clearErr(qid) {
    if (cards[qid]) cards[qid].classList.remove('error');
  }

  function syncOptSel(group) {
    for (const lab of group.querySelectorAll('label.opt')) {
      const input = lab.querySelector('input');
      lab.classList.toggle('sel', input.checked);
      // options with visuals: the bordered card is the wrapper, not the label
      const wrap = lab.closest('.optwrap');
      if (wrap) wrap.classList.toggle('sel', input.checked);
    }
  }

  // Options may carry their own blocks (visual examples of the choice). The
  // blocks render in a wrapper card OUTSIDE the <label> so interacting with a
  // chart/diagram/image doesn't toggle the option.
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
      scheduleSave();
    };
    for (const o of q.options) {
      const input = el('input', { type: 'radio', name: q.id });
      entries.push({ input, value: o.value });
      input.checked = state.answers[q.id] === o.value && !otherOn();
      // Click-to-toggle: clicking the selected option unselects it (answers
      // are optional by default). preventDefault keeps `checked` ours to set.
      input.addEventListener('click', (e) => {
        e.preventDefault();
        if (state.answers[q.id] === o.value && !otherOn()) {
          delete state.answers[q.id];
        } else {
          state.answers[q.id] = o.value;
          if (state.other[q.id]) state.other[q.id].on = false;
        }
        // Defer: after a canceled activation the browser restores the
        // pre-click checked state AFTER this handler, clobbering direct sets.
        setTimeout(syncSingle, 0);
      });
      input.addEventListener('change', () => {
        // keyboard path (arrow keys / space) — no click event fires
        if (!input.checked) return;
        state.answers[q.id] = o.value;
        if (state.other[q.id]) state.other[q.id].on = false;
        syncSingle();
      });
      group.append(
        withOptionBlocks(
          el('label', { class: 'opt' + (input.checked ? ' sel' : '') },
            input,
            el('div', {},
              el('div', { class: 'ol' }, o.label),
              o.description ? el('div', { class: 'od' }, o.description) : null
            )
          ),
          o,
          q.id
        )
      );
    }
    if (q.other) {
      otherRadio = el('input', { type: 'radio', name: q.id });
      const text = el('textarea', { class: 'otherinput', rows: '2', placeholder: 'your own answer…' });
      text.value = (state.other[q.id] && state.other[q.id].text) || '';
      otherRadio.checked = otherOn();
      const ensureOther = () => state.other[q.id] || (state.other[q.id] = { on: false, text: text.value });
      otherRadio.addEventListener('click', (e) => {
        e.preventDefault();
        const oth = ensureOther();
        oth.on = !oth.on;
        if (oth.on) delete state.answers[q.id];
        setTimeout(syncSingle, 0);
      });
      otherRadio.addEventListener('change', () => {
        if (!otherRadio.checked) return;
        const oth = ensureOther();
        oth.on = true;
        delete state.answers[q.id];
        syncSingle();
      });
      text.addEventListener('input', () => {
        const oth = ensureOther();
        oth.text = text.value;
        if (!oth.on) {
          oth.on = true;
          delete state.answers[q.id];
        }
        syncSingle();
      });
      group.append(
        el('label', { class: 'opt' + (otherRadio.checked ? ' sel' : '') },
          otherRadio,
          el('div', { style: 'flex:1' }, el('div', { class: 'ol' }, 'Other'), el('div', { class: 'otherbox' }, text))
        )
      );
    }
    return group;
  }

  function controlMulti(q) {
    const group = el('div');
    const selected = new Set(Array.isArray(state.answers[q.id]) ? state.answers[q.id] : []);
    const readChecked = () => {
      state.answers[q.id] = [...group.querySelectorAll('input[data-val]')]
        .filter((i) => i.checked)
        .map((i) => i.dataset.val);
      syncOptSel(group);
      clearErr(q.id);
      scheduleSave();
    };
    for (const o of q.options) {
      const input = el('input', { type: 'checkbox', 'data-val': o.value });
      input.checked = selected.has(o.value);
      input.addEventListener('change', readChecked);
      group.append(
        withOptionBlocks(
          el('label', { class: 'opt' + (input.checked ? ' sel' : '') },
            input,
            el('div', {},
              el('div', { class: 'ol' }, o.label),
              o.description ? el('div', { class: 'od' }, o.description) : null
            )
          ),
          o,
          q.id
        )
      );
    }
    if (q.other) {
      const oth = state.other[q.id];
      const box = el('input', { type: 'checkbox' });
      const text = el('textarea', { class: 'otherinput', rows: '2', placeholder: 'your own answer…' });
      box.checked = Boolean(oth && oth.on);
      text.value = (oth && oth.text) || '';
      const sync = () => {
        state.other[q.id] = { on: box.checked, text: text.value };
        syncOptSel(group);
        clearErr(q.id);
        scheduleSave();
      };
      box.addEventListener('change', sync);
      text.addEventListener('input', () => {
        if (!box.checked) box.checked = true;
        sync();
      });
      group.append(
        el('label', { class: 'opt' + (box.checked ? ' sel' : '') },
          box,
          el('div', { style: 'flex:1' }, el('div', { class: 'ol' }, 'Other'), el('div', { class: 'otherbox' }, text))
        )
      );
    }
    return group;
  }

  function segButtons(q, values, labels) {
    const seg = el('div', { class: q.type === 'scale' ? 'scale' : 'seg' });
    const buttons = [];
    values.forEach((v, i) => {
      const b = el('button', { type: 'button' }, labels[i]);
      if (state.answers[q.id] === v) b.classList.add('sel');
      b.addEventListener('click', () => {
        // click again to unselect (everything is optional by default)
        if (state.answers[q.id] === v) delete state.answers[q.id];
        else state.answers[q.id] = v;
        for (const x of buttons) x.classList.toggle('sel', state.answers[q.id] === values[buttons.indexOf(x)]);
        clearErr(q.id);
        scheduleSave();
      });
      buttons.push(b);
      seg.append(b);
    });
    return seg;
  }

  function controlScale(q) {
    const values = [];
    for (let i = q.min; i <= q.max; i++) values.push(i);
    const seg = segButtons(q, values, values.map(String));
    const row = el('div', { class: 'scale' });
    if (q.minLabel) row.append(el('span', { class: 'slabel' }, q.minLabel));
    row.append(...seg.children);
    if (q.maxLabel) row.append(el('span', { class: 'slabel' }, q.maxLabel));
    return row;
  }

  // Reorderable priority list. The user drags an item or uses ↑/↓; the answer is
  // the ordered array of option values (highest priority first). state.answers[q.id]
  // is kept a full, valid permutation by seedRankOrder so it's always submittable.
  function controlRank(q) {
    const wrap = el('div', { class: 'rank' });
    const byVal = new Map(q.options.map((o) => [o.value, o]));
    let dragFrom = null;
    function move(from, to) {
      if (!access.canEditAnswers) return;
      const arr = state.answers[q.id];
      if (!Array.isArray(arr) || to < 0 || to >= arr.length || from === to) return;
      const [x] = arr.splice(from, 1);
      arr.splice(to, 0, x);
      paint();
      clearErr(q.id);
      scheduleSave();
    }
    function paint() {
      wrap.replaceChildren();
      const order = state.answers[q.id] || [];
      order.forEach((val, i) => {
        const o = byVal.get(val);
        if (!o) return;
        const up = el('button', { type: 'button', class: 'rank-btn', title: 'Move up', 'aria-label': `Move "${o.label}" up` }, '↑');
        const down = el('button', { type: 'button', class: 'rank-btn', title: 'Move down', 'aria-label': `Move "${o.label}" down` }, '↓');
        up.disabled = i === 0;
        down.disabled = i === order.length - 1;
        up.addEventListener('click', () => move(i, i - 1));
        down.addEventListener('click', () => move(i, i + 1));
        const item = el('div', { class: 'rank-item', draggable: access.canEditAnswers ? 'true' : 'false' },
          el('span', { class: 'rank-badge', 'aria-hidden': 'true' }, String(i + 1)),
          el('div', { class: 'rank-body' },
            el('div', { class: 'ol' }, o.label),
            o.description ? el('div', { class: 'od' }, o.description) : null),
          el('div', { class: 'rank-ctrls' }, up, down)
        );
        item.addEventListener('dragstart', (e) => {
          if (!access.canEditAnswers) { e.preventDefault(); return; }
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

  // Checklist: each option is a row with a segmented status control (Pass/Fail/
  // N/A by default). Answer is a map {optionValue: statusValue} for set rows.
  function controlChecklist(q) {
    const wrap = el('div', { class: 'checklist' });
    const cur = () => (state.answers[q.id] && typeof state.answers[q.id] === 'object' && !Array.isArray(state.answers[q.id])
      ? state.answers[q.id]
      : (state.answers[q.id] = {}));
    for (const o of q.options) {
      const seg = el('div', { class: 'chk-seg' });
      const buttons = [];
      for (const s of q.statuses) {
        const b = el('button', { type: 'button', class: 'chk-status' + (s.tone ? ' tone-' + s.tone : '') }, s.label);
        if (cur()[o.value] === s.value) b.classList.add('sel');
        b.addEventListener('click', () => {
          const m = cur();
          if (m[o.value] === s.value) delete m[o.value];
          else m[o.value] = s.value;
          for (const x of buttons) x.btn.classList.toggle('sel', m[o.value] === x.val);
          clearErr(q.id);
          scheduleSave();
        });
        buttons.push({ btn: b, val: s.value });
        seg.append(b);
      }
      wrap.append(el('div', { class: 'chk-row' },
        el('div', { class: 'chk-body' },
          el('div', { class: 'ol' }, o.label),
          o.description ? el('div', { class: 'od' }, o.description) : null),
        seg
      ));
    }
    return wrap;
  }

  // Allocate: distribute q.total across the options with per-option sliders; a
  // live total bar shows the running sum / remaining / overage. Answer is a map
  // {optionValue: number}; an all-zero allocation submits as unanswered.
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
      const tail = sum > total ? ` (over by ${sum - total})` : sum < total ? ` (${total - sum} left)` : ' (all assigned)';
      sumEl.textContent = `${sum} / ${total}${unit}${tail}`;
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
      range.addEventListener('input', () => {
        cur()[o.value] = Number(range.value) || 0;
        refresh();
        clearErr(q.id);
        scheduleSave();
      });
      nums.push({ value: o.value, el: num });
      wrap.append(el('div', { class: 'alloc-row' },
        el('div', { class: 'alloc-rowhead' },
          el('div', { class: 'ol' }, o.label),
          num),
        range,
        o.description ? el('div', { class: 'od' }, o.description) : null
      ));
    }
    wrap.append(el('div', { class: 'alloc-total' },
      el('div', { class: 'alloc-bar' }, fill),
      el('div', { class: 'alloc-sumwrap' }, 'Total: ', sumEl)
    ));
    refresh();
    return wrap;
  }

  function controlText(q, multiline) {
    const input = multiline
      ? el('textarea', { placeholder: q.placeholder || '' })
      : el('input', { type: 'text', placeholder: q.placeholder || '' });
    input.value = typeof state.answers[q.id] === 'string' ? state.answers[q.id] : '';
    input.addEventListener('input', () => {
      state.answers[q.id] = input.value;
      clearErr(q.id);
      scheduleSave();
    });
    return input;
  }

  // Resolve ANY CSS color (named / rgb() / hsl() / hex) to #rrggbb for the
  // native <input type=color>, using the browser's own parser — multi color-
  // system support with no library. Returns null for an unparseable color.
