  // ======================================================================
  // client-side spec normalization (resilience)
  // ----------------------------------------------------------------------
  // The host normally hands us the SERVER-normalized spec via the tool result
  // (structuredContent.spec) — options as {value,label}, blocks with ids, etc.
  // If a host only forwards the raw tool input, this brings it close enough to
  // render: it assigns ids and coerces option/column shapes. File-backed blocks
  // (codeFile/htmlFile/local images) can't be resolved client-side and are left
  // to the server path.
  function clientNormalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const spec = {
      title: String(raw.title || 'Relay'),
      intro: typeof raw.intro === 'string' ? raw.intro : '',
      blocks: normBlocks(raw.blocks, ''),
      allowPartial: raw.allowPartial !== false,
      note: raw.note !== false,
      autoClose: raw.autoClose !== false,
      responseRequired: raw.responseRequired !== false,
      questions: [],
      submitLabel: typeof raw.submitLabel === 'string' ? raw.submitLabel : '',
    };
    const qs = Array.isArray(raw.questions) ? raw.questions : [];
    qs.forEach((rq, i) => {
      if (!rq || typeof rq !== 'object') return;
      const id = String(rq.id || 'q' + (i + 1));
      const type = String(rq.type || 'text');
      const q = {
        id, type,
        label: String(rq.label || rq.question || rq.text || ''),
        description: typeof rq.description === 'string' ? rq.description : '',
        required: rq.required === true,
        note: rq.note === undefined ? (type === 'single' || type === 'rank' || type === 'checklist' || type === 'allocate') : rq.note === true,
        placeholder: typeof rq.placeholder === 'string' ? rq.placeholder : '',
        blocks: normBlocks(rq.blocks, id + '-'),
      };
      if (type === 'single' || type === 'multi' || type === 'rank' || type === 'checklist' || type === 'allocate') {
        const opts = Array.isArray(rq.options) ? rq.options : [];
        q.options = opts.map((o, j) => {
          if (typeof o === 'string' || typeof o === 'number') return { value: String(o), label: String(o) };
          if (o && typeof o === 'object') {
            const value = String(o.value != null ? o.value : o.label != null ? o.label : '');
            const out = { value, label: String(o.label != null ? o.label : value) };
            if (o.description) out.description = String(o.description);
            const ob = normBlocks(o.blocks, id + '-o' + (j + 1) + '-');
            if (ob.length) out.blocks = ob;
            return out;
          }
          return { value: String(o), label: String(o) };
        });
        if (type === 'single' || type === 'multi') q.other = type === 'single' ? rq.other !== false : rq.other === true;
      }
      if (type === 'checklist') {
        const rawSt = Array.isArray(rq.statuses) && rq.statuses.length ? rq.statuses
          : [{ value: 'pass', label: 'Pass', tone: 'ok' }, { value: 'fail', label: 'Fail', tone: 'bad' }, { value: 'na', label: 'N/A', tone: 'muted' }];
        q.statuses = rawSt.map((s) => typeof s === 'object' && s
          ? { value: String(s.value != null ? s.value : s.label || ''), label: String(s.label != null ? s.label : s.value || ''), tone: s.tone ? String(s.tone) : undefined }
          : { value: String(s), label: String(s) === 'na' ? 'N/A' : String(s) });
      }
      if (type === 'allocate') {
        q.total = Number.isFinite(rq.total) && rq.total > 0 ? Math.floor(rq.total) : 100;
        if (rq.unit !== undefined) q.unit = String(rq.unit);
      }
      if (type === 'pick') {
        const tiles = Array.isArray(rq.items) ? rq.items : [];
        q.items = tiles.map((t) => (t && typeof t === 'object'
          ? { ...t, id: String(t.id != null ? t.id : t.title || ''), title: String(t.title != null ? t.title : t.id || '') }
          : { id: String(t), title: String(t) }));
        q.min = Number.isInteger(rq.min) && rq.min >= 0 ? Math.min(rq.min, q.items.length) : 0;
        q.max = Number.isInteger(rq.max) && rq.max >= 1 ? Math.min(rq.max, q.items.length) : q.items.length;
        q.itemNote = rq.itemNote !== false;
        q.overall = rq.overall !== false;
        q.note = false;
        if (q.min > 0) q.required = true;
      }
      if (type === 'scale') {
        q.min = Number.isFinite(rq.min) ? rq.min : 1;
        q.max = Number.isFinite(rq.max) ? rq.max : Math.max(5, q.min + 1);
        q.minLabel = typeof rq.minLabel === 'string' ? rq.minLabel : '';
        q.maxLabel = typeof rq.maxLabel === 'string' ? rq.maxLabel : '';
      }
      if (type === 'color' && Array.isArray(rq.presets)) {
        q.presets = rq.presets.map((c) => String(c)).filter(Boolean);
      }
      if (type === 'color' && Array.isArray(rq.palette)) {
        q.palette = rq.palette.map((p) => typeof p === 'object' && p
          ? { value: String(p.value != null ? p.value : p.color || ''), label: String(p.label != null ? p.label : (p.name != null ? p.name : (p.value != null ? p.value : p.color || ''))) }
          : { value: String(p), label: String(p) }).filter((p) => p.value);
      }
      if (rq.default !== undefined) q.default = rq.default;
      spec.questions.push(q);
    });
    if (!spec.submitLabel) spec.submitLabel = spec.questions.length ? 'Submit' : 'Acknowledge';
    return spec;
  }
  function normBlocks(blocks, prefix) {
    if (!Array.isArray(blocks)) return [];
    let n = 0;
    const out = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object' || !b.type) continue;
      out.push(b.id ? b : { ...b, id: prefix + 'b' + (++n) });
      if (b.id) n++;
    }
    return out;
  }

