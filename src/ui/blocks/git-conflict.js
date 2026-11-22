  // ---------- git conflict resolver ----------
  function markerConflictText(h) {
    const chunks = [
      '<<<<<<< ' + (h.oursLabel || 'ours'),
      h.ours || '',
    ];
    if (h.baseLabel) chunks.push('||||||| ' + h.baseLabel, h.base || '');
    chunks.push('=======', h.theirs || '', '>>>>>>> ' + (h.theirsLabel || 'theirs'));
    return chunks.join('\n');
  }

  function conflictChoiceText(h, choice, custom) {
    if (choice === 'ours') return h.ours || '';
    if (choice === 'theirs') return h.theirs || '';
    if (choice === 'both') {
      const left = h.ours || '';
      const right = h.theirs || '';
      return left && right ? left + '\n' + right : left || right;
    }
    if (choice === 'custom') return custom || '';
    return markerConflictText(h);
  }

  function joinResolvedParts(block, resolutions) {
    const byId = new Map((block.conflicts || []).map((h) => [h.id, h]));
    return (block.parts || []).map((part) => {
      if (!part || part.type === 'text') return part && part.text ? part.text : '';
      const h = byId.get(part.conflictId);
      if (!h) return '';
      const r = resolutions && resolutions[h.id] ? resolutions[h.id] : {};
      return conflictChoiceText(h, r.choice, r.value);
    }).join('\n');
  }

  function renderConflictCode(text, lang) {
    const pre = el('pre', { class: 'gitconf-pre' });
    const code = el('code');
    code.innerHTML = tintCode(text || ' ', lang);
    pre.append(code);
    return pre;
  }

  function renderGitConflict(block, ctx, blockId) {
    const editable = ctx.canEditBlocks !== false;
    const conflicts = Array.isArray(block.conflicts) ? block.conflicts : [];
    const prior = ctx && ctx.edits && ctx.edits[blockId] && typeof ctx.edits[blockId] === 'object'
      ? ctx.edits[blockId]
      : {};
    const resolutions = prior.resolutions && typeof prior.resolutions === 'object' ? { ...prior.resolutions } : {};
    const wrap = el('div', { class: 'gitconf' });
    const count = conflicts.length;
    const title = block.title || block.filename || 'Git conflict';
    const status = el('span', { class: 'gitconf-status' }, `${count} conflict${count === 1 ? '' : 's'}`);
    const resolvedPreview = el('pre', { class: 'gitconf-resolved' }, el('code'));

    function emit() {
      const touched = Object.keys(resolutions).filter((id) => resolutions[id] && resolutions[id].choice);
      const payload = touched.length
        ? {
            type: 'git-conflict-resolution',
            filename: block.filename || '',
            file: block.file || '',
            resolved: touched.length === count,
            resolutions,
            content: joinResolvedParts(block, resolutions),
          }
        : null;
      if (ctx && typeof ctx.onBlockEdit === 'function') ctx.onBlockEdit(blockId, payload);
      wrap.dispatchEvent(new CustomEvent('relay:block-edit', {
        bubbles: true,
        detail: { blockId, value: payload },
      }));
      resolvedPreview.querySelector('code').textContent = joinResolvedParts(block, resolutions);
      status.textContent = `${touched.length}/${count} resolved`;
      status.classList.toggle('is-complete', touched.length === count);
    }

    wrap.append(el('div', { class: 'gitconf-head' },
      el('div', {},
        el('div', { class: 'gitconf-title' }, title),
        block.file ? el('div', { class: 'gitconf-file' }, block.file) : null),
      status
    ));

    conflicts.forEach((h, idx) => {
      const body = el('div', { class: 'gitconf-body' });
      const custom = el('textarea', {
        class: 'gitconf-custom',
        spellcheck: 'false',
        rows: '5',
        placeholder: 'Write the resolved content for this hunk',
        disabled: editable ? null : '',
      });
      const buttons = [];
      const setChoice = (choice) => {
        const current = resolutions[h.id] || {};
        const next = { choice, value: choice === 'custom' ? custom.value : conflictChoiceText(h, choice, custom.value) };
        resolutions[h.id] = next;
        for (const b of buttons) b.el.classList.toggle('sel', b.choice === choice);
        body.classList.toggle('is-custom', choice === 'custom');
        emit();
      };
      const makeButton = (choice, label) => {
        const b = el('button', { type: 'button', class: 'gitconf-choice', disabled: editable ? null : '' }, label);
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setChoice(choice); });
        buttons.push({ choice, el: b });
        return b;
      };
      const existing = resolutions[h.id] || {};
      if (existing.choice === 'custom') custom.value = existing.value || '';
      else custom.value = conflictChoiceText(h, existing.choice || 'ours', '');
      custom.addEventListener('input', () => setChoice('custom'));

      body.append(el('div', { class: 'gitconf-choicebar' },
        makeButton('ours', 'Use ours'),
        makeButton('theirs', 'Use theirs'),
        makeButton('both', 'Keep both'),
        makeButton('custom', 'Custom')
      ));
      body.append(el('div', { class: 'gitconf-sides' },
        el('section', { class: 'gitconf-side gitconf-ours' },
          el('div', { class: 'gitconf-label' }, h.oursLabel || 'ours'),
          renderConflictCode(h.ours || '', block.lang)),
        h.baseLabel ? el('section', { class: 'gitconf-side gitconf-base' },
          el('div', { class: 'gitconf-label' }, h.baseLabel),
          renderConflictCode(h.base || '', block.lang)) : null,
        el('section', { class: 'gitconf-side gitconf-theirs' },
          el('div', { class: 'gitconf-label' }, h.theirsLabel || 'theirs'),
          renderConflictCode(h.theirs || '', block.lang))
      ));
      body.append(custom);

      const card = el('section', { class: 'gitconf-card' },
        el('div', { class: 'gitconf-cardhead' },
          el('span', { class: 'gitconf-badge' }, `Conflict ${idx + 1}`),
          el('span', { class: 'gitconf-hint' }, 'Choose a side, keep both, or write the final hunk.')),
        body
      );
      wrap.append(card);
      if (existing.choice) setChoice(existing.choice);
    });

    wrap.append(el('details', { class: 'gitconf-preview' },
      el('summary', {}, 'Resolved file preview'),
      resolvedPreview
    ));
    emit();
    ctx && ctx.annotate && ctx.annotate.enableTextSelection(wrap, { blockId, questionId: ctx.questionId });
    return wrap;
  }
