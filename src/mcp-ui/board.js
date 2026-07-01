// board.js — the relay board as an MCP App (SEP-1865 "io.modelcontextprotocol/ui").
//
// This is the same board relay opens in a browser, but rendered INSIDE the
// host app (Claude desktop/mobile, Codex, …) as a sandboxed inline iframe.
// There is no local HTTP server here: every exchange with the host travels over
// JSON-RPC on window.postMessage — the spec arrives as the tool result, the
// user's final submission goes back as a `ui/message` user turn, and vendored
// libraries (Chart.js / Mermaid / Viz.js) are pulled through the host's
// `resources/read`.
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

  // Platform awareness: reflect the host's surface so the board (and CSS) can
  // adapt — a data-platform hint, a touch flag, and the host's safe-area insets
  // applied as padding so content clears notches / home indicators on mobile.
  function applyHostEnv() {
    const root = document.documentElement;
    if (host.platform === 'web' || host.platform === 'desktop' || host.platform === 'mobile') {
      root.dataset.platform = host.platform;
    }
    root.classList.toggle('mcp-touch', Boolean(host.deviceCapabilities && host.deviceCapabilities.touch));
    const sai = host.safeAreaInsets;
    if (sai && typeof sai === 'object') {
      const px = (n) => (Number.isFinite(n) ? n : 0) + 'px';
      root.style.setProperty('--mcp-safe-top', px(sai.top));
      root.style.setProperty('--mcp-safe-right', px(sai.right));
      root.style.setProperty('--mcp-safe-bottom', px(sai.bottom));
      root.style.setProperty('--mcp-safe-left', px(sai.left));
    }
  }

  let sizeTimer = null;
  function measureHeight() {
    return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  }
  function sendSize() {
    notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height: measureHeight() });
  }
  function reportSize() {
    if (sizeTimer) return;
    sizeTimer = setTimeout(() => { sizeTimer = null; sendSize(); }, 60);
  }
  // Immediate, un-debounced report — used when the board shrinks (e.g. after
  // submit) so the host collapses the iframe right away instead of waiting.
  function reportSizeNow() {
    if (sizeTimer) { clearTimeout(sizeTimer); sizeTimer = null; }
    sendSize();
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
        note: rq.note === undefined ? (type === 'single' || type === 'rank' || type === 'checklist' || type === 'allocate') : rq.note === true,
        placeholder: typeof rq.placeholder === 'string' ? rq.placeholder : '',
        blocks: normBlocks(rq.blocks, id + '-'),
      };
      if (type === 'single' || type === 'multi' || type === 'rank' || type === 'checklist' || type === 'allocate') {
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
        if (type === 'single' || type === 'multi') q.other = type === 'single' ? rq.other !== false : rq.other === true;
      }
      if (type === 'checklist') {
        const rawSt = Array.isArray(rq.statuses) && rq.statuses.length ? rq.statuses
          : [{ value: 'pass', label: 'Pass', tone: 'ok' }, { value: 'fail', label: 'Fail', tone: 'bad' }, { value: 'na', label: 'N/A', tone: 'muted' }];
        q.statuses = rawSt.map((s) => typeof s === 'object' && s
          ? { value: String(s.value != null ? s.value : s.label || ''), label: String(s.label != null ? s.label : s.value || ''), tone: s.tone ? String(s.tone) : undefined }
          : { value: String(s), label: String(s) === 'na' ? 'N/A' : String(s) });
      }
      if (type === 'allocate') {
        q.total = Number.isFinite(rq.total) && rq.total > 0 ? Math.floor(rq.total) : 100;
        if (rq.unit !== undefined) q.unit = String(rq.unit);
      }
      if (type === 'scale') {
        q.min = Number.isFinite(rq.min) ? rq.min : 1;
        q.max = Number.isFinite(rq.max) ? rq.max : Math.max(5, q.min + 1);
        q.minLabel = typeof rq.minLabel === 'string' ? rq.minLabel : '';
        q.maxLabel = typeof rq.maxLabel === 'string' ? rq.maxLabel : '';
      }
      if (type === 'color' && Array.isArray(rq.presets)) {
        q.presets = rq.presets.map((c) => String(c)).filter(Boolean);
      }
      if (type === 'color' && Array.isArray(rq.palette)) {
        q.palette = rq.palette.map((p) => typeof p === 'object' && p
          ? { value: String(p.value != null ? p.value : p.color || ''), label: String(p.label != null ? p.label : (p.name != null ? p.name : (p.value != null ? p.value : p.color || ''))) }
          : { value: String(p), label: String(p) }).filter((p) => p.value);
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
      // No annotation during the streaming preview (it re-renders); on the final
      // interactive render, wire the engine so blocks register their targets.
      annotate: composing ? null : Annotate,
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
  const state = { answers: {}, other: {}, notes: {}, comment: '', blockEdits: {}, annotations: [] };
  // Element-level comments: the SAME self-contained annotate engine the browser
  // board uses (no server — it reports the thread list via onChange). Charts,
  // diagram nodes, table cells, images and text selections become commentable;
  // the comments ride back in the submission alongside answers.
  const Annotate = (window.RelayAnnotate && typeof window.RelayAnnotate.init === 'function') ? window.RelayAnnotate : null;
  let submitted = false;
  const cards = {};
  const app = document.getElementById('app');

  // ---------- display mode (host-driven) ----------
  // GUI hosts (Claude, Codex) render their OWN full-screen control, so relay
  // adds no redundant button. We still declare fullscreen support in
  // ui/initialize and react to the host's mode change: in fullscreen the iframe
  // fills the window, so we center the content to a readable column.
  let displayMode = 'inline';
  function applyDisplayMode() {
    document.documentElement.classList.toggle('mcp-fullscreen', displayMode === 'fullscreen');
    reportSize();
  }

  function seedDefaults() {
    for (const q of QS) if (q.default !== undefined) state.answers[q.id] = q.default;
    // Rank questions carry a full, valid permutation so an untouched rank still
    // submits a meaningful order (mirrors the browser board's seedRankOrder).
    for (const q of QS) {
      if (q.type !== 'rank') continue;
      const opts = (q.options || []).map((o) => o.value);
      const prior = Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [];
      const order = prior.filter((v, i) => opts.includes(v) && prior.indexOf(v) === i);
      for (const v of opts) if (!order.includes(v)) order.push(v);
      state.answers[q.id] = order;
    }
    for (const q of QS) if (q.type === 'allocate') state.answers[q.id] = seedAllocate(q, state.answers[q.id]);
    for (const q of QS) if (q.type === 'checklist') state.answers[q.id] = seedChecklist(q, state.answers[q.id]);
  }
  function seedAllocate(q, prior) {
    const m = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
    const out = {};
    for (const o of q.options || []) out[o.value] = Math.max(0, Number(m[o.value]) || 0);
    return out;
  }
  function seedChecklist(q, prior) {
    const m = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
    const optVals = new Set((q.options || []).map((o) => o.value));
    const stVals = new Set((q.statuses || []).map((s) => s.value));
    const out = {};
    for (const k of Object.keys(m)) if (optVals.has(k) && stVals.has(m[k])) out[k] = m[k];
    return out;
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
      case 'rank':
        return Array.isArray(v) && v.length ? [...v] : undefined;
      case 'checklist': {
        const m = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        return Object.keys(m).length ? { ...m } : undefined;
      }
      case 'allocate': {
        const m = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        const sum = Object.values(m).reduce((a, n) => a + (Number(n) || 0), 0);
        return sum > 0 ? { ...m } : undefined;
      }
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
    const annotations = Array.isArray(state.annotations) && state.annotations.length ? state.annotations : null;
    return { answers, skipped, comment: (state.comment || '').trim(), notes, blockEdits, annotations };
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
      const text = el('textarea', { class: 'otherinput', rows: '2', placeholder: 'your own answer…' });
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
      const text = el('textarea', { class: 'otherinput', rows: '2', placeholder: 'your own answer…' });
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
  // Checklist / allocate — see the browser board's controls (no autosave here).
  function controlChecklist(q) {
    const wrap = el('div', { class: 'checklist' });
    const cur = () => (state.answers[q.id] && typeof state.answers[q.id] === 'object' && !Array.isArray(state.answers[q.id])
      ? state.answers[q.id] : (state.answers[q.id] = {}));
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
        });
        buttons.push({ btn: b, val: s.value });
        seg.append(b);
      }
      wrap.append(el('div', { class: 'chk-row' },
        el('div', { class: 'chk-body' }, el('div', { class: 'ol' }, o.label), o.description ? el('div', { class: 'od' }, o.description) : null),
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
      const tail = sum > total ? ' (over by ' + (sum - total) + ')' : sum < total ? ' (' + (total - sum) + ' left)' : ' ✓';
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
        const up = el('button', { type: 'button', class: 'rank-btn', title: 'Move up', 'aria-label': 'Move "' + o.label + '" up' }, '↑');
        const down = el('button', { type: 'button', class: 'rank-btn', title: 'Move down', 'aria-label': 'Move "' + o.label + '" down' }, '↓');
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

  // ======================================================================
  // render
  // ======================================================================
  function render() {
    app.replaceChildren();
    const annotateOn = !composing && Annotate;
    const titleEl = el('h1', {}, spec.title);
    app.append(el('header', { class: 'qb-header' }, titleEl));
    if (annotateOn) Annotate.register(titleEl, { blockId: null, questionId: null, target: { kind: 'html-element', label: spec.title } });
    if (spec.intro) {
      const md = window.RelayBlocks && RelayBlocks.renderMarkdown;
      const introEl = md
        ? el('div', { class: 'intro blk-markdown' }, RelayBlocks.renderMarkdown(spec.intro))
        : el('p', { class: 'intro' }, spec.intro);
      app.append(introEl);
      if (annotateOn) Annotate.enableTextSelection(introEl, { blockId: null, questionId: null });
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
      else if (q.type === 'color') control.append(controlColor(q));
      else if (q.type === 'rank') control.append(controlRank(q));
      else if (q.type === 'checklist') control.append(controlChecklist(q));
      else if (q.type === 'allocate') control.append(controlAllocate(q));
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

    if (composing) {
      // still streaming in — show a live "composing" note, no submit yet
      app.append(el('div', { class: 'submitbar' }, el('span', { class: 'mcp-composing' }, 'Composing this board…')));
      reportSize();
      return;
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
    if (data.annotations && data.annotations.length) {
      lines.push('', 'Inline comments (' + data.annotations.length + '):');
      for (const a of data.annotations) {
        const where = (a.target && (a.target.label || a.target.text || a.target.kind)) || a.blockId || 'element';
        lines.push('- [' + where + ']: ' + a.text);
      }
    }
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
      annotations: data.annotations,
    };
    const text = summarize(data);
    let messageDelivered = false;
    let contextDelivered = false;
    try {
      // A completed relay form is a user reply, not passive context. Some hosts
      // ACK `ui/update-model-context` without starting a new model turn, so send
      // the transcript as a user message first to wake the agent reliably.
      await request('ui/message', { role: 'user', content: { type: 'text', text } });
      messageDelivered = true;
    } catch {
      // Older/leaner hosts may not expose app-initiated messages.
    }
    try {
      // Keep the structured payload available to hosts that attach app context.
      // This is best-effort because context updates are intentionally silent.
      await request('ui/update-model-context', { content: [{ type: 'text', text }], structuredContent: structured });
      contextDelivered = true;
    } catch {
      // If ui/message worked, the agent still receives the submission transcript.
    }
    submitted = true;
    showDone(messageDelivered, contextDelivered);
  }

  function showDone(messageDelivered, contextDelivered) {
    // Collapse: leave fullscreen, drop the whole form for a one-line confirmation
    // so the host shrinks the iframe to a small footprint in the transcript.
    if (Annotate) { try { Annotate.teardown(); } catch { /* nothing to tear down */ } }
    document.documentElement.classList.remove('mcp-fullscreen');
    app.replaceChildren(el('div', { class: 'mcp-done' },
      el('span', { class: 'mark' }, '✓'),
      el('span', { class: 'lead' }, QS.length ? 'Submitted' : 'Acknowledged'),
      el('span', { class: 'sub' }, messageDelivered
        ? '· sent back to the agent'
        : contextDelivered
          ? '· saved; send the agent a message to continue'
        : '· tell the agent you’ve responded')));
    // Report the small height immediately, then again next frame / after layout
    // settles — beats hosts that only grow on debounced size events.
    reportSizeNow();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reportSizeNow);
    setTimeout(reportSizeNow, 150);
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
    composing = false;
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    spec = next;
    QS = spec.questions || [];
    seedDefaults();
    indexHtmlBlocks(spec);
    setStatus('Preparing…');
    if (Annotate) Annotate.init({ initial: [], onChange: (a) => { state.annotations = Array.isArray(a) ? a : []; } });
    try { await preloadVendors(spec); } catch { /* render anyway; blocks degrade individually */ }
    render();
    applyDisplayMode();
  }

  // Progressive preview: the host MAY stream the tool call's JSON as the agent
  // writes it (ui/notifications/tool-input-partial — unclosed JSON auto-closed
  // into a valid object). We render whatever blocks/questions are already valid
  // so the board appears incrementally instead of only after the whole spec is
  // generated. It's a read-only preview — submit is withheld until the final
  // input/result arrives. Degrades to nothing on hosts that don't stream.
  let composing = false;
  let previewTimer = null;
  let vendorsKicked = false;
  function renderPreview(rawArgs) {
    if (booted || submitted) return;
    const next = clientNormalize(rawArgs);
    if (!next) return;
    const hasContent = (next.questions && next.questions.length) || (Array.isArray(next.blocks) && next.blocks.length);
    if (!hasContent) return;
    spec = next;
    QS = spec.questions || [];
    composing = true;
    indexHtmlBlocks(spec);
    if (!vendorsKicked) { vendorsKicked = true; preloadVendors(spec).catch(() => {}); }
    if (previewTimer) return; // coalesce a burst of partials into one paint
    previewTimer = setTimeout(() => { previewTimer = null; if (!booted && !submitted) render(); }, 120);
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
  onNotify('ui/notifications/tool-input-partial', (p) => {
    const args = p && p.arguments;
    if (args && typeof args === 'object') renderPreview(args);
  });
  onNotify('ui/notifications/host-context-changed', (p) => {
    if (p && typeof p === 'object') {
      if ('theme' in p) host.theme = p.theme;
      if ('styles' in p) host.styles = p.styles;
      if ('platform' in p) host.platform = p.platform;
      if ('safeAreaInsets' in p) host.safeAreaInsets = p.safeAreaInsets;
      if ('deviceCapabilities' in p) host.deviceCapabilities = p.deviceCapabilities;
      if (p.displayMode === 'inline' || p.displayMode === 'fullscreen' || p.displayMode === 'pip') {
        displayMode = p.displayMode;
        applyDisplayMode();
      }
      adoptHostStyles();
      applyHostEnv();
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
    applyHostEnv();
    applyTheme();
    setStatus('Waiting for the board…');
    reportSize();
  })();
})();
