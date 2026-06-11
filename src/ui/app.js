(() => {
  'use strict';

  const boot = JSON.parse(document.getElementById('boot').textContent);
  const spec = boot.spec;
  const QS = spec.questions || [];
  const app = document.getElementById('app');
  const banner = document.getElementById('banner');

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

  // ---------- theme (auto -> light -> dark) ----------
  // Server-side pref wins: boards run on random ports, so localStorage alone
  // can't carry the choice across boards. The server persists it globally.
  const THEME_KEY = 'qb-theme';
  const THEMES = ['auto', 'light', 'dark'];
  let theme = (boot.pref && boot.pref.theme) || localStorage.getItem(THEME_KEY);
  if (!THEMES.includes(theme)) theme = 'auto';
  function effectiveTheme() {
    if (theme !== 'auto') return theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme() {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    if (themeBtn) themeBtn.textContent = { auto: '◐ auto', light: '☀ light', dark: '☾ dark' }[theme];
    // Custom-HTML iframes get ?theme=light|dark so authors can match the theme.
    for (const f of document.querySelectorAll('iframe.viz')) {
      try {
        const u = new URL(f.src);
        if (u.searchParams.get('theme') !== effectiveTheme()) {
          u.searchParams.set('theme', effectiveTheme());
          f.src = u.toString();
        }
      } catch {
        // ignore malformed src
      }
    }
  }
  let themeBtn = null;

  // ---------- state ----------
  // state.answers holds raw control state; state.other holds the "Other"
  // free-text per question; getValue() derives the final answer value.
  const state = { answers: {}, other: {}, comment: '' };
  let submitted = false;

  function seedFromPrefill(prefill) {
    state.comment = prefill.comment || '';
    const ans = prefill.answers || {};
    for (const q of QS) {
      const v = ans[q.id];
      if (v === undefined || v === null) continue;
      if (q.type === 'multi' && Array.isArray(v)) {
        const known = new Set((q.options || []).map((o) => o.value));
        state.answers[q.id] = v.filter((x) => known.has(x));
        const extra = v.filter((x) => !known.has(x));
        if (extra.length && q.other) state.other[q.id] = { on: true, text: extra.join(', ') };
      } else if (q.type === 'single' && typeof v === 'string') {
        if ((q.options || []).some((o) => o.value === v)) state.answers[q.id] = v;
        else if (q.other) state.other[q.id] = { on: true, text: v };
      } else {
        state.answers[q.id] = v;
      }
    }
  }
  if (boot.prefill) seedFromPrefill(boot.prefill);
  else for (const q of QS) if (q.default !== undefined) state.answers[q.id] = q.default;

  function getValue(q) {
    const v = state.answers[q.id];
    const oth = state.other[q.id];
    switch (q.type) {
      case 'single': {
        if (oth && oth.on) {
          const t = (oth.text || '').trim();
          return t || undefined;
        }
        return typeof v === 'string' && v ? v : undefined;
      }
      case 'multi': {
        const arr = Array.isArray(v) ? [...v] : [];
        if (oth && oth.on) {
          const t = (oth.text || '').trim();
          if (t) arr.push(t);
        }
        return arr.length ? arr : undefined;
      }
      case 'yesno':
        return v === 'yes' || v === 'no' ? v : undefined;
      case 'scale':
        return typeof v === 'number' ? v : undefined;
      default: {
        const t = typeof v === 'string' ? v.trim() : '';
        return t || undefined;
      }
    }
  }

  function payload() {
    const answers = {};
    for (const q of QS) {
      const v = getValue(q);
      if (v !== undefined) answers[q.id] = v;
    }
    return { answers, comment: (state.comment || '').trim() };
  }

  // ---------- real-time autosave ----------
  let saveTimer = null;
  let saveSeq = 0;
  let saveEl = null;
  function scheduleSave() {
    if (submitted) return;
    if (saveEl) saveEl.textContent = 'saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 450);
  }
  async function saveDraft() {
    const seq = ++saveSeq;
    try {
      await fetch('/api/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      if (seq === saveSeq && saveEl && !submitted) saveEl.textContent = 'draft saved ✓';
    } catch {
      if (seq === saveSeq && saveEl && !submitted) saveEl.textContent = 'draft save failed';
    }
  }

  // ---------- controls ----------
  const cards = {};

  function clearErr(qid) {
    if (cards[qid]) cards[qid].classList.remove('error');
  }

  function syncOptSel(group) {
    for (const lab of group.querySelectorAll('label.opt')) {
      const input = lab.querySelector('input');
      lab.classList.toggle('sel', input.checked);
    }
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
        el('label', { class: 'opt' + (input.checked ? ' sel' : '') },
          input,
          el('div', {},
            el('div', { class: 'ol' }, o.label),
            o.description ? el('div', { class: 'od' }, o.description) : null
          )
        )
      );
    }
    if (q.other) {
      otherRadio = el('input', { type: 'radio', name: q.id });
      const text = el('input', { type: 'text', placeholder: 'your own answer…' });
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
        el('label', { class: 'opt' + (input.checked ? ' sel' : '') },
          input,
          el('div', {},
            el('div', { class: 'ol' }, o.label),
            o.description ? el('div', { class: 'od' }, o.description) : null
          )
        )
      );
    }
    if (q.other) {
      const oth = state.other[q.id];
      const box = el('input', { type: 'checkbox' });
      const text = el('input', { type: 'text', placeholder: 'your own answer…' });
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

  function vizFrame(src, height) {
    return el('iframe', {
      class: 'viz',
      src: `${src}?theme=${effectiveTheme()}`,
      height: String(height),
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals',
      loading: 'lazy',
    });
  }

  // ---------- render ----------
  themeBtn = el('button', { class: 'theme-btn', type: 'button' }, '');
  themeBtn.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    localStorage.setItem(THEME_KEY, theme);
    fetch('/api/pref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).catch(() => {});
    applyTheme();
  });
  applyTheme();

  app.append(el('header', { class: 'qb-header' }, el('h1', {}, spec.title), themeBtn));
  if (spec.intro) app.append(el('p', { class: 'intro' }, spec.intro));
  if (spec.hasHtml) app.append(vizFrame('/html/board', spec.htmlHeight));

  QS.forEach((q, idx) => {
    const required = q.required || !spec.allowPartial;
    const card = el('div', { class: 'card' },
      el('div', { class: 'qnum' }, `Q${idx + 1}`),
      el('p', { class: 'qlabel' }, q.label, required ? el('span', { class: 'req' }, ' *') : null),
      q.description ? el('p', { class: 'qdesc' }, q.description) : null,
      q.hasHtml ? vizFrame(`/html/q/${encodeURIComponent(q.id)}`, q.htmlHeight) : null
    );
    const control = el('div', { class: 'control' });
    if (q.type === 'single') control.append(controlSingle(q));
    else if (q.type === 'multi') control.append(controlMulti(q));
    else if (q.type === 'yesno') control.append(segButtons(q, ['yes', 'no'], ['Yes', 'No']));
    else if (q.type === 'scale') control.append(controlScale(q));
    else control.append(controlText(q, q.type === 'textarea'));
    card.append(control, el('p', { class: 'errmsg' }, 'This question is required.'));
    cards[q.id] = card;
    app.append(card);
  });

  if (spec.note) {
    const note = el('textarea', { placeholder: 'optional note back to the agent…' });
    note.value = state.comment || '';
    note.addEventListener('input', () => {
      state.comment = note.value;
      scheduleSave();
    });
    app.append(el('div', { class: 'card' },
      el('p', { class: 'qlabel' }, 'Anything else?'),
      el('p', { class: 'qdesc' }, 'Free-text note returned to the agent along with your answers.'),
      el('div', { class: 'control' }, note)
    ));
  }

  const submitBtn = el('button', { class: 'submit', type: 'button' }, spec.submitLabel);
  saveEl = el('span', { class: 'savestate' }, '');
  const hint = el('span', { class: 'hint' },
    QS.length && spec.allowPartial ? 'Unanswered questions are returned as skipped.' : '');
  app.append(el('div', { class: 'submitbar' }, submitBtn, hint, saveEl));
  app.append(el('footer', { class: 'qb-footer' }, `quest-board · ${boot.boardId}`));

  // ---------- validation & submit ----------
  function validate() {
    let firstBad = null;
    for (const q of QS) {
      const required = q.required || !spec.allowPartial;
      const bad = required && getValue(q) === undefined;
      cards[q.id].classList.toggle('error', bad);
      if (bad && !firstBad) firstBad = cards[q.id];
    }
    if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return !firstBad;
  }

  function showDone(closing) {
    stopHeartbeat();
    app.replaceChildren(
      el('div', { class: 'done' },
        el('div', { class: 'mark' }, '✓'),
        el('h2', {}, QS.length ? 'Submitted' : 'Acknowledged'),
        el('p', { id: 'done-note' }, closing ? 'Handing back to your agent — this tab will close itself…' : 'Handed back to your agent. You can close this tab.')
      )
    );
  }

  submitBtn.addEventListener('click', async () => {
    if (!validate()) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    clearTimeout(saveTimer);
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      if (!res.ok) throw new Error('submit rejected');
      submitted = true;
      showDone(spec.autoClose);
      if (spec.autoClose) {
        setTimeout(() => {
          window.close();
          // window.close() is best-effort (browsers may block it for
          // user-opened tabs) — fall back to the "close this tab" note.
          setTimeout(() => {
            const note = document.getElementById('done-note');
            if (note) note.textContent = 'Handed back to your agent. You can close this tab.';
          }, 400);
        }, 700);
      }
    } catch {
      submitBtn.disabled = false;
      submitBtn.textContent = spec.submitLabel;
      banner.textContent = 'Submit failed — the board server may have stopped.';
      banner.style.display = 'block';
      setTimeout(() => { if (!submitted) banner.style.display = 'none'; }, 4000);
    }
  });

  // ---------- heartbeat ----------
  let misses = 0;
  let hb = setInterval(async () => {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      misses = 0;
    } catch {
      if (++misses >= 2 && !submitted) {
        banner.textContent = 'This board is closed — the server has stopped. Answers up to your last edit were autosaved.';
        banner.style.display = 'block';
        submitBtn.disabled = true;
        stopHeartbeat();
      }
    }
  }, 3000);
  function stopHeartbeat() {
    if (hb) clearInterval(hb);
    hb = null;
  }
})();
