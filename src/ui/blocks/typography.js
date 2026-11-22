  // ---------- typography (type specimens) ----------
  function renderTypography(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-typography' });
    if (block.title) wrap.append(el('div', { class: 'typo-title' }, block.title));
    for (const s of block.specimens || []) {
      const meta = [];
      if (s.label) meta.push(s.label);
      if (s.size) meta.push(s.size);
      if (s.weight) meta.push('w' + s.weight);
      const sample = el('div', { class: 'typo-sample' }, s.text);
      // set via DOM style props (browser ignores invalid values — no injection)
      if (s.size) sample.style.fontSize = s.size;
      if (s.weight) sample.style.fontWeight = s.weight;
      if (s.font || block.font) sample.style.fontFamily = s.font || block.font;
      if (s.lineHeight) sample.style.lineHeight = s.lineHeight;
      if (s.letterSpacing) sample.style.letterSpacing = s.letterSpacing;
      wrap.append(el('div', { class: 'typo-row' },
        meta.length ? el('div', { class: 'typo-meta' }, meta.join(' · ')) : null,
        sample
      ));
    }
    ctx.annotate && ctx.annotate.enableTextSelection(wrap, { blockId, questionId: ctx.questionId });
    return wrap;
  }

