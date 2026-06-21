// board.js — the relay board as an MCP App (SEP-1865 "io.modelcontextprotocol/ui").
//
// This is the same board relay opens in a browser, but rendered INSIDE the
// host app (Claude desktop/mobile, Codex, …) as a sandboxed inline iframe.
// There is no local HTTP server here: every exchange with the host travels over
// JSON-RPC on window.postMessage — the spec arrives as the tool result, the
// user's answers go back via `ui/update-model-context`, and vendored libraries
// (Chart.js / Mermaid / Viz.js) are pulled through the host's `resources/read`.
//
// Rich blocks are rendered by the SAME window.RelayBlocks as the browser board
// (markdown, code, diff, table, chart, mermaid, graphviz, image, html), so the
// two surfaces stay in lockstep. Annotations / autosave / heartbeat are
// browser-server concepts and intentionally absent; per-question notes and the
// overall comment carry structured feedback back to the agent.
(() => {
  'use strict';

  const BOOT = (() => {
    try { return JSON.parse(document.getElementById('boot').textContent); } catch { return {}; }
  })();
  const PROTOCOL = '2025-06-18';

  // ---------- tiny DOM helper (mirrors app.js / blocks.js) ----------
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

  // ======================================================================
  // MCP Apps postMessage / JSON-RPC bridge
  // ======================================================================
  const pending = new Map();
  let rpcSeq = 0;
  const notifyHandlers = Object.create(null);
  function onNotify(method, fn) {
    (notifyHandlers[method] || (notifyHandlers[method] = [])).push(fn);
  }
  function post(msg) {
    try {
      (window.parent && window.parent !== window ? window.parent : window).postMessage(msg, '*');
    } catch {
      // host frame gone — nothing we can do
    }
  }
  function request(method, params) {
    const id = 'rly-' + (++rpcSeq);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ jsonrpc: '2.0', id, method, params: params || {} });
      // Don't hang forever if a host ignores a method — resolve-less reject.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 15000);
    });
  }
  function notify(method, params) {
    post({ jsonrpc: '2.0', method, params: params || {} });
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    // A response to one of our requests.
    if (msg.id !== undefined && msg.id !== null && (('result' in msg) || ('error' in msg))) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    // A notification or request FROM the host.
    if (typeof msg.method === 'string') {
      const hs = notifyHandlers[msg.method] || [];
      for (const h of hs) {
        try { h(msg.params || {}, msg); } catch { /* handler errors never break the bridge */ }
      }
      // Host requests we must acknowledge.
      if (msg.id !== undefined && msg.id !== null) {
        if (msg.method === 'ui/resource-teardown') post({ jsonrpc: '2.0', id: msg.id, result: {} });
        else post({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    }
  });

  // ======================================================================
  // theme + size
  // ======================================================================
  let host = {};
  function effectiveTheme() {
    if (host.theme === 'dark' || host.theme === 'light') return host.theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme() {
    const t = host.theme;
    if (t === 'dark' || t === 'light') {
      document.documentElement.dataset.theme = t;
      // Pin color-scheme so the host's light-dark() style variables resolve to
      // the side the host actually picked (not whatever the OS prefers).
      document.documentElement.style.colorScheme = t;
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = 'light dark';
    }
    if (window.RelayBlocks && typeof RelayBlocks.onThemeChange === 'function') {
      try { RelayBlocks.onThemeChange(effectiveTheme()); } catch { /* not rendered yet */ }
    }
  }

  // Full color-blend: map the host's standardized style variables (SEP-1865
  // theming) onto relay's own custom properties so the board adopts the app's
  // surfaces, text, borders, primary-action color and fonts — reading as part of
  // Claude/Codex rather than a foreign page. Every mapping is conditional: a
  // token the host omits keeps relay's own default, so it degrades gracefully on
  // leaner hosts (where the warm terracotta identity simply stays).
  const HOST_VAR_MAP = {
    '--bg': '--color-background-primary',
    '--card': '--color-background-secondary',
    '--bg-sunken': '--color-background-tertiary',
    '--fg': '--color-text-primary',
    '--fg-2': '--color-text-secondary',
    '--muted': '--color-text-tertiary',
    '--border': '--color-border-primary',
    '--border-strong': '--color-border-secondary',
    '--accent': '--color-background-inverse',
    '--accent-hover': '--color-background-inverse',
    '--accent-fg': '--color-text-inverse',
    '--accent-soft': '--color-background-tertiary',
    '--danger': '--color-text-danger',
    '--ok': '--color-text-success',
    '--sans': '--font-sans',
    '--mono': '--font-mono',
  };
  let hostFontStyleEl = null;
  function adoptHostStyles() {
    const styles = host && host.styles;
    if (!styles || typeof styles !== 'object') return;
    const v = styles.variables && typeof styles.variables === 'object' ? styles.variables : {};
    const root = document.documentElement.style;
    for (const [ours, theirs] of Object.entries(HOST_VAR_MAP)) {
      if (typeof v[theirs] === 'string' && v[theirs]) root.setProperty(ours, v[theirs]);
    }
    const fonts = styles.css && typeof styles.css.fonts === 'string' ? styles.css.fonts : '';
    if (fonts) {
      if (!hostFontStyleEl) { hostFontStyleEl = document.createElement('style'); document.head.appendChild(hostFontStyleEl); }
      hostFontStyleEl.textContent = fonts;
    }
  }

  let sizeTimer = null;
  function reportSize() {
    if (sizeTimer) return;
    sizeTimer = setTimeout(() => {
      sizeTimer = null;
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height });
    }, 60);
  }
  window.addEventListener('resize', reportSize);
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(reportSize).observe(document.documentElement); } catch { /* older host */ }
  }

  // ======================================================================
  // client-side spec normalization (resilience)
  // ----------------------------------------------------------------------
  // The host normally hands us the SERVER-normalized spec via the tool result
  // (structuredContent.spec) — options as {value,label}, blocks with ids, etc.
  // If a host only forwards the raw tool input, this brings it close enough to
  // render: it assigns ids and coerces option/column shapes. File-backed blocks
  // (codeFile/htmlFile/local images) can't be resolved client-side and are left
  // to the server path.
  function clientNormalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const spec = {
      title: String(raw.title || 'Relay'),
      intro: typeof raw.intro === 'string' ? raw.intro : '',
      blocks: normBlocks(raw.blocks, ''),
      allowPartial: raw.allowPartial !== false,
      note: raw.note !== false,
      autoClose: raw.autoClose !== false,
      questions: [],
      submitLabel: typeof raw.submitLabel === 'string' ? raw.submitLabel : '',
    };
    const qs = Array.isArray(raw.questions) ? raw.questions : [];
    qs.forEach((rq, i) => {
      if (!rq || typeof rq !== 'object') return;
      const id = String(rq.id || 'q' + (i + 1));
      const type = String(rq.type || 'text');
      const q = {
        id, type,
        label: String(rq.label || rq.question || rq.text || ''),
        description: typeof rq.description === 'string' ? rq.description : '',
        required: rq.required === true,
        note: rq.note === undefined ? type === 'single' : rq.note === true,
        placeholder: typeof rq.placeholder === 'string' ? rq.placeholder : '',
        blocks: normBlocks(rq.blocks, id + '-'),
      };
      if (type === 'single' || type === 'multi') {
        const opts = Array.isArray(rq.options) ? rq.options : [];
        q.options = opts.map((o, j) => {
          if (typeof o === 'string' || typeof o === 'number') return { value: String(o), label: String(o) };
          if (o && typeof o === 'object') {
            const value = String(o.value != null ? o.value : o.label != null ? o.label : '');
            const out = { value, label: String(o.label != null ? o.label : value) };
            if (o.description) out.description = String(o.description);
            const ob = normBlocks(o.blocks, id + '-o' + (j + 1) + '-');
            if (ob.length) out.blocks = ob;
            return out;
          }
          return { value: String(o), label: String(o) };
        });
        q.other = rq.other === true;
      }
      if (type === 'scale') {
        q.min = Number.isFinite(rq.min) ? rq.min : 1;
        q.max = Number.isFinite(rq.max) ? rq.max : Math.max(5, q.min + 1);
        q.minLabel = typeof rq.minLabel === 'string' ? rq.minLabel : '';
        q.maxLabel = typeof rq.maxLabel === 'string' ? rq.maxLabel : '';
      }
      if (rq.default !== undefined) q.default = rq.default;
      spec.questions.push(q);
    });
    if (!spec.submitLabel) spec.submitLabel = spec.questions.length ? 'Submit' : 'Acknowledge';
    return spec;
  }
  function normBlocks(blocks, prefix) {
    if (!Array.isArray(blocks)) return [];
    let n = 0;
    const out = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object' || !b.type) continue;
      out.push(b.id ? b : { ...b, id: prefix + 'b' + (++n) });
      if (b.id) n++;
    }
    return out;
  }

  // ======================================================================
  // vendored libraries pulled through the host bridge (resources/read)
  // ----------------------------------------------------------------------
  // blocks.js lazy-loads Chart.js / Mermaid / Viz.js via <script src="/vendor/…">
  // and short-circuits when the global already exists. There's no server here,
  // so we fetch the vendor source over the bridge and define the global up
  // front; blocks.js then never reaches for the (absent) /vendor route.
  const NEED = { chart: ['chart.umd.js', 'Chart'], mermaid: ['mermaid.min.js', 'mermaid'], graphviz: ['viz-standalone.js', 'Viz'] };
  function blockTypesIn(spec) {
    const types = new Set();
    const scan = (blocks) => {
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b && b.type) types.add(b.type);
        if (b && Array.isArray(b.blocks)) scan(b.blocks);
      }
    };
    scan(spec.blocks);
    for (const q of spec.questions || []) {
      scan(q.blocks);
      for (const o of Array.isArray(q.options) ? q.options : []) if (o) scan(o.blocks);
    }
    return types;
  }
  async function ensureVendor(file, globalName) {
    if (window[globalName]) return true;
    try {
      const res = await request('resources/read', { uri: 'ui://relay/vendor/' + file });
      const c = res && Array.isArray(res.contents) ? res.contents[0] : null;
      const code = c && (c.text || (c.blob ? atob(c.blob) : ''));
      if (!code) return false;
      const s = document.createElement('script');
      s.textContent = code;
      document.head.appendChild(s);
      return Boolean(window[globalName]);
    } catch {
      return false;
    }
  }
  async function preloadVendors(spec) {
    const types = blockTypesIn(spec);
    const jobs = [];
    if (types.has('chart')) jobs.push(ensureVendor(...NEED.chart));
    if (types.has('mermaid')) jobs.push(ensureVendor(...NEED.mermaid));
    if (types.has('graphviz')) jobs.push(ensureVendor(...NEED.graphviz));
    if (jobs.length) await Promise.allSettled(jobs);
  }

  // html blocks: the browser board serves each in its own iframe from
  // /html/b/<id>. Here we wrap the body into a self-contained document and hand
  // blocks.js a blob: URL for the iframe src (same sandbox, no server needed).
  const htmlBodies = new Map();
  function indexHtmlBlocks(spec) {
    const add = (blocks) => {
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b && b.type === 'html' && typeof b.html === 'string') htmlBodies.set(b.id, b.html);
      }
    };
    add(spec.blocks);
    for (const q of spec.questions || []) {
      add(q.blocks);
      for (const o of Array.isArray(q.options) ? q.options : []) if (o) add(o.blocks);
    }
  }
  function htmlBlobSrc(blockId) {
    const body = htmlBodies.get(blockId) || '';
    const dark = effectiveTheme() === 'dark';
    let doc;
    if (/<html[\s>]/i.test(body)) {
      doc = body;
    } else {
      const bg = dark ? '#282624' : '#ffffff';
      const fg = dark ? '#edeae4' : '#1c1b19';
      doc =
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<style>:root{color-scheme:' + (dark ? 'dark' : 'light') + '}' +
        'body{margin:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;' +
        'background:' + bg + ';color:' + fg + '}</style></head><body>' + body + '</body></html>';
    }
    try {
      return URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    } catch {
      return 'data:text/html;charset=utf-8,' + encodeURIComponent(doc);
    }
  }

  function blockCtx(questionId) {
    return {
      theme: effectiveTheme,
      htmlSrc: (blockId) => htmlBlobSrc(blockId),
      questionId: questionId == null ? null : questionId,
      annotate: null,
      edits: state.blockEdits,
      onBlockEdit: (blockId, codeOrNull) => {
        if (codeOrNull === null || codeOrNull === undefined) delete state.blockEdits[blockId];
        else state.blockEdits[blockId] = codeOrNull;
      },
    };
  }
  function renderBlocks(container, blocks, questionId) {
    if (!Array.isArray(blocks) || !blocks.length) return;
    const target = el('div', { class: 'blocks' });
    container.append(target);
    if (!window.RelayBlocks) {
      target.append(el('div', { class: 'blk' }, el('div', { class: 'blk-error' }, 'block failed to render')));
      return;
    }
    Promise.resolve()
      .then(() => window.RelayBlocks.render(target, blocks, blockCtx(questionId)))
      .then(reportSize)
      .catch(() => {
        target.append(el('div', { class: 'blk' }, el('div', { class: 'blk-error' }, 'block failed to render')));
      });
  }

  // ======================================================================
  // board state + answer controls (ported from the browser board)
  // ======================================================================
  let spec = null;
  let QS = [];
  const state = { answers: {}, other: {}, notes: {}, comment: '', blockEdits: {} };
  let submitted = false;
  const cards = {};
  const app = document.getElementById('app');

  // ---------- display mode (inline ⇄ fullscreen) ----------
  // Big diagrams / diffs / prototypes can take over the host window via
  // ui/request-display-mode, then snap back. We only offer it when the host
  // advertises 'fullscreen' (or stays silent about its modes).
  let displayMode = 'inline';
  let fsBtn = null;
  function fullscreenOffered() {
    const modes = host && Array.isArray(host.availableDisplayModes) ? host.availableDisplayModes : null;
    return modes ? modes.includes('fullscreen') : true;
  }
  function syncFsBtn() {
    if (!fsBtn) return;
    const full = displayMode === 'fullscreen';
    fsBtn.textContent = full ? '⤡' : '⤢';
    fsBtn.title = full ? 'Exit full screen' : 'Full screen';
    fsBtn.setAttribute('aria-label', fsBtn.title);
  }
  async function toggleFullscreen() {
    const target = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    try {
      const res = await request('ui/request-display-mode', { mode: target });
      const m = res && res.mode;
      if (m === 'inline' || m === 'fullscreen' || m === 'pip') displayMode = m;
    } catch { /* host declined / unsupported — leave mode as-is */ }
    syncFsBtn();
    reportSize();
  }

  function seedDefaults() {
    for (const q of QS) if (q.default !== undefined) state.answers[q.id] = q.default;
  }

  function getValue(q) {
    const v = state.answers[q.id];
    const oth = state.other[q.id];
    switch (q.type) {
      case 'single': {
        if (oth && oth.on) { const t = (oth.text || '').trim(); return t || undefined; }
        return typeof v === 'string' && v ? v : undefined;
      }
      case 'multi': {
        const arr = Array.isArray(v) ? [...v] : [];
        if (oth && oth.on) { const t = (oth.text || '').trim(); if (t) arr.push(t); }
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
    const notes = {};
    for (const q of QS) {
      const v = getValue(q);
      if (v !== undefined) answers[q.id] = v;
      const n = typeof state.notes[q.id] === 'string' ? state.notes[q.id].trim() : '';
      if (n) notes[q.id] = n;
    }
    const skipped = QS.filter((q) => !(q.id in answers)).map((q) => q.id);
    const blockEdits = Object.keys(state.blockEdits).length ? state.blockEdits : null;
    return { answers, skipped, comment: (state.comment || '').trim(), notes, blockEdits };
  }

  function clearErr(qid) { if (cards[qid]) cards[qid].classList.remove('error'); }

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
      const text = el('input', { type: 'text', placeholder: 'your own answer…' });
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
      const text = el('input', { type: 'text', placeholder: 'your own answer…' });
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
    const seg = el('div', { class: q.type === 'scale' ? 'scale' : 'seg' });
    const buttons = [];
    values.forEach((v, i) => {
      const b = el('button', { type: 'button' }, labels[i]);
      if (state.answers[q.id] === v) b.classList.add('sel');
      b.addEventListener('click', () => {
        if (state.answers[q.id] === v) delete state.answers[q.id];
        else state.answers[q.id] = v;
        for (const x of buttons) x.classList.toggle('sel', state.answers[q.id] === values[buttons.indexOf(x)]);
        clearErr(q.id);
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
    input.addEventListener('input', () => { state.answers[q.id] = input.value; clearErr(q.id); });
    return input;
  }

  // ======================================================================
  // render
  // ======================================================================
  function render() {
    app.replaceChildren();
    const header = el('header', { class: 'qb-header' }, el('h1', {}, spec.title));
    if (fullscreenOffered()) {
      fsBtn = el('button', { class: 'mcp-fs', type: 'button' });
      fsBtn.addEventListener('click', toggleFullscreen);
      syncFsBtn();
      header.append(fsBtn);
    }
    app.append(header);
    if (spec.intro) {
      const md = window.RelayBlocks && RelayBlocks.renderMarkdown;
      app.append(md
        ? el('div', { class: 'intro blk-markdown' }, RelayBlocks.renderMarkdown(spec.intro))
        : el('p', { class: 'intro' }, spec.intro));
    }
    renderBlocks(app, spec.blocks || [], null);

    QS.forEach((q, idx) => {
      const required = q.required || !spec.allowPartial;
      const card = el('div', { class: 'card' },
        el('div', { class: 'qnum' }, 'Q' + (idx + 1)),
        el('p', { class: 'qlabel' }, q.label, required ? el('span', { class: 'req' }, ' *') : null),
        q.description ? el('p', { class: 'qdesc' }, q.description) : null);
      renderBlocks(card, q.blocks || [], q.id);
      const control = el('div', { class: 'control' });
      if (q.type === 'single') control.append(controlSingle(q));
      else if (q.type === 'multi') control.append(controlMulti(q));
      else if (q.type === 'yesno') control.append(segButtons(q, ['yes', 'no'], ['Yes', 'No']));
      else if (q.type === 'scale') control.append(controlScale(q));
      else control.append(controlText(q, q.type === 'textarea'));
      card.append(control);
      if (q.note) {
        const noteInput = el('textarea', { class: 'qnote', rows: 2, placeholder: 'optional note about this answer…' });
        noteInput.value = typeof state.notes[q.id] === 'string' ? state.notes[q.id] : '';
        noteInput.addEventListener('input', () => { state.notes[q.id] = noteInput.value; });
        card.append(el('div', { class: 'qnotewrap' }, noteInput));
      }
      card.append(el('p', { class: 'errmsg' }, 'This question is required.'));
      cards[q.id] = card;
      app.append(card);
    });

    if (spec.note) {
      const note = el('textarea', { placeholder: 'optional note back to the agent…' });
      note.value = state.comment || '';
      note.addEventListener('input', () => { state.comment = note.value; });
      app.append(el('div', { class: 'card' },
        el('p', { class: 'qlabel' }, 'Anything else?'),
        el('p', { class: 'qdesc' }, 'Free-text note returned to the agent along with your answers.'),
        el('div', { class: 'control' }, note)));
    }

    const submitBtn = el('button', { class: 'submit', type: 'button' }, spec.submitLabel);
    const saveEl = el('span', { class: 'savestate' }, '');
    const hint = el('span', { class: 'hint' }, QS.length && spec.allowPartial ? 'Unanswered questions are returned as skipped.' : '');
    submitBtn.addEventListener('click', () => onSubmit(submitBtn, saveEl));
    app.append(el('div', { class: 'submitbar' }, submitBtn, hint, saveEl));
    reportSize();
  }

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

  // A human-readable transcript of the submission — so the agent reads the
  // answers even on a host that doesn't surface structuredContent.
  function summarize(data) {
    const lines = [];
    lines.push('The user submitted the relay board "' + spec.title + '".');
    if (QS.length) {
      lines.push('', 'Answers:');
      for (const q of QS) {
        const v = data.answers[q.id];
        let shown;
        if (v === undefined) shown = '(skipped)';
        else if (Array.isArray(v)) shown = v.join(', ');
        else shown = String(v);
        lines.push('- ' + q.label + ' [' + q.id + ']: ' + shown);
        if (data.notes[q.id]) lines.push('    note: ' + data.notes[q.id]);
      }
    }
    if (data.comment) lines.push('', 'Comment: ' + data.comment);
    if (data.blockEdits) lines.push('', 'Edited diagrams: ' + Object.keys(data.blockEdits).join(', '));
    return lines.join('\n');
  }

  async function onSubmit(submitBtn, saveEl) {
    if (submitted) return;
    if (!validate()) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    const data = payload();
    const structured = {
      boardId: BOOT.boardId || null,
      status: QS.length ? 'submitted' : 'acknowledged',
      answers: data.answers,
      skipped: data.skipped,
      notes: data.notes,
      comment: data.comment,
      blockEdits: data.blockEdits,
    };
    const text = summarize(data);
    let delivered = false;
    try {
      await request('ui/update-model-context', { content: [{ type: 'text', text }], structuredContent: structured });
      delivered = true;
    } catch {
      // Fallback for hosts without update-model-context: post a chat message.
      try { await request('ui/message', { role: 'user', content: { type: 'text', text } }); delivered = true; } catch { /* give up gracefully */ }
    }
    submitted = true;
    showDone(delivered);
  }

  function showDone(delivered) {
    app.replaceChildren(el('div', { class: 'mcp-done' },
      el('div', { class: 'mark' }, '✓'),
      el('h2', {}, QS.length ? 'Submitted' : 'Acknowledged'),
      el('p', {}, delivered
        ? 'Your answers were sent back to the agent.'
        : 'Saved — tell the agent you’ve responded so it can continue.')));
    reportSize();
  }

  // ======================================================================
  // boot
  // ======================================================================
  function setStatus(text) {
    const s = document.getElementById('mcp-status');
    if (s) s.textContent = text;
  }

  let booted = false;
  async function boot(rawOrNormalized, alreadyNormalized) {
    if (booted || submitted) return;
    const next = alreadyNormalized ? rawOrNormalized : clientNormalize(rawOrNormalized);
    if (!next || (!Array.isArray(next.questions)) ) { return; }
    if (!next.questions.length && !(Array.isArray(next.blocks) && next.blocks.length)) return;
    booted = true;
    spec = next;
    QS = spec.questions || [];
    seedDefaults();
    indexHtmlBlocks(spec);
    setStatus('Preparing…');
    try { await preloadVendors(spec); } catch { /* render anyway; blocks degrade individually */ }
    render();
  }

  // The spec can arrive as the tool RESULT (preferred — server-normalized) or,
  // on a leaner host, as the tool INPUT (raw). Prefer the result: when raw input
  // lands first, hold briefly for a result before falling back to the input.
  let rawInputTimer = null;
  onNotify('ui/notifications/tool-result', (p) => {
    if (rawInputTimer) { clearTimeout(rawInputTimer); rawInputTimer = null; }
    const sc = p && p.structuredContent;
    if (sc && sc.spec) return boot(sc.spec, true);
    // Some hosts may echo the spec at the top level of structuredContent.
    if (sc && Array.isArray(sc.questions)) return boot(sc, true);
  });
  onNotify('ui/notifications/tool-input', (p) => {
    const args = p && p.arguments;
    if (!args || typeof args !== 'object' || booted || rawInputTimer) return;
    rawInputTimer = setTimeout(() => { rawInputTimer = null; boot(args, false); }, 250);
  });
  onNotify('ui/notifications/host-context-changed', (p) => {
    if (p && typeof p === 'object') {
      if ('theme' in p) host.theme = p.theme;
      if ('styles' in p) host.styles = p.styles;
      if (p.displayMode === 'inline' || p.displayMode === 'fullscreen' || p.displayMode === 'pip') {
        displayMode = p.displayMode;
        syncFsBtn();
      }
      adoptHostStyles();
      applyTheme();
    }
  });

  // Kick off the handshake. Proceed even if the host doesn't answer init.
  // SEP-1865 lifecycle: ui/initialize → (host reply) → ui/notifications/initialized.
  // The host MUST NOT send tool-input / tool-result (i.e. the board spec) until
  // it receives `initialized`, so this notification is mandatory — without it the
  // board never gets its spec and never renders.
  (async () => {
    try {
      const res = await request('ui/initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'relay', version: String(BOOT.version || '0') },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      });
      host = (res && res.hostContext) || {};
    } catch {
      host = {};
    }
    if (host.displayMode === 'fullscreen' || host.displayMode === 'pip') displayMode = host.displayMode;
    notify('ui/notifications/initialized', {});
    adoptHostStyles();
    applyTheme();
    setStatus('Waiting for the board…');
    reportSize();
  })();
})();
