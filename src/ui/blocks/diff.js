  // ---------- diff (unified / git diff) ----------
  // No git is involved — the agent supplies the diff text. Parsed once into
  // rows, then rendered either UNIFIED (one column, +/- signs) or SPLIT (old |
  // new side-by-side). A header toggle flips between the two live; the block's
  // "view" sets the initial mode. Each code line is tinted by lang.

  // Parse a unified diff into a flat row list: {kind, text, oldNo, newNo}
  // (line numbers stored 0-based; rendered +1).
  function parseDiff(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const rows = [];
    let oldNo = 0;
    let newNo = 0;
    // Diff content (+/-/context) only has meaning INSIDE a hunk. Lines before the
    // first @@ are either recognized headers (handled below) or the commit
    // header/message of `git show`/`git log -p` output — skip the latter so it
    // isn't rendered as bogus context rows (which split view duplicates on both
    // sides as long unwrapped lines, shoving the new side off-screen).
    let inHunk = false;
    for (const line of lines) {
      if (/^@@/.test(line)) {
        const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
        if (m) { oldNo = Number(m[1]) - 1; newNo = Number(m[2]) - 1; }
        inHunk = true;
        rows.push({ kind: 'hunk', text: line });
      } else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |copy )/.test(line)) {
        rows.push({ kind: 'meta', text: line });
      } else if (!inHunk) {
        continue; // commit header/message preamble before the first hunk — drop it
      } else if (line[0] === '+') {
        rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
      } else if (line[0] === '-') {
        rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
      } else {
        rows.push({ kind: 'ctx', text: line[0] === ' ' ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
      }
    }
    return rows;
  }

  function diffNoTd(n, extraClass) {
    const td = el('td', { class: 'diff-no' + (extraClass ? ' ' + extraClass : ''), 'aria-hidden': 'true' });
    if (n !== undefined && n !== null) td.textContent = String(n + 1);
    return td;
  }
  function diffCodeTd(html, extraClass) {
    const c = el('code');
    c.innerHTML = html || ' ';
    return el('td', { class: 'diff-code' + (extraClass ? ' ' + extraClass : '') }, c);
  }

  // Unified: oldNo | newNo | sign | code
  function buildUnifiedDiff(rows, lang) {
    const tbody = el('tbody');
    for (const r of rows) {
      const full = r.kind === 'hunk' || r.kind === 'meta';
      const codeHtml = full ? esc(r.text) : tintCode(r.text, lang);
      const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '';
      tbody.append(el('tr', { class: 'diff-row diff-' + r.kind },
        diffNoTd(r.oldNo),
        diffNoTd(r.newNo),
        el('td', { class: 'diff-sign', 'aria-hidden': 'true' }, sign),
        diffCodeTd(codeHtml)
      ));
    }
    return el('table', { class: 'blk-difftable' }, tbody);
  }

  // Split: oldNo | old code || newNo | new code. A run of removed lines is
  // paired row-by-row with the following run of added lines; the shorter side
  // gets filler cells. Context shows identically on both sides.
  function buildSplitDiff(rows, lang) {
    const tbody = el('tbody');
    const fullRow = (cls, text) => {
      const c = el('code');
      c.innerHTML = esc(text) || ' ';
      tbody.append(el('tr', { class: 'diff-row diff-' + cls }, el('td', { class: 'diff-code', colspan: '4' }, c)));
    };
    let dels = [];
    let adds = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        const d = dels[i];
        const a = adds[i];
        const left = d
          ? [diffNoTd(d.oldNo, 'diff-del'), diffCodeTd(tintCode(d.text, lang), 'diff-del')]
          : [diffNoTd(null, 'diff-fill'), diffCodeTd(' ', 'diff-fill')];
        const right = a
          ? [diffNoTd(a.newNo, 'diff-newside diff-add'), diffCodeTd(tintCode(a.text, lang), 'diff-add')]
          : [diffNoTd(null, 'diff-fill diff-newside'), diffCodeTd(' ', 'diff-fill')];
        tbody.append(el('tr', { class: 'diff-row' }, left[0], left[1], right[0], right[1]));
      }
      dels = [];
      adds = [];
    };
    for (const r of rows) {
      if (r.kind === 'del') { dels.push(r); continue; }
      if (r.kind === 'add') { adds.push(r); continue; }
      flush();
      if (r.kind === 'hunk') fullRow('hunk', r.text);
      else if (r.kind === 'meta') fullRow('meta', r.text);
      else {
        const html = tintCode(r.text, lang);
        tbody.append(el('tr', { class: 'diff-row diff-ctx' },
          diffNoTd(r.oldNo), diffCodeTd(html),
          diffNoTd(r.newNo, 'diff-newside'), diffCodeTd(html)
        ));
      }
    }
    flush();
    return el('table', { class: 'blk-difftable blk-difftable-split' }, tbody);
  }

  // Split a (possibly multi-file) unified diff into per-file chunks. Each
  // `diff --git a/x b/x` starts a new file; the name comes from that line (or a
  // following `+++ b/...`). A plain hunk-only diff (no `diff --git`) is one
  // unnamed file, preserving the single-file path that uses block.filename.
  function splitDiffFiles(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const files = [];
    let cur = null;
    for (const line of lines) {
      if (/^diff --git /.test(line)) {
        const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        cur = { name: m ? m[2] : 'file', lines: [line] };
        files.push(cur);
      } else {
        if (!cur) { cur = { name: null, lines: [] }; files.push(cur); }
        cur.lines.push(line);
        if (cur.name === null) {
          const pm = line.match(/^\+\+\+ b?\/(.+)$/);
          if (pm) cur.name = pm[1];
        }
      }
    }
    return files.map((f) => ({ name: f.name, text: f.lines.join('\n') }));
  }

  // Per-file header lines are redundant once we render a filename header bar.
  const DIFF_NOISE = /^(diff --git |index |--- |\+\+\+ )/;

  function buildDiffReviewHunks(files, block) {
    const hunks = [];
    files.forEach((f) => {
      const name = f.name || (files.length === 1 ? (block.filename || '') : '') || 'file';
      let rows = parseDiff(f.text);
      if (name) rows = rows.filter((r) => !(r.kind === 'meta' && DIFF_NOISE.test(r.text)));
      let current = null;
      const push = () => {
        if (!current) return;
        const hasChange = current.rows.some((r) => r.kind === 'add' || r.kind === 'del');
        if (hasChange) hunks.push(current);
        current = null;
      };
      rows.forEach((r) => {
        if (r.kind === 'hunk') {
          push();
          current = { id: 'h' + (hunks.length + 1), file: name, header: r.text, rows: [r] };
        } else if (current) {
          current.rows.push(r);
        } else if (r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx') {
          current = { id: 'h' + (hunks.length + 1), file: name, header: 'Change', rows: [r] };
        }
      });
      push();
    });
    return hunks;
  }

  function renderDiffReview(block, ctx, blockId, files) {
    const hunks = buildDiffReviewHunks(files, block);
    let view = block.view === 'split' ? 'split' : 'unified';
    const prior = ctx && ctx.edits && ctx.edits[blockId] && typeof ctx.edits[blockId] === 'object'
      ? ctx.edits[blockId]
      : {};
    const choices = prior.hunks && typeof prior.hunks === 'object' ? { ...prior.hunks } : {};
    const buttonsByHunk = new Map();
    const wrap = el('div', { class: 'blk-codewrap blk-diffwrap diff-review' });
    const status = el('span', { class: 'diff-review-status' }, '');
    const list = el('div', { class: 'diff-review-list' });

    const emit = () => {
      const picked = {};
      hunks.forEach((h) => {
        const r = choices[h.id];
        if (!r || !['apply', 'skip', 'hold'].includes(r.choice)) return;
        picked[h.id] = { choice: r.choice, file: h.file, header: h.header };
      });
      const touched = Object.keys(picked).length;
      const payload = touched
        ? {
            type: 'diff-review',
            reviewKind: block.reviewKind || '',
            commit: block.commit || '',
            title: block.title || block.filename || '',
            resolved: touched === hunks.length,
            hunks: picked,
          }
        : null;
      if (ctx && typeof ctx.onBlockEdit === 'function') ctx.onBlockEdit(blockId, payload);
      wrap.dispatchEvent(new CustomEvent('relay:block-edit', {
        bubbles: true,
        detail: { blockId, value: payload },
      }));
      status.textContent = `${touched}/${hunks.length} reviewed`;
      status.classList.toggle('is-complete', hunks.length > 0 && touched === hunks.length);
      for (const h of hunks) {
        const set = buttonsByHunk.get(h.id) || [];
        const chosen = choices[h.id] && choices[h.id].choice;
        set.forEach((b) => b.el.classList.toggle('sel', b.choice === chosen));
      }
    };

    const setChoice = (h, choice) => {
      choices[h.id] = { choice, file: h.file, header: h.header };
      emit();
    };

    const setAll = (choice) => {
      hunks.forEach((h) => {
        choices[h.id] = { choice, file: h.file, header: h.header };
      });
      emit();
    };

    const makeReviewButton = (label, onClick, extraClass = '') => {
      const b = el('button', { type: 'button', class: 'diff-review-btn' + (extraClass ? ' ' + extraClass : '') }, label);
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    const repaint = () => {
      list.replaceChildren();
      hunks.forEach((h) => {
        const actionbar = el('div', { class: 'diff-review-hunkbar' },
          el('div', { class: 'diff-review-hunkmeta' },
            el('span', { class: 'diff-review-file' }, h.file),
            el('span', { class: 'diff-review-header' }, h.header)
          )
        );
        const rowButtons = [
          { choice: 'apply', label: 'Apply hunk' },
          { choice: 'skip', label: 'Skip hunk' },
          { choice: 'hold', label: 'Hold' },
        ].map((item) => ({
          choice: item.choice,
          el: makeReviewButton(item.label, () => setChoice(h, item.choice), 'diff-review-choice'),
        }));
        buttonsByHunk.set(h.id, rowButtons);
        actionbar.append(el('div', { class: 'diff-review-actions' }, rowButtons.map((b) => b.el)));
        list.append(el('section', { class: 'diff-review-hunk' },
          actionbar,
          view === 'split' ? buildSplitDiff(h.rows, block.lang) : buildUnifiedDiff(h.rows, block.lang)
        ));
      });
      emit();
    };

    const toggle = makeReviewButton('', () => {
      view = view === 'split' ? 'unified' : 'split';
      wrap.classList.toggle('is-split', view === 'split');
      toggle.textContent = view === 'split' ? 'Unified view' : 'Split view';
      repaint();
    }, 'blk-difftoggle');
    toggle.title = 'Toggle side-by-side view';
    toggle.textContent = view === 'split' ? 'Unified view' : 'Split view';

    const title = block.title || block.filename || (files.length > 1 ? `${files.length} files changed` : 'Diff review');
    wrap.append(el('div', { class: 'blk-codehead diff-review-head' },
      el('span', { class: 'blk-codename' }, title),
      el('div', { class: 'diff-review-topactions' },
        status,
        makeReviewButton('Apply all', () => setAll('apply')),
        makeReviewButton('Skip all', () => setAll('skip')),
        makeReviewButton('Hold all', () => setAll('hold')),
        toggle
      )
    ));
    wrap.classList.toggle('is-split', view === 'split');
    wrap.append(list);
    repaint();
    ctx && ctx.annotate && ctx.annotate.enableTextSelection(list, { blockId, questionId: ctx.questionId });
    attachViewer(wrap, { zoomEl: null, label: 'diff review', comment: wholeBlockComment(ctx, blockId, 'diff review') });
    return wrap;
  }

  function renderDiff(block, ctx, blockId) {
    const files = splitDiffFiles(block.diff);
    if (block.review === true && ctx.canEditBlocks !== false) return renderDiffReview(block, ctx, blockId, files);
    const named = files.filter((f) => f.name);
    const multi = named.length > 1;
    let view = block.view === 'split' ? 'split' : 'unified';
    const scroll = el('div', { class: 'blk-diffscroll' });
    const sections = [];

    const paint = () => {
      scroll.replaceChildren();
      sections.length = 0;
      files.forEach((f) => {
        const name = f.name || (files.length === 1 ? (block.filename || '') : '');
        let rows = parseDiff(f.text);
        // drop the pure file-header noise when we show a filename bar
        if (name) rows = rows.filter((r) => !(r.kind === 'meta' && DIFF_NOISE.test(r.text)));
        if (!rows.length) return;
        const sec = el('div', { class: 'diff-file' });
        if (name) sec.append(el('div', { class: 'diff-filehead' }, name));
        sec.append(view === 'split' ? buildSplitDiff(rows, block.lang) : buildUnifiedDiff(rows, block.lang));
        scroll.append(sec);
        sections.push({ name, el: sec });
      });
    };
    paint();

    const wrap = el('div', { class: 'blk-codewrap blk-diffwrap' });
    // header: file count / single name (left) + a Unified/Split view toggle (right)
    const toggle = el('button', { class: 'blk-difftoggle', type: 'button', title: 'Toggle side-by-side view' });
    const syncToggle = () => { toggle.textContent = view === 'split' ? 'Unified view' : 'Split view'; };
    syncToggle();
    toggle.addEventListener('mousedown', (e) => e.stopPropagation());
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view = view === 'split' ? 'unified' : 'split';
      wrap.classList.toggle('is-split', view === 'split');
      syncToggle();
      paint();
    });
    const headLabel = multi ? `${named.length} files changed` : (named[0] && named[0].name) || block.filename || '';
    wrap.append(el('div', { class: 'blk-codehead' },
      el('span', { class: 'blk-codename' }, headLabel),
      toggle
    ));
    // jump bar of file chips for a multi-file diff (click scrolls to that file)
    if (multi) {
      const bar = el('div', { class: 'diff-files' });
      named.forEach((f) => {
        const chip = el('button', { type: 'button', class: 'diff-file-chip' }, f.name);
        chip.addEventListener('mousedown', (e) => e.stopPropagation());
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const s = sections.find((x) => x.name === f.name);
          if (s) s.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        bar.append(chip);
      });
      wrap.append(bar);
    }
    wrap.classList.toggle('is-split', view === 'split');
    wrap.append(scroll);
    // select-to-comment stays bound to the stable scroll container across toggles
    ctx && ctx.annotate && ctx.annotate.enableTextSelection(scroll, { blockId, questionId: ctx.questionId });
    attachViewer(wrap, { zoomEl: null, label: 'diff', comment: wholeBlockComment(ctx, blockId, 'diff') });
    return wrap;
  }

