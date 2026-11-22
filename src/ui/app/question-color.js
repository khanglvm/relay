  function cssColorToHex(str) {
    const s = String(str || '').trim();
    let m = /^#?([0-9a-fA-F]{6})$/.exec(s);
    if (m) return '#' + m[1].toLowerCase();
    m = /^#?([0-9a-fA-F]{3})$/.exec(s);
    if (m) return '#' + m[1].split('').map((x) => x + x).join('').toLowerCase();
    try {
      const d = document.createElement('div');
      d.style.color = '';
      d.style.color = s;
      if (!d.style.color) return null; // browser rejected it → invalid color
      d.style.display = 'none';
      document.body.appendChild(d);
      const rgb = getComputedStyle(d).color;
      document.body.removeChild(d);
      const mm = rgb.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (!mm) return null;
      const h = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
      return '#' + h(mm[1]) + h(mm[2]) + h(mm[3]);
    } catch { return null; }
  }
  function toHex6(c) { return cssColorToHex(c) || '#000000'; }

  function controlColor(q) {
    const wrap = el('div', { class: 'colorpick' });
    const init = (typeof state.answers[q.id] === 'string' && state.answers[q.id]) || (typeof q.default === 'string' ? q.default : '');
    const swatch = el('input', { type: 'color', class: 'colorswatch' });
    const hex = el('input', { type: 'text', class: 'colorhex', placeholder: q.placeholder || '#rrggbb / rgb() / name', spellcheck: 'false', autocapitalize: 'off' });
    swatch.value = toHex6(init || '#888888');
    if (init) { hex.value = init; state.answers[q.id] = init; }
    let syncPaletteSel = () => {};
    const set = (val) => { state.answers[q.id] = val; syncPaletteSel(); clearErr(q.id); scheduleSave(); };
    swatch.addEventListener('input', () => { hex.value = swatch.value; set(swatch.value); });
    hex.addEventListener('input', () => { const v = hex.value.trim(); const h = cssColorToHex(v); if (h) swatch.value = h; set(v); });

    // "Pick from a palette" — labeled swatch cards. Click selects that color as
    // the answer; each card is registered for annotation (per-color comments).
    if (Array.isArray(q.palette) && q.palette.length) {
      const grid = el('div', { class: 'colorpalette' });
      const cards = [];
      for (const p of q.palette) {
        const labelled = p.label && p.label !== p.value;
        const card = el('button', { type: 'button', class: 'colorpal-sw', style: 'background:' + p.value, title: (labelled ? p.label + ' · ' : '') + p.value });
        if (labelled) card.append(el('span', { class: 'colorpal-label' }, p.label));
        card.addEventListener('click', () => { const h = cssColorToHex(p.value); if (h) swatch.value = h; hex.value = p.value; set(p.value); });
        if (Annotate) Annotate.register(card, { blockId: null, questionId: q.id, target: { kind: 'swatch', label: (labelled ? p.label + ' · ' : '') + p.value } });
        cards.push({ card, val: p.value });
        grid.append(card);
      }
      syncPaletteSel = () => { for (const c of cards) c.card.classList.toggle('sel', state.answers[q.id] === c.val); };
      wrap.append(grid);
    }

    wrap.append(el('div', { class: 'colorrow' }, swatch, hex));
    if (Array.isArray(q.presets) && q.presets.length) {
      const presets = el('div', { class: 'colorpresets' });
      for (const c of q.presets) {
        const b = el('button', { type: 'button', class: 'colorpreset', style: 'background:' + c, title: c });
        b.addEventListener('click', () => { const h = cssColorToHex(c); if (h) swatch.value = h; hex.value = c; set(c); });
        presets.append(b);
      }
      wrap.append(presets);
    }
    syncPaletteSel();
    return wrap;
  }

