  // ---------- compare (before/after image slider) ----------
  // The "after" image is the base layer (defines the frame size); the "before"
  // image sits in an overflow-clipped layer whose width the divider drives, so
  // dragging reveals more of one image and less of the other.
  function renderCompare(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-comparewrap' });
    const frame = el('div', { class: 'cmp-frame' });
    if (block.height) frame.style.maxHeight = clampHeight(block.height, 1200) + 'px';
    const afterImg = el('img', { class: 'cmp-img', src: block.after, alt: block.afterLabel || 'after', draggable: 'false', loading: 'lazy' });
    const beforeImg = el('img', { class: 'cmp-img cmp-img-before', src: block.before, alt: block.beforeLabel || 'before', draggable: 'false', loading: 'lazy' });
    const beforeLayer = el('div', { class: 'cmp-before' }, beforeImg);
    const handle = el('div', { class: 'cmp-handle', tabindex: '0', role: 'slider', 'aria-label': 'Compare before and after' },
      el('div', { class: 'cmp-handle-grip' }, '⟺'));
    frame.append(
      afterImg, beforeLayer, handle,
      el('span', { class: 'cmp-tag cmp-tag-before' }, block.beforeLabel || 'Before'),
      el('span', { class: 'cmp-tag cmp-tag-after' }, block.afterLabel || 'After')
    );
    wrap.append(frame);

    let pos = 50;
    const apply = () => { beforeLayer.style.width = pos + '%'; handle.style.left = pos + '%'; };
    // pin the before image to the frame's pixel width so the clip reveals it in
    // place (rather than squishing it as the clip narrows)
    const sizeBefore = () => { beforeImg.style.width = frame.clientWidth + 'px'; };
    const refresh = () => { sizeBefore(); apply(); };
    if (afterImg.complete && afterImg.naturalWidth) refresh();
    else afterImg.addEventListener('load', refresh, { once: true });
    window.addEventListener('resize', sizeBefore);

    let dragging = false;
    let dragMoved = false;
    let dragStartX = 0;
    const setFromX = (clientX) => {
      const r = frame.getBoundingClientRect();
      if (r.width) { pos = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)); apply(); }
    };
    frame.addEventListener('pointerdown', (e) => {
      const handleTarget = e.target.closest('.cmp-handle');
      if (!handleTarget || frame._rlyRegionMode) return;
      dragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      try { frame.setPointerCapture(e.pointerId); } catch (_) {}
    });
    frame.addEventListener('pointermove', (e) => {
      if (!dragging || frame._rlyRegionMode || frame._rlyRegionSelecting) return;
      if (Math.abs(e.clientX - dragStartX) > 3) dragMoved = true;
      if (dragMoved) { setFromX(e.clientX); e.preventDefault(); }
    });
    frame.addEventListener('pointerup', (e) => {
      if (dragging && !dragMoved && !frame._rlyRegionMode && !frame._rlyRegionSelecting) setFromX(e.clientX);
      dragging = false;
    });
    frame.addEventListener('pointercancel', () => { dragging = false; dragMoved = false; });
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { pos = Math.max(0, pos - 2); apply(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { pos = Math.min(100, pos + 2); apply(); e.preventDefault(); }
    });
    let region = null;
    if (ctx.annotate && ctx.canComment !== false) {
      frame.title = 'Drag to draw a comment area · drag the divider handle to compare';
      region = enableImageRegions({
        host: frame,
        surface: frame,
        panHost: frame,
        sourceForSide: (side) => side === 'before' ? beforeImg : afterImg,
        sideAtPoint: (x) => (x * 100 <= pos ? 'before' : 'after'),
        ctx,
        blockId,
        label: 'Comparison',
      });
    }
    attachViewer(wrap, {
      zoomEl: null,
      label: 'comparison',
      comment: wholeBlockComment(ctx, blockId, 'comparison'),
      region,
    });
    return wrap;
  }

