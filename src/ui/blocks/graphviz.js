  // ---------- graphviz (offline, vendored Viz.js -> SVG) ----------
  // Same sizing rule as mermaid: never upscale past the diagram's natural
  // width; shrink on narrow screens. Authors set their own colors so there is
  // no theme re-render.
  function sizeDiagramSvg(svgEl) {
    if (!svgEl) return;
    svgEl.removeAttribute('height');
    svgEl.removeAttribute('width');
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    if (vb && vb.width > 0) {
      svgEl.style.width = '100%';
      svgEl.style.maxWidth = Math.ceil(vb.width) + 'px';
      svgEl.style.height = 'auto';
    } else {
      svgEl.style.maxWidth = '100%';
    }
  }

  function renderGraphviz(block, ctx, blockId) {
    const container = el('div', { class: 'blk-graphviz' });
    // honor authored height as the scrollable viewport (see renderMermaid)
    if (block.height != null) container.style.maxHeight = clampHeight(block.height, 1200) + 'px';
    loadViz()
      .then((Viz) => Viz.instance())
      .then((viz) => {
        const svgEl = viz.renderSVGElement(block.dot || '');
        sizeDiagramSvg(svgEl);
        container.replaceChildren(svgEl);
        attachViewer(container, { zoomEl: svgEl, natural: svgNatural(svgEl), label: 'graph', comment: wholeBlockComment(ctx, blockId, 'graph') });
        if (!ctx.annotate) return;
        const parts = svgEl.querySelectorAll('g.node, g.edge');
        parts.forEach((g) => {
          const titleEl = g.querySelector('title');
          const nodeId = (g.id || (titleEl && titleEl.textContent) || '').trim();
          // Label text lives in <text> elements; g.textContent would also
          // include the <title> child and duplicate the label.
          const labels = Array.from(g.querySelectorAll('text')).map((t) => t.textContent.trim()).filter(Boolean);
          const text = (labels.join(' ') || (titleEl && titleEl.textContent) || '').trim().slice(0, 120);
          ctx.annotate.register(g, {
            blockId,
            questionId: ctx.questionId,
            target: {
              kind: 'graphviz-node',
              nodeId,
              text,
            },
          });
        });
      })
      .catch((err) => {
        container.replaceChildren(
          el('div', { class: 'blk-error' }, 'Graphviz error: ' + (err && err.message ? err.message : String(err)))
        );
      });
    return container;
  }

