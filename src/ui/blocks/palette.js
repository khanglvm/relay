  // ---------- palette ----------
  // Color palettes as swatch cards: hover a swatch to reveal its hex, click to
  // copy it. One palette may be {featured:true} → a larger spotlight row. Lets
  // an agent present a curated palette with one structured block instead of
  // hand-writing HTML. Swatches and the whole block are commentable.
  function copyColor(text, btn) {
    const done = () => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 900);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {});
        return;
      }
    } catch { /* fall through */ }
    done(); // no clipboard (sandbox) — still flash feedback
  }

  function paletteCard(p, big, ctx, blockId) {
    const card = el('div', { class: 'pal-card' + (big ? ' pal-spotlight' : '') });
    const row = el('div', { class: 'pal-swatches' });
    for (const c of p.colors) {
      const sw = el('button', { class: 'pal-sw', type: 'button', style: 'background:' + c, title: 'Copy ' + c });
      sw.append(el('span', { class: 'pal-hex' }, c));
      sw.addEventListener('click', () => copyColor(c, sw));
      if (ctx.annotate) {
        ctx.annotate.register(sw, {
          blockId,
          questionId: ctx.questionId,
          target: { kind: 'swatch', label: (p.name ? p.name + ' · ' : '') + c },
        });
      }
      row.append(sw);
    }
    card.append(row);
    const info = el('div', { class: 'pal-info' });
    const meta = el('div', { class: 'pal-meta' });
    if (p.name) meta.append(el('div', { class: 'pal-name' }, p.name));
    if (p.sub) meta.append(el('div', { class: 'pal-sub' }, p.sub));
    info.append(meta);
    if (p.tag) info.append(el('span', { class: 'pal-tag' + (p.tagTone ? ' tone-' + p.tagTone : '') }, p.tag));
    if (p.name || p.sub || p.tag) card.append(info);
    return card;
  }

  function renderPalette(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-palette' });
    const palettes = Array.isArray(block.palettes) ? block.palettes : [];
    if (block.title) wrap.append(el('div', { class: 'pal-title' }, block.title));
    const grid = el('div', { class: 'pal-grid' });
    for (const p of palettes) {
      if (p.featured) wrap.append(paletteCard(p, true, ctx, blockId));
      else grid.append(paletteCard(p, false, ctx, blockId));
    }
    if (grid.childNodes.length) wrap.append(grid);
    return wrap;
  }

