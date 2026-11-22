  // ---------- PDF (local stream or direct URL) ----------
  function renderPdf(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-pdfwrap' });
    const src = block.hasFile ? '/pdf/b/' + encodeURIComponent(blockId) : block.src;
    const title = block.title || 'PDF';
    const frame = el('iframe', {
      class: 'blk-pdf',
      src,
      title,
      loading: 'lazy',
    });
    if (block.height != null) frame.style.height = clampHeight(block.height, 900) + 'px';
    frame.addEventListener('error', () => {
      wrap.replaceChildren(el('div', { class: 'blk-error' }, 'PDF failed to load'));
    });
    wrap.append(frame);
    if (block.title) wrap.append(el('div', { class: 'blk-videocap' }, block.title));
    attachViewer(wrap, { zoomEl: null, label: 'pdf', comment: wholeBlockComment(ctx, blockId, 'pdf') });
    return wrap;
  }

