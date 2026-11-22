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
  function request(method, params, timeoutMs = 15000) {
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
      }, timeoutMs);
    });
  }
  // Calls one of the relay server's tools through the host. A tool-level error
  // rejects, so callers handle "the host refused" and "the server said no" alike.
  async function callServerTool(name, args, timeoutMs) {
    const res = await request('tools/call', { name, arguments: args }, timeoutMs);
    if (!res || res.isError) {
      const msg = res && Array.isArray(res.content) && res.content[0] && res.content[0].text;
      throw new Error(msg || 'tool failed: ' + name);
    }
    return res.structuredContent || {};
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

