  // ---------- kpi (stat cards) ----------
  function renderKpi(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-kpi' });
    if (block.title) wrap.append(el('div', { class: 'kpi-title' }, block.title));
    const grid = el('div', { class: 'kpi-grid' });
    for (const it of block.items || []) {
      const card = el('div', { class: 'kpi-card' });
      if (it.label) card.append(el('div', { class: 'kpi-label' }, it.label));
      card.append(el('div', { class: 'kpi-value' }, it.value || ''));
      if (it.delta) {
        const glyph = it.dir === 'up' ? '▲ ' : it.dir === 'down' ? '▼ ' : it.dir === 'flat' ? '▬ ' : '';
        card.append(el('div', { class: 'kpi-delta' + (it.dir ? ' kpi-' + it.dir : '') }, glyph + it.delta));
      }
      if (it.sub) card.append(el('div', { class: 'kpi-sub' }, it.sub));
      if (ctx.annotate) {
        ctx.annotate.register(card, {
          blockId, questionId: ctx.questionId,
          target: { kind: 'html-element', label: ((it.label ? it.label + ' · ' : '') + (it.value || 'KPI')) },
        });
      }
      grid.append(card);
    }
    wrap.append(grid);
    return wrap;
  }

