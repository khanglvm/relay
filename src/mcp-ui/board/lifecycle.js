  // ======================================================================
  // boot
  // ======================================================================
  function setStatus(text) {
    const s = document.getElementById('mcp-status');
    if (s) s.textContent = text;
  }

  let booted = false;
  async function boot(rawOrNormalized, alreadyNormalized, draft) {
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
    restoreDraft(draft);
    indexHtmlBlocks(spec);
    setStatus('Preparing…');
    if (Annotate && spec.responseRequired !== false) {
      Annotate.init({ initial: state.annotations, onChange: (a) => { state.annotations = Array.isArray(a) ? a : []; } });
    } else if (Annotate && typeof Annotate.teardown === 'function') {
      Annotate.teardown();
    }
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

  // The tool result carries only the board id and token. The spec comes from
  // relay_view, already normalized by the server. A host that will not run app
  // tool calls still gets a board: the raw tool input is the fallback, held for
  // a moment so the server's version wins when both arrive.
  let rawInput = null;
  let rawInputTimer = null;
  const DRAFT_EVERY_MS = 4000;
  let lastDraft = '';

  function startDraftSync() {
    setInterval(() => {
      if (!booted || submitted || !BOARD.token || spec.responseRequired === false) return;
      const body = JSON.stringify(payload());
      if (body === lastDraft) return;
      lastDraft = body;
      callServerTool('relay_draft', { boardId: BOARD.id, token: BOARD.token, draft: JSON.parse(body) }).catch(() => {});
    }, DRAFT_EVERY_MS);
  }

  async function bootFromServer(result) {
    const sc = result && result.structuredContent;
    const token = result && result._meta && result._meta.relay && result._meta.relay.token;
    if (!sc || !sc.boardId || !token) return false;
    BOARD.id = sc.boardId;
    BOARD.token = token;
    try {
      const view = await callServerTool('relay_view', { boardId: BOARD.id, token: BOARD.token });
      if (!view.spec) return false;
      vendorUrls = view.vendorUrls || null;
      await boot(view.spec, true, view.draft);
      if (view.finished) {
        submitted = true;
        showDone(true, false);
        return true;
      }
      startDraftSync();
      return true;
    } catch {
      BOARD.token = null;
      return false;
    }
  }

  onNotify('ui/notifications/tool-result', async (p) => {
    if (rawInputTimer) { clearTimeout(rawInputTimer); rawInputTimer = null; }
    if (booted) return;
    if (!(await bootFromServer(p)) && rawInput) boot(rawInput, false);
  });
  onNotify('ui/notifications/tool-input', (p) => {
    const args = p && p.arguments;
    if (!args || typeof args !== 'object' || booted || rawInputTimer) return;
    rawInput = args;
    rawInputTimer = setTimeout(() => { rawInputTimer = null; boot(args, false); }, 1500);
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
