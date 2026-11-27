  // ---------- html (sandboxed iframe) ----------
  function syncHtmlHoverComments(frame) {
    try {
      frame.contentWindow.postMessage({ relay: 'annotate-hover', enabled: frame.dataset.relayHoverComments !== 'off' }, '*');
    } catch (_) {}
  }

  // The kit can load after the iframe's load event; its ready message also
  // restores the current toggle when the embedded page reloads.
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.relay !== 'annotate-ready') return;
    for (const frame of document.querySelectorAll('iframe.viz[data-relay-hover-comments]')) {
      if (frame.contentWindow === e.source) { syncHtmlHoverComments(frame); break; }
    }
  });

  function renderHtml(block, ctx, blockId) {
    const height = clampHeight(block.height, 360);
    const isolated = block.isolated === true;
    const iframe = el('iframe', {
      class: 'viz',
      'data-block-id': blockId,
      'data-question-id': ctx.questionId || '',
      // Relay's color scheme would otherwise reach the embedded document's media queries.
      ...(isolated ? { 'data-relay-isolated': '', style: 'color-scheme: normal' } : { 'data-relay-hover-comments': 'on' }),
      src: ctx.htmlSrc(blockId, isolated),
      height: String(height),
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals',
      loading: 'lazy',
    });
    const wrap = el('div', { class: 'blk-htmlwrap' }, iframe);
    const hoverComments = isolated ? null : {
      isEnabled: () => iframe.dataset.relayHoverComments !== 'off',
      setEnabled: (enabled) => {
        iframe.dataset.relayHoverComments = enabled ? 'on' : 'off';
        syncHtmlHoverComments(iframe);
      },
    };
    if (hoverComments) iframe.addEventListener('load', () => syncHtmlHoverComments(iframe));
    attachViewer(wrap, {
      zoomEl: null,
      label: 'embed',
      comment: wholeBlockComment(ctx, blockId, 'embed'),
      hoverComments,
    });
    return wrap;
  }

