  // ---------- dispatch ----------
  function renderBlock(block, ctx) {
    const blockId = block.id;
    const wrapper = el('div', { class: 'blk blk-' + block.type, 'data-block-id': blockId });
    if (block.ref) wrapper.setAttribute('data-block-ref', block.ref);
    let inner = null;
    switch (block.type) {
      case 'markdown': {
        inner = renderMarkdown(block.md || '');
        wrapper.append(inner);
        ctx.annotate?.enableTextSelection(inner, { blockId, questionId: ctx.questionId });
        break;
      }
      case 'table':
        inner = renderTable(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'code':
        inner = renderCode(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'diff':
        inner = renderDiff(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'git-conflict':
        inner = renderGitConflict(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'video':
        inner = renderVideo(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'pdf':
        inner = renderPdf(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'chart':
        inner = renderChart(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'mermaid':
        inner = renderMermaid(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'graphviz':
        inner = renderGraphviz(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'plantuml':
        inner = renderPlantuml(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'html':
        inner = renderHtml(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'image':
        inner = renderImage(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'palette':
        inner = renderPalette(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'kpi':
        inner = renderKpi(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'typography':
        inner = renderTypography(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'compare':
        inner = renderCompare(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'a2ui':
        inner = window.RelayA2ui ? window.RelayA2ui.render(block, ctx, blockId) : el('div', { class: 'blk-error' }, 'A2UI renderer is not loaded.');
        wrapper.append(inner);
        break;
      default:
        wrapper.append(el('div', { class: 'blk-error' }, 'Unknown block type: ' + esc(String(block.type))));
    }
    return wrapper;
  }

  // ---------- public API ----------
  async function render(container, blocks, ctx) {
    const list = Array.isArray(blocks) ? blocks : [];
    const safeCtx = {
      theme: ctx && ctx.theme ? ctx.theme : () => 'light',
      htmlSrc: ctx && ctx.htmlSrc ? ctx.htmlSrc : (id) => '/html/b/' + id,
      questionId: ctx && ctx.questionId !== undefined ? ctx.questionId : null,
      annotate: ctx && ctx.annotate ? ctx.annotate : null,
      // editable-mermaid plumbing: edits maps blockId -> edited code; onBlockEdit
      // reports an accepted change (or null to clear back to the original).
      edits: ctx && ctx.edits ? ctx.edits : {},
      canComment: !ctx || ctx.canComment !== false,
      saveArtifact:
        ctx && typeof ctx.saveArtifact === 'function' ? ctx.saveArtifact : null,
      canEditBlocks: !ctx || ctx.canEditBlocks !== false,
      onBlockEdit:
        ctx && typeof ctx.onBlockEdit === 'function' ? ctx.onBlockEdit : () => {},
    };
    for (const block of list) {
      if (!block || !block.type) continue;
      container.append(renderBlock(block, safeCtx));
    }
  }

