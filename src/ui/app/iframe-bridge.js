  // ---------- iframe annotate bridge ----------
  // Custom-HTML iframes (via /kit.js relayKit.annotate, auto-injected by the
  // server) talk to the parent over postMessage:
  //   iframe → {relay:'annotate-ready'}                      we send it counts
  //   iframe → {relay:'annotate-request', ref, label, detail?, rect}
  //   parent → {relay:'annotate-counts', counts:{ref:n}}     it draws badges
  // We own the annotation state, popover, and the submitted result; the iframe
  // owns hover/pin/badges over its own (cross-origin) DOM.
  if (Annotate && responseRequired) {
    const commentFrames = () => document.querySelectorAll('iframe.viz[data-relay-hover-comments]');
    const frameOf = (source) => {
      for (const f of commentFrames()) {
        if (f.contentWindow === source) return f;
      }
      return null;
    };
    // Per-element comment counts for one iframe, keyed by target.ref.
    const postCountsTo = (frame) => {
      if (!frame || !frame.contentWindow) return;
      const blockId = frame.getAttribute('data-block-id') || null;
      const counts = {};
      for (const a of Annotate.list()) {
        if ((a.blockId ?? null) !== (blockId ?? null)) continue;
        const t = a.target || {};
        if (t.kind !== 'html-element' || !t.ref) continue;
        counts[t.ref] = (counts[t.ref] || 0) + 1;
      }
      try { frame.contentWindow.postMessage({ relay: 'annotate-counts', counts }, '*'); } catch {}
    };
    // Refresh badges in every html iframe (called whenever annotations change).
    window.__relayBroadcastCounts = () => {
      for (const f of commentFrames()) postCountsTo(f);
    };

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object' || typeof msg.relay !== 'string') return;
      const frame = frameOf(e.source);
      if (!frame) return;
      if (msg.relay === 'annotate-ready') { postCountsTo(frame); return; }
      if (msg.relay !== 'annotate-request') return;

      const blockId = frame.getAttribute('data-block-id') || null;
      const questionId = frame.getAttribute('data-question-id') || null;
      const target = { kind: 'html-element', label: typeof msg.label === 'string' ? msg.label : 'Element' };
      if (typeof msg.ref === 'string') target.ref = msg.ref;
      if (typeof msg.detail === 'string') target.detail = msg.detail;

      // Anchor the popover to the actual element: translate the iframe-local
      // viewport rect the iframe sent into page coords. Fall back to the iframe.
      let anchor = frame;
      if (msg.rect && typeof msg.rect === 'object') {
        const fr = frame.getBoundingClientRect();
        const r = msg.rect;
        const left = fr.left + (r.left || 0);
        const top = fr.top + (r.top || 0);
        const width = r.width || 0;
        const height = r.height || 0;
        const pageRect = { left, top, width, height, right: left + width, bottom: top + height };
        anchor = { getBoundingClientRect: () => pageRect };
      }
      Annotate.openExternal({ blockId, questionId: questionId || null, target }, anchor);
    });
  }

