  function enablePan(scrollEl) {
    let pending = false, active = false;
    let sx = 0, sy = 0, sl = 0, st = 0, pid = null;
    const THRESH = 4; // px before a press becomes a drag (keeps clicks clickable)

    const pannable = () =>
      scrollEl.scrollWidth - scrollEl.clientWidth > 1 ||
      scrollEl.scrollHeight - scrollEl.clientHeight > 1;
    const refresh = () => scrollEl.classList.toggle('blk-pannable', pannable());

    scrollEl.addEventListener('pointerdown', (e) => {
      const panGesture = e.button === 1 || (e.button === 0 && (!scrollEl._rlyHasRegions || viewerSpacePan));
      if (!panGesture || scrollEl._rlyRegionMode || !pannable()) return;
      // leave the toolbar, the diagram editor, and real controls interactive
      if (e.target.closest && e.target.closest('.blk-tools, .blk-editor, button, a, input, textarea, select')) return;
      pending = true; active = false;
      sx = e.clientX; sy = e.clientY;
      sl = scrollEl.scrollLeft; st = scrollEl.scrollTop;
      pid = e.pointerId;
    });
    scrollEl.addEventListener('pointermove', (e) => {
      if (!pending) return;
      if (scrollEl._rlyRegionMode || scrollEl._rlyRegionSelecting) { pending = false; active = false; return; }
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!active) {
        if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return;
        active = true;
        scrollEl.classList.add('blk-panning');
        try { scrollEl.setPointerCapture(pid); } catch (_) {}
      }
      e.preventDefault();
      scrollEl.scrollLeft = sl - dx;
      scrollEl.scrollTop = st - dy;
    });
    const end = () => {
      if (active) {
        scrollEl.classList.remove('blk-panning');
        try { scrollEl.releasePointerCapture(pid); } catch (_) {}
        // a drag ends in a click on whatever was under the release — swallow it
        // once so it can't trigger anything the user didn't mean to click
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        scrollEl.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => scrollEl.removeEventListener('click', swallow, true), 0);
      }
      pending = false; active = false; pid = null;
    };
    scrollEl.addEventListener('pointerup', end);
    scrollEl.addEventListener('pointercancel', end);
    window.addEventListener('resize', refresh);
    return refresh;
  }

  // Build the onComment thunk for attachViewer: opens the annotation popover
  // with a block-scoped target ("Whole chart/diagram/…") so a user can comment
  // on the visual as a whole. null when annotation is off (omits the button).
  function wholeBlockComment(ctx, blockId, label) {
    if (!ctx || !ctx.annotate || ctx.canComment === false) return null;
    const a = ctx.annotate;
    return {
      open: (anchorEl) =>
        a.openExternal({ blockId, questionId: ctx.questionId, target: { kind: 'block', label } }, anchorEl),
      // true once this block carries a whole-block comment
      active: () => a.list().some((x) => x.blockId === blockId && x.target && x.target.kind === 'block'),
      // fires on any annotation change; returns an unsubscribe
      subscribe: (fn) => (a.onBadgeRefresh ? a.onBadgeRefresh(fn) : () => {}),
    };
  }

  // opts: { zoomEl, natural, comment, label } — zoomEl null means no pixel
  // zoom (charts/html/code: full-screen + comment only, no zoom buttons).
  // comment (optional) = { open(anchor), active(), subscribe(fn) } wiring the
  // "comment on the whole block" button + its already-commented style.
  function attachViewer(container, opts) {
    if (container._rlyRegionHook) {
      try { container._rlyRegionHook(); } catch (_) {}
      container._rlyRegionHook = null;
    }
    if (container._rlyTools) container._rlyTools.remove();
    container.classList.add('blk-viewer');
    const zoomable = Boolean(opts && opts.zoomEl);
    const label = (opts && opts.label) || 'visual';

    // pan listeners bind once per container; mermaid re-renders re-call
    // attachViewer, so reuse the existing refresh() instead of re-binding
    if (!container._rlyPan) container._rlyPan = enablePan(container);
    const refreshPan = container._rlyPan;

    // zoom level persists across re-renders; the wheel handler (bound once)
    // delegates through container._rlyZoom so it never holds a stale zoomEl
    if (container._rlyZ === undefined) container._rlyZ = null; // null = fit-to-width
    // Fluid visuals (currently Chart.js) fit the live container width. Capture
    // that rendered size only when leaving fit mode so zoom remains proportional
    // without freezing later fit-mode viewport growth to an old width.
    let fluidZoomNatural = null;
    const pct = el('span', { class: 'tool-pct' }, 'fit');
    function apply() {
      if (!zoomable) return;
      const target = opts.zoomEl;
      const nat = opts.natural();
      const z = container._rlyZ;
      const full = container.classList.contains('blk-full');
      // A per-block height caps only the compact inline preview. The moment the
      // user zooms in (z !== null) or goes full-screen they want pixel detail, so
      // lift the cap there; restore it when back to the inline fit view.
      if (opts.fitMaxHeight != null) {
        target.style.maxHeight = z === null && !full ? opts.fitMaxHeight + 'px' : 'none';
      }
      if (z === null && full && nat && nat.w && nat.h) {
        // Full-screen default: scale the diagram/image to fill the viewport
        // (contain — enlarge a small one, shrink a big one) so it's readable at
        // a glance without reaching for the zoom buttons. CSS margin:auto centers
        // it; it stays pannable once the user zooms past this fit.
        // subtract the docked comment rail (≥980px) so the fit doesn't run under it
        const railInset = (document.body.classList.contains('ann-rail-open') && window.innerWidth >= 980) ? 340 : 0;
        const availW = window.innerWidth - railInset - FULL_PAD_X * 2;
        const availH = window.innerHeight - FULL_PAD_TOP - FULL_PAD_BOTTOM;
        const scale = Math.min(availW / nat.w, availH / nat.h);
        target.style.maxWidth = 'none';
        target.style.width = Math.max(1, Math.round(nat.w * scale)) + 'px';
        target.style.height = opts.scaleHeight ? Math.max(1, Math.round(nat.h * scale)) + 'px' : 'auto';
        pct.textContent = 'fit';
      } else if (z === null || !nat || !nat.w) {
        target.style.width = '100%';
        target.style.maxWidth = opts.fluidFit ? '100%' : (nat && nat.w ? Math.ceil(nat.w) + 'px' : '100%');
        target.style.height = opts.scaleHeight ? '100%' : 'auto';
        pct.textContent = 'fit';
      } else {
        const zoomNat = fluidZoomNatural || nat;
        target.style.maxWidth = 'none';
        target.style.width = Math.round(zoomNat.w * z) + 'px';
        target.style.height = opts.scaleHeight && zoomNat && zoomNat.h ? Math.round(zoomNat.h * z) + 'px' : 'auto';
        pct.textContent = Math.round(z * 100) + '%';
      }
      window.dispatchEvent(new Event('resize')); // annotation badges reposition
      refreshPan();                              // content size → grab affordance
    }
    function currentZ() {
      if (container._rlyZ !== null) return container._rlyZ;
      if (opts.fluidFit) return 1;
      const nat = opts.natural();
      if (!nat || !nat.w) return 1;
      const shown = opts.zoomEl.getBoundingClientRect().width;
      return shown > 0 ? shown / nat.w : 1;
    }
    function setZoom(next) {
      if (next === null) {
        fluidZoomNatural = null;
      } else if (opts.fluidFit && container._rlyZ === null) {
        const shown = opts.zoomEl.getBoundingClientRect();
        fluidZoomNatural = {
          w: Math.max(1, shown.width),
          h: Math.max(1, shown.height),
        };
      }
      container._rlyZ = next === null ? null : Math.min(8, Math.max(0.2, next));
      apply();
    }
    container._rlyZoom = { setZoom, currentZ, reapply: apply };

    // Stop any in-flight wheel easing before an explicit toolbar/full-screen
    // action. This prevents an older gesture target from overriding that action
    // on the next animation frame.
    if (!container._rlyStopWheelZoom) {
      container._rlyStopWheelZoom = () => {
        if (container._rlyWheelFrame) cancelAnimationFrame(container._rlyWheelFrame);
        container._rlyWheelFrame = null;
        container._rlyWheelTarget = null;
      };
    }

    const tools = el('div', { class: 'blk-tools' });

    // comment on the whole block (leftmost) — opens the annotation popover with
    // a block-scoped target so a user can comment without picking an element.
    // The button gains a .has-comment style once the block carries one, kept in
    // sync via the annotate badge-refresh subscription (bound once per container).
    if (opts && opts.comment) {
      const cmt = opts.comment;
      const cBtn = el('button', { class: 'tool-comment', type: 'button', title: 'Comment on this whole ' + label });
      cBtn.innerHTML = ICON_COMMENT;
      cBtn.addEventListener('click', (e) => { e.stopPropagation(); cmt.open(container); });
      tools.append(cBtn);
      container._rlyCmtSync = () => {
        const b = container._rlyTools && container._rlyTools.querySelector('.tool-comment');
        if (b && cmt.active) b.classList.toggle('has-comment', !!cmt.active());
      };
      if (!container._rlyCmtHook && cmt.subscribe) {
        container._rlyCmtHook = cmt.subscribe(() => container._rlyCmtSync && container._rlyCmtSync());
      }
    }

    if (opts && opts.comment && opts.hoverComments) {
      const hoverCtl = opts.hoverComments;
      const hoverBtn = el('button', {
        class: 'tool-hover-comments',
        type: 'button',
        'aria-label': 'Show element comment overlays',
      });
      hoverBtn.innerHTML = ICON_EYE;
      hoverBtn.append(el('span', { class: 'tool-hover-label' }, 'Hover comments'));
      const syncHoverMode = () => {
        const enabled = hoverCtl.isEnabled();
        hoverBtn.classList.toggle('is-active', enabled);
        hoverBtn.setAttribute('aria-pressed', String(enabled));
        hoverBtn.title = enabled ? 'Hide element comment overlays' : 'Show element comment overlays';
      };
      hoverBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hoverCtl.setEnabled(!hoverCtl.isEnabled());
        syncHoverMode();
      });
      syncHoverMode();
      tools.append(hoverBtn);
    }

    if (opts && opts.region) {
      const regionCtl = opts.region;
      const regionLabel = el('span', { class: 'tool-region-label' }, 'Area');
      const regionBtn = el('button', {
        class: 'tool-region',
        type: 'button',
        title: 'Draw an area comment',
        'aria-label': 'Draw an area comment',
        'aria-pressed': 'false',
      });
      regionBtn.innerHTML = ICON_REGION;
      regionBtn.append(regionLabel);
      const syncRegionMode = (enabled) => {
        regionBtn.classList.toggle('is-active', enabled);
        regionBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        regionBtn.title = enabled ? 'Cancel area comment' : 'Draw an area comment';
        regionBtn.setAttribute('aria-label', regionBtn.title);
        regionLabel.textContent = enabled ? 'Drawing' : 'Area';
      };
      regionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        regionCtl.setModeActive(!regionCtl.isModeActive());
      });
      container._rlyRegionHook = regionCtl.onModeChange(syncRegionMode);
      syncRegionMode(regionCtl.isModeActive());
      tools.append(regionBtn);
    }

    if (zoomable) {
      // cmd/ctrl+wheel zoom, bound ONCE (re-binding per render would stack);
      // delegates to the current controller so it never uses a stale zoomEl
      if (!container._rlyWheel) {
        const onWheel = (e) => {
          if (!(e.ctrlKey || e.metaKey) || !container._rlyZoom) return;
          e.preventDefault();
          // Normalize line/page-mode devices to pixel-like units, then cap a
          // single event. Exponential scaling makes equal motion reversible and
          // lets tiny trackpad deltas stay tiny instead of becoming fixed jumps.
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
          const delta = Math.max(-WHEEL_ZOOM_MAX_DELTA, Math.min(WHEEL_ZOOM_MAX_DELTA, e.deltaY * unit));
          const base = Number.isFinite(container._rlyWheelTarget)
            ? container._rlyWheelTarget
            : container._rlyZoom.currentZ();
          container._rlyWheelTarget = Math.min(8, Math.max(0.2, base * Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY)));

          // Respect reduced-motion while retaining the gentler delta-based step.
          if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            container._rlyZoom.setZoom(container._rlyWheelTarget);
            container._rlyWheelTarget = null;
            return;
          }
          if (container._rlyWheelFrame) return; // coalesce bursty input to one rAF loop
          const tick = () => {
            const zoom = container._rlyZoom;
            const target = container._rlyWheelTarget;
            if (!zoom || !Number.isFinite(target)) {
              container._rlyWheelFrame = null;
              return;
            }
            const current = zoom.currentZ();
            const gap = target - current;
            if (Math.abs(gap) <= WHEEL_ZOOM_EPSILON) {
              zoom.setZoom(target);
              container._rlyWheelFrame = null;
              container._rlyWheelTarget = null;
              return;
            }
            zoom.setZoom(current + gap * WHEEL_ZOOM_EASE);
            container._rlyWheelFrame = requestAnimationFrame(tick);
          };
          container._rlyWheelFrame = requestAnimationFrame(tick);
        };
        container.addEventListener('wheel', onWheel, { passive: false });
        container._rlyWheel = onWheel;
      }
      const zoomOut = el('button', { class: 'tool-zoom', type: 'button', title: 'Zoom out' }, '−');
      const zoomIn = el('button', { class: 'tool-zoom', type: 'button', title: 'Zoom in' }, '+');
      zoomOut.addEventListener('click', (e) => { e.stopPropagation(); container._rlyStopWheelZoom(); setZoom(currentZ() / 1.2); });
      zoomIn.addEventListener('click', (e) => { e.stopPropagation(); container._rlyStopWheelZoom(); setZoom(currentZ() * 1.2); });
      pct.classList.add('is-btn');
      pct.title = 'Reset to fit';
      pct.addEventListener('click', (e) => { e.stopPropagation(); container._rlyStopWheelZoom(); setZoom(null); });
      tools.append(zoomOut, pct, zoomIn);
    }

    const fullBtn = el('button', { class: 'tool-full', type: 'button', title: 'Full screen (Esc closes; ⌘/Ctrl+wheel zooms)' });
    fullBtn.innerHTML = ICON_EXPAND;
    fullBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fullOpen === container) exitFull();
      else enterFull(container);
    });
    tools.append(fullBtn);

    container.prepend(tools);
    container._rlyTools = tools;
    if (zoomable) apply();
    // non-zoomable diagrams (tall mermaid, oversized image) can still overflow
    refreshPan();
    if (container._rlyCmtSync) container._rlyCmtSync(); // reflect existing comment
  }

  function svgNatural(svgEl) {
    return () => {
      const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
      return vb && vb.width > 0 ? { w: vb.width, h: vb.height } : null;
    };
  }

