  // ---------- mermaid ----------
  let mermaidSeq = 0;
  // Registries so a live theme toggle can re-render diagrams and restyle
  // charts without a page reload.
  const mermaidRegistry = [];
  const chartRegistry = [];

  // Effective code = the user's edit if present, else the authored block.code.
  // Used by the initial render, the editor's live preview, and the theme
  // re-render registry path so an edit survives a theme toggle.
  function effectiveMermaidCode(entry) {
    const { block, ctx, blockId } = entry;
    const edited = ctx.edits ? ctx.edits[blockId] : undefined;
    if (edited !== undefined && edited !== null) return edited;
    // The live editor keeps entry.code as the source of truth; if the host's
    // ctx.edits hasn't been updated yet but the user has diverged from the
    // original, preserve that divergence (don't snap back to block.code).
    if (entry.code !== undefined && entry.code !== (block.code || '')) return entry.code;
    return block.code || '';
  }

  function renderMermaid(block, ctx, blockId) {
    const container = el('div', { class: 'blk-mermaid' });
    // Honor an authored height as the scrollable viewport: a diagram taller than
    // this overflows and becomes drag-pannable in place (was silently ignored —
    // diagrams only ever fit-to-width). No height keeps the 1200px CSS cap.
    if (block.height != null) container.style.maxHeight = clampHeight(block.height, 1200) + 'px';
    const entry = { container, block, ctx, blockId };
    entry.code = effectiveMermaidCode(entry);
    mermaidRegistry.push(entry);

    if (!block.editable || ctx.canEditBlocks === false) {
      drawMermaid(entry);
      return container;
    }

    // Editable: wrap the diagram + an editor below it. The wrapper is what the
    // dispatcher appends; the registry still tracks `container` (the diagram).
    const wrap = el('div', { class: 'blk-mermaid-wrap' });
    wrap.append(container);
    wrap.append(buildMermaidEditor(entry));
    drawMermaid(entry);
    return wrap;
  }

  // Editor: toggle button + collapsible panel (textarea + Reset + status line).
  // Live re-render is debounced 600ms; errors show inline WITHOUT destroying the
  // last good diagram. Each accepted change calls ctx.onBlockEdit(blockId, code)
  // (null when the value matches the original block.code again).
  function buildMermaidEditor(entry) {
    const { block, ctx, blockId, container } = entry;
    const original = block.code || '';

    const toggleBtn = el('button', { type: 'button', class: 'blk-edit-btn' }, 'Edit diagram');
    const panel = el('div', { class: 'blk-editor', hidden: '' });

    const ta = el('textarea', { class: 'blk-editor-ta', spellcheck: 'false' });
    ta.value = entry.code;

    const status = el('div', { class: 'blk-editor-status' }, '');
    const resetBtn = el('button', { type: 'button', class: 'blk-editor-reset' }, 'Reset');
    const row = el('div', { class: 'blk-editor-row' }, resetBtn, status);
    panel.append(ta, row);

    let open = false;
    toggleBtn.addEventListener('click', () => {
      open = !open;
      panel.hidden = !open;
      toggleBtn.classList.toggle('is-open', open);
      if (open) ta.focus();
    });

    let timer = null;
    function reportEdit(code) {
      // Only report a real divergence; equal-to-original clears the edit (null).
      try {
        if (code === original) ctx.onBlockEdit(blockId, null);
        else ctx.onBlockEdit(blockId, code);
      } catch {
        // host callback failures must not break editing
      }
    }

    // Try to render `code`; on success swap the diagram + re-register annotation
    // targets (via drawMermaid) and report the edit; on failure keep the last
    // good diagram and show the error inline.
    function applyCode(code) {
      previewMermaid(entry, code)
        .then(() => {
          status.textContent = '';
          status.classList.remove('has-error');
          entry.code = code;
          reportEdit(code);
        })
        .catch((err) => {
          status.textContent = 'diagram error: ' + (err && err.message ? err.message : String(err));
          status.classList.add('has-error');
        });
    }

    ta.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      const code = ta.value;
      timer = setTimeout(() => applyCode(code), 600);
    });

    resetBtn.addEventListener('click', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      ta.value = original;
      applyCode(original);
    });

    return el('div', { class: 'blk-mermaid-edit' }, toggleBtn, panel);
  }

  // Render `code` for the editor preview WITHOUT mutating entry.code on failure.
  // Resolves once the diagram is swapped into the container (annotation targets
  // re-registered by drawMermaid); rejects with the render error so the caller
  // can show it inline and keep the last good diagram.
  function previewMermaid(entry, code) {
    const prev = entry.code;
    entry.code = code;
    return new Promise((resolve, reject) => {
      drawMermaid(entry, { onDone: resolve, onError: reject });
    }).catch((err) => {
      entry.code = prev;
      throw err;
    });
  }

  function drawMermaid(entry, hooks) {
    const { container, ctx, blockId } = entry;
    const onError = hooks && hooks.onError ? hooks.onError : null;
    const onDone = hooks && hooks.onDone ? hooks.onDone : null;
    const fail = (err) => {
      if (onError) onError(err);
      else showMermaidErr(container, err);
    };
    loadMermaid().then((mermaid) => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: ctx.theme() === 'dark' ? 'dark' : 'neutral',
          securityLevel: 'strict',
        });
      } catch {
        // ignore re-init issues
      }
      const id = 'rly-mmd-' + (++mermaidSeq);
      const code = entry.code !== undefined ? entry.code : effectiveMermaidCode(entry);
      const onSvg = (svg) => {
        container.innerHTML = svg;
        const svgEl = container.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('height');
          svgEl.removeAttribute('width');
          const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
          if (vb && vb.width > 0) {
            // never upscale past the diagram's natural size; still shrink on
            // narrow screens (a 112px-wide graph must not stretch to 820px)
            svgEl.style.width = '100%';
            svgEl.style.maxWidth = Math.ceil(vb.width) + 'px';
            svgEl.style.height = 'auto';
          } else {
            svgEl.style.maxWidth = '100%';
          }
        }
        if (ctx.annotate) {
          const nodes = container.querySelectorAll('.node, .edgeLabel');
          nodes.forEach((g) => {
            ctx.annotate.register(g, {
              blockId,
              questionId: ctx.questionId,
              target: {
                kind: 'mermaid-node',
                nodeId: g.id || '',
                text: (g.textContent || '').trim().slice(0, 120),
              },
            });
          });
        }
        // re-attach per render: innerHTML replacement above wiped the old bar
        if (svgEl) attachViewer(container, { zoomEl: svgEl, natural: svgNatural(svgEl), label: 'diagram', comment: wholeBlockComment(ctx, blockId, 'diagram') });
        if (onDone) onDone();
      };
      try {
        const ret = mermaid.render(id, code);
        if (ret && typeof ret.then === 'function') {
          ret.then((r) => onSvg(r.svg)).catch((err) => fail(err));
        } else if (ret && ret.svg) {
          onSvg(ret.svg);
        } else if (typeof ret === 'string') {
          onSvg(ret);
        } else {
          // legacy callback signature: render(id, code, cb)
          mermaid.render(id, code, (svg) => onSvg(svg));
        }
      } catch (err) {
        fail(err);
      }
    }).catch((err) => fail(err));
  }

  // Live theme toggle: re-render mermaid diagrams with the new mermaid theme
  // and restyle existing charts' grid/tick/legend colors in place.
  function onThemeChange() {
    for (const entry of mermaidRegistry) {
      try {
        // re-render with the effective code so an edit survives the toggle
        entry.code = effectiveMermaidCode(entry);
        drawMermaid(entry);
      } catch {
        // keep the previous svg on failure
      }
    }
    const { grid, tick } = themeDefaults();
    for (const { chart } of chartRegistry) {
      try {
        const o = chart.options || {};
        if (o.plugins && o.plugins.legend && o.plugins.legend.labels) o.plugins.legend.labels.color = tick;
        if (o.plugins && o.plugins.title) o.plugins.title.color = tick;
        if (o.scales) {
          for (const k of Object.keys(o.scales)) {
            const ax = o.scales[k];
            if (!ax) continue;
            if (ax.grid) ax.grid.color = grid;
            if (ax.ticks) ax.ticks.color = tick;
          }
        }
        chart.update('none');
      } catch {
        // chart may already be destroyed
      }
    }
  }

  function showMermaidErr(container, err) {
    container.replaceChildren(
      el('div', { class: 'blk-error' }, 'Diagram error: ' + (err && err.message ? err.message : String(err)))
    );
  }

