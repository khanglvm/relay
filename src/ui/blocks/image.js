  // ---------- image ----------
  let activeRegionMode = null;
  let viewerSpacePan = false;
  const setViewerSpacePan = (enabled) => {
    viewerSpacePan = Boolean(enabled);
    document.body.classList.toggle('blk-space-pan', viewerSpacePan);
  };
  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
    if (e.code === 'Space' && !e.repeat && !['input', 'textarea', 'select'].includes(tag)) {
      setViewerSpacePan(true);
      e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') setViewerSpacePan(false);
  });
  window.addEventListener('blur', () => setViewerSpacePan(false));

  // src is a remote URL, or absent for embedded local files (served by the
  // board server at /img/b/<id>). Same sizing rule as diagrams: never upscale
  // past natural width; zoom/full-screen viewer attached once loaded.
  function renderImage(block, ctx, blockId) {
    const container = el('div', { class: 'blk-imagewrap' });
    const src = typeof block.src === 'string' && block.src
      ? block.src
      : '/img/b/' + encodeURIComponent(blockId);
    const img = el('img', {
      class: 'blk-img',
      src,
      alt: block.alt || 'image',
      loading: 'lazy',
      draggable: 'false',
      title: ctx.canComment === false ? '' : 'Drag to draw a comment area · Space-drag to pan',
    });
    img.addEventListener('dragstart', (e) => e.preventDefault());
    const stage = el('div', { class: 'blk-imgstage' }, img);
    // Inline default: the image fills its full width (container width, never
    // upscaled past natural) so it's readable without manual zoom; the CONTAINER
    // caps the height (default 800 via CSS, or block.height) and SCROLLS — we
    // never cap the image's own height, which would shrink its width. Full-screen
    // lifts the cap (the .blk-full rule).
    if (block.height != null) container.style.maxHeight = clampHeight(block.height, 800) + 'px';
    img.addEventListener('error', () => {
      container.replaceChildren(el('div', { class: 'blk-error' }, 'Image failed to load'));
    });
    container.append(stage);
    const region = ctx.annotate && ctx.canComment !== false
      ? enableImageRegions({
          host: stage,
          surface: img,
          panHost: container,
          sourceForSide: () => img,
          sideAtPoint: () => null,
          ctx,
          blockId,
          label: block.alt || 'Image',
        })
      : null;
    const attachImgViewer = () =>
      attachViewer(container, {
        zoomEl: stage,
        natural: () => (img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null),
        label: 'image',
        comment: wholeBlockComment(ctx, blockId, 'image'),
        region,
      });
    if (img.complete && img.naturalWidth > 0) attachImgViewer();
    else img.addEventListener('load', attachImgViewer, { once: true });
    if (ctx.annotate && block.pins === true) {
      enableImagePins(stage, img, ctx, blockId, block.alt || 'Image');
    } else if (ctx.annotate) {
      ctx.annotate.register(img, {
        blockId,
        questionId: ctx.questionId,
        target: { kind: 'image', label: block.alt || 'Image' },
      });
    }
    return container;
  }

  // Coordinate pin-comments on an image (block.pins): click any point to drop a
  // comment anchored to that (x,y) fraction; a numbered pin marks each one and
  // tracks the image as it scales/scrolls (positions are % of the displayed img,
  // so they ride zoom/full-screen/pan for free). Mirrors the chart-badge model.
  function enableImagePins(container, img, ctx, blockId, label) {
    const layer = el('div', { class: 'blk-imgpins' });
    container.append(layer);
    if (ctx.canComment !== false) img.classList.add('blk-img-pinnable');
    let down = null; // {x,y} at pointerdown — used to reject drags (pan) as clicks
    img.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    img.addEventListener('click', (e) => {
      if (ctx.canComment === false) return;
      if (img._rlySuppressPointClick) { img._rlySuppressPointClick = false; down = null; return; }
      if (down && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) { down = null; return; }
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      ctx.annotate.openExternal(
        { blockId, questionId: ctx.questionId, target: { kind: 'image-point', x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, label } },
        img
      );
    });
    const syncPins = () => {
      layer.replaceChildren();
      const groups = new Map(); // "x:y" -> {target, count}
      let n = 0;
      for (const a of ctx.annotate.list()) {
        if (a.blockId !== blockId) continue;
        const t = a.target || {};
        if (t.kind !== 'image-point') continue;
        const k = t.x + ':' + t.y;
        const g = groups.get(k) || { target: t, count: 0 };
        g.count++; groups.set(k, g);
      }
      for (const { target, count } of groups.values()) {
        n++;
        const pin = el('button', { class: 'blk-imgpin', type: 'button', title: count + (count === 1 ? ' comment' : ' comments') }, String(count));
        pin.style.left = (target.x * 100) + '%';
        pin.style.top = (target.y * 100) + '%';
        pin.addEventListener('mousedown', (e) => e.stopPropagation());
        pin.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          ctx.annotate.openExternal({ blockId, questionId: ctx.questionId, target }, pin);
        });
        layer.append(pin);
      }
    };
    if (ctx.annotate.onBadgeRefresh) ctx.annotate.onBadgeRefresh(syncPins);
    syncPins();
  }

  // Hold, then drag, to select a rectangular image area. A short move remains
  // native viewer pan / comparison-slider input; the hold threshold makes the
  // two gestures coexist without a mode switch. Region coordinates are stored
  // as normalized fractions, while a pixel crop is uploaded through the host
  // context so the result gives the agent an actual viewable image artifact.
  function enableImageRegions({ host, surface, panHost, sourceForSide, sideAtPoint, ctx, blockId, label }) {
    const layer = el('div', { class: 'blk-region-layer' });
    const selection = el('div', { class: 'blk-region-selection' });
    layer.append(selection);
    host.append(layer);
    panHost._rlyHasRegions = true;
    panHost.classList.add('blk-has-regions');
    let pending = null;
    let active = false;
    let status = null;
    let modeActive = false;
    const modeHooks = new Set();
    let controller = null;
    const MIN_REGION = 0.012;

    const localPoint = (e) => {
      const r = host.getBoundingClientRect();
      return {
        x: r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0,
        y: r.height ? Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) : 0,
      };
    };
    const clearStatus = () => { if (status) status.remove(); status = null; };
    const showStatus = (text) => {
      clearStatus();
      status = el('div', { class: 'blk-region-status', role: 'status' }, text);
      host.append(status);
    };
    const reset = () => {
      active = false;
      pending = null;
      panHost._rlyRegionSelecting = false;
      host.classList.remove('blk-region-arming', 'blk-region-selecting');
      selection.style.display = 'none';
      clearStatus();
    };
    const setModeActive = (next) => {
      const enabled = Boolean(next);
      if (enabled && activeRegionMode && activeRegionMode !== controller) {
        activeRegionMode.setModeActive(false);
      }
      if (!enabled && pending) reset();
      if (modeActive === enabled) return;
      modeActive = enabled;
      panHost._rlyRegionMode = enabled;
      host.classList.toggle('blk-region-mode', enabled);
      activeRegionMode = enabled ? controller : (activeRegionMode === controller ? null : activeRegionMode);
      for (const fn of modeHooks) { try { fn(enabled); } catch (_) {} }
    };
    controller = {
      setModeActive,
      isModeActive: () => modeActive,
      onModeChange: (fn) => {
        if (typeof fn === 'function') modeHooks.add(fn);
        return () => modeHooks.delete(fn);
      },
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modeActive) setModeActive(false);
    });
    const draw = (a, b) => {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
      selection.style.left = (x * 100) + '%';
      selection.style.top = (y * 100) + '%';
      selection.style.width = (w * 100) + '%';
      selection.style.height = (h * 100) + '%';
      return { x, y, w, h };
    };
    const createRegionZone = (target, count, provisional = false) => {
      const badge = el('span', { class: 'blk-imgregion-badge', 'aria-hidden': 'true' });
      badge.innerHTML = ICON_COMMENT;
      badge.append(el('span', { class: 'blk-imgregion-count' }, String(count)));
      const sideLabel = target.side ? target.side + ' ' : '';
      const region = el('button', {
        class: 'blk-imgregion' + (provisional ? ' blk-imgregion-provisional' : ''),
        type: 'button',
        title: provisional
          ? `Add a comment to this ${sideLabel}area`
          : `${target.side ? target.side + ' · ' : ''}${count} ${count === 1 ? 'comment' : 'comments'}`,
        'aria-label': provisional
          ? `New ${sideLabel}image area comment`
          : `${sideLabel}image area with ${count} ${count === 1 ? 'comment' : 'comments'}`,
      }, badge);
      region.style.left = (target.x * 100) + '%';
      region.style.top = (target.y * 100) + '%';
      region.style.width = (target.w * 100) + '%';
      region.style.height = (target.h * 100) + '%';
      region.addEventListener('pointerdown', (e) => e.stopPropagation());
      if (!provisional) {
        region.addEventListener('click', (e) => {
          e.stopPropagation();
          ctx.annotate.openExternal({ blockId, questionId: ctx.questionId, target }, region);
        });
      }
      return region;
    };
    const beginSelection = (pointerId) => {
      if (!pending || active) return;
      active = true;
      panHost._rlyRegionSelecting = true;
      host.classList.remove('blk-region-arming');
      host.classList.add('blk-region-selecting');
      selection.style.display = 'block';
      draw(pending.start, pending.start);
      showStatus((pending.side ? pending.side.charAt(0).toUpperCase() + pending.side.slice(1) + ' · ' : '') + 'drag to select an area');
      try { surface.setPointerCapture(pointerId); } catch (_) {}
    };

    async function cropRegion(img, region) {
      if (!img || !img.naturalWidth || !img.naturalHeight) throw new Error('image is not ready');
      const sx = Math.max(0, Math.floor(region.x * img.naturalWidth));
      const sy = Math.max(0, Math.floor(region.y * img.naturalHeight));
      const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(region.w * img.naturalWidth)));
      const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(region.h * img.naturalHeight)));
      const scale = Math.min(1, 1400 / sw, 1400 / sh);
      const width = Math.max(1, Math.round(sw * scale));
      const height = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('canvas unavailable');
      g.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/png');
      if (!/^data:image\/png;base64,/.test(dataUrl)) throw new Error('crop unavailable');
      if (ctx.saveArtifact) return ctx.saveArtifact({ dataUrl, mime: 'image/png', width, height, blockId });
      return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mime: 'image/png', width, height };
    }

    const finishRegion = async (region, side) => {
      const target = {
        kind: 'image-region',
        x: Math.round(region.x * 10000) / 10000,
        y: Math.round(region.y * 10000) / 10000,
        w: Math.round(region.w * 10000) / 10000,
        h: Math.round(region.h * 10000) / 10000,
        side: side || undefined,
        label,
      };
      const provisional = createRegionZone(target, 0, true);
      layer.append(provisional);
      showStatus('Saving selected area…');
      try {
        target.crop = await cropRegion(sourceForSide(side), region);
      } catch {
        target.cropUnavailable = true;
      }
      clearStatus();
      ctx.annotate.openExternal({
        blockId,
        questionId: ctx.questionId,
        target,
        onClose: () => provisional.remove(),
      }, provisional);
    };

    surface.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || viewerSpacePan || ctx.canComment === false) return;
      if (e.target.closest && e.target.closest('.cmp-handle, .blk-imgregion, .blk-tools')) return;
      if (modeActive) {
        e.preventDefault();
        e.stopPropagation();
      }
      const p = localPoint(e);
      pending = {
        start: p,
        last: p,
        clientX: e.clientX,
        clientY: e.clientY,
        pointerId: e.pointerId,
        explicitMode: modeActive,
        side: sideAtPoint(p.x),
      };
      host.classList.add('blk-region-arming');
      if (modeActive) beginSelection(e.pointerId);
    });
    surface.addEventListener('pointermove', (e) => {
      if (!pending) return;
      const moved = Math.hypot(e.clientX - pending.clientX, e.clientY - pending.clientY);
      if (!active && moved > 5) beginSelection(pending.pointerId);
      if (!active) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      pending.last = localPoint(e);
      draw(pending.start, pending.last);
    });
    const end = (e) => {
      if (!pending) return;
      if (!active) { reset(); return; }
      e.preventDefault();
      const region = draw(pending.start, pending.last || localPoint(e));
      const side = pending.side;
      const explicitMode = pending.explicitMode;
      surface._rlySuppressPointClick = true;
      reset();
      clearStatus();
      if (region.w >= MIN_REGION && region.h >= MIN_REGION) {
        if (explicitMode) setModeActive(false);
        finishRegion(region, side);
      } else if (explicitMode) {
        showStatus('Drag a larger area');
        setTimeout(clearStatus, 1200);
      }
    };
    surface.addEventListener('pointerup', end);
    // Some Chromium/CDP paths emit pointercancel immediately after granting
    // capture on the first dragged frame. Once area mode is active, keep the
    // last drawn rectangle instead of throwing the user's deliberate hold away.
    surface.addEventListener('pointercancel', (e) => active ? end(e) : reset());

    const syncRegions = () => {
      for (const node of Array.from(layer.querySelectorAll('.blk-imgregion:not(.blk-imgregion-provisional)'))) node.remove();
      const groups = new Map();
      for (const a of ctx.annotate.list()) {
        if (a.blockId !== blockId || !a.target || a.target.kind !== 'image-region') continue;
        const t = a.target;
        const key = [t.side || '', t.x, t.y, t.w, t.h].join(':');
        const group = groups.get(key) || { target: t, count: 0 };
        group.count++;
        groups.set(key, group);
      }
      for (const { target, count } of groups.values()) {
        layer.append(createRegionZone(target, count));
      }
    };
    if (ctx.annotate.onBadgeRefresh) ctx.annotate.onBadgeRefresh(syncRegions);
    syncRegions();
    return controller;
  }

