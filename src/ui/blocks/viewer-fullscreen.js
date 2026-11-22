  // ---------- viewer controls (zoom / fit / full-screen) ----------
  // Large diagrams get squeezed to the column width; these controls let the
  // user zoom (buttons or cmd/ctrl+wheel) and expand any visual block into a
  // full-screen overlay. An overlay — NOT the native Fullscreen API — keeps
  // the annotation pins/badges/popover usable while expanded (they live on
  // <body>, which native fullscreen would hide).
  let fullOpen = null; // container currently expanded
  // full-screen content insets — must mirror the .blk-full padding in blocks.css
  // so the fit-to-screen scale clears the fixed toolbar + leaves a small margin.
  const FULL_PAD_X = 24, FULL_PAD_TOP = 44, FULL_PAD_BOTTOM = 24;
  // Wheel/pinch zoom is delta-proportional and animated. The old fixed 15% jump
  // ran once for every wheel event, so a high-frequency trackpad gesture could
  // compound to several hundred percent almost instantly. Cap the contribution
  // of one event (mouse wheels often report ±100px) and ease toward the gesture's
  // accumulated target at most once per animation frame.
  const WHEEL_ZOOM_SENSITIVITY = 0.003;
  const WHEEL_ZOOM_MAX_DELTA = 20;
  const WHEEL_ZOOM_EASE = 0.24;
  const WHEEL_ZOOM_EPSILON = 0.001;

  // Toolbar icons: full-screen (4-corner expand) and a speech-bubble for the
  // "comment on the whole block" button. Zoom is both cmd/ctrl+wheel AND
  // explicit −/+ buttons (the % doubles as a reset-to-fit button).
  const ICON_EXPAND =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 9V3h6M10 10 3 3M15 3h6v6M14 10l7-7M9 21H3v-6M10 14l-7 7M21 15v6h-6M14 14l7 7"/></svg>';
  const ICON_COMMENT =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>';
  const ICON_REGION =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="14" height="12" rx="2" stroke-dasharray="3 2"/>' +
    '<path d="M14 14.5h6.5v4H18l-2.5 2v-2H14z" fill="currentColor" stroke="none"/></svg>';
  const ICON_EYE =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';

  function exitFull() {
    if (!fullOpen) return;
    const c = fullOpen;
    if (c._rlyStopWheelZoom) c._rlyStopWheelZoom();
    c.classList.remove('blk-full');
    document.body.classList.remove('blk-full-open');
    const btn = c.querySelector('.blk-tools .tool-full');
    if (btn) btn.innerHTML = ICON_EXPAND;
    fullOpen = null;
    window.dispatchEvent(new Event('resize'));
    if (c._rlyZoom) c._rlyZoom.reapply(); // restore the compact inline height cap
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fullOpen && !document.querySelector('.rly-file-dialog[open]')) exitFull();
  });

  // Enter full-screen for a viewer container (shared by the toolbar button and
  // the markdown reference-link → modal path).
  function enterFull(container) {
    if (fullOpen === container) return;
    exitFull();
    if (container._rlyStopWheelZoom) container._rlyStopWheelZoom();
    container.classList.add('blk-full');
    document.body.classList.add('blk-full-open');
    fullOpen = container;
    const btn = container.querySelector('.blk-tools .tool-full');
    if (btn) btn.textContent = '✕';
    window.dispatchEvent(new Event('resize'));
    if (container._rlyZoom) container._rlyZoom.reapply();
  }

  // CSS.escape fallback for attribute-selector building from a block id/ref.
  function cssEsc(s) {
    return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\\]]/g, '\\$&');
  }

  // Open a block as a modal: full-screen its viewer if it has one (chart, image,
  // diagram, table, compare, code…); otherwise scroll to it and flash. `host` is
  // the .blk[data-block-id] wrapper. Returns true if it found something to show.
  function openFullEl(host) {
    if (!host) return false;
    const viewer = host.classList.contains('blk-viewer') ? host : host.querySelector('.blk-viewer');
    // Visuals open as a full-screen modal — context-safe (an overlay; × returns
    // to the exact spot). Non-modal blocks (kpi/markdown/table-less) have no
    // viewer, so we jump + highlight AND show a "↩ Back" button so the user can
    // return after the jump — no lost context across the data↔question distance.
    if (viewer && viewer._rlyTools) { enterFull(viewer); return true; }
    const fromY = window.scrollY || window.pageYOffset || 0;
    host.scrollIntoView({ behavior: 'smooth', block: 'center' });
    host.classList.remove('rly-refflash');
    void host.offsetWidth;
    host.classList.add('rly-refflash');
    setTimeout(() => host.classList.remove('rly-refflash'), 1200);
    showRefBack(fromY);
    return true;
  }

  // A floating "↩ Back" pill that returns to the pre-jump scroll position. Self-
  // removes once the user is back near where they started, or after a timeout.
  let refBackBtn = null;
  function showRefBack(fromY) {
    if (refBackBtn) refBackBtn.remove();
    const btn = el('button', { class: 'rly-refback', type: 'button', title: 'Back to where you were' }, '↩ Back');
    const cleanup = () => { btn.remove(); window.removeEventListener('scroll', onScroll); if (refBackBtn === btn) refBackBtn = null; };
    const onScroll = () => { if (Math.abs((window.scrollY || 0) - fromY) < 120) cleanup(); };
    btn.addEventListener('click', () => { window.scrollTo({ top: fromY, behavior: 'smooth' }); cleanup(); });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.body.append(btn);
    refBackBtn = btn;
    setTimeout(() => { if (refBackBtn === btn) cleanup(); }, 12000);
  }
  function openFull(blockId) {
    return openFullEl(document.querySelector('[data-block-id="' + cssEsc(blockId) + '"]'));
  }

  // Delegated handler for markdown reference links (data-rly-ref / data-rly-refid).
  function initRefLinks() {
    if (window.__relayRefLinksReady) return;
    window.__relayRefLinksReady = true;
    const open = (a) => {
      const host = a.dataset.rlyRefid
        ? document.querySelector('[data-block-id="' + cssEsc(a.dataset.rlyRefid) + '"]')
        : document.querySelector('[data-block-ref="' + cssEsc(a.dataset.rlyRef) + '"]');
      if (host) openFullEl(host);
      else fileToast('Referenced visual not found on this board', 'err');
    };
    document.addEventListener('click', (e) => {
      const a = e.target.closest ? e.target.closest('a.rly-reflink') : null;
      if (!a) return;
      e.preventDefault();
      open(a);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const a = e.target.closest ? e.target.closest('a.rly-reflink') : null;
      if (!a) return;
      e.preventDefault();
      open(a);
    });
  }

  // Drag-to-pan: grab anywhere on a scrollable visual (a tall/zoomed diagram or
  // oversized image) and drag to move across it, instead of hunting for the
  // scrollbars. Self-gates on overflow, so charts and html iframes — which are
  // always sized to fit — never engage. Annotation on diagrams/images is
  // hover-pin based (not a node click), so a pan can't create a stray
  // annotation; a real drag still swallows the trailing click as a guard.
  // Returns a refresh() the viewer calls whenever content size changes (zoom,
  // full-screen, re-render) so the grab affordance tracks pannability.
