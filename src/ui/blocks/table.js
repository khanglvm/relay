  // ---------- table ----------
  function normalizeColumns(columns) {
    return (columns || []).map((c, idx) => {
      if (c && typeof c === 'object') {
        return { key: c.key !== undefined ? c.key : idx, label: c.label !== undefined ? c.label : String(c.key), align: c.align || null };
      }
      return { key: idx, label: String(c), align: null };
    });
  }

  function cellValue(row, col) {
    if (Array.isArray(row)) return row[col.key];
    return row[col.key];
  }

  function numericAware(a, b) {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    const aNum = a !== '' && a !== null && a !== undefined && !Number.isNaN(na) && String(na) === String(a).trim();
    const bNum = b !== '' && b !== null && b !== undefined && !Number.isNaN(nb) && String(nb) === String(b).trim();
    if (aNum && bNum) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // CSV-encode a value (quote when it contains a comma/quote/newline).
  function csvCell(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // Trigger a client-side download of `text` as `filename` (browser board). In a
  // sandboxed/MCP host this may be blocked — best effort, no error if it no-ops.
  function downloadText(filename, text, mime) {
    try {
      const blob = new Blob([text], { type: mime || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) { /* sandbox without download permission */ }
  }

  function renderTable(block, ctx, blockId) {
    const cols = normalizeColumns(block.columns);
    const rows = block.rows || [];
    const sortable = block.sortable === true;
    const filterable = block.filterable === true;
    const exportable = block.exportable === true;
    let filterText = '';
    // sortState: column index in cols (-1 none) + dir
    let sortCol = -1;
    let sortDir = 0; // 0 none, 1 asc, -1 desc

    const table = el('table', { class: 'blk-table' });
    const thead = el('thead');
    const trHead = el('tr');
    const headCells = [];
    cols.forEach((col, ci) => {
      const th = el('th', { class: sortable ? 'sortable' : null });
      if (col.align) th.style.textAlign = col.align;
      const labelSpan = el('span', {}, col.label);
      const arrow = el('span', { class: 'sort-arrow' }, '');
      th.append(labelSpan, arrow);
      if (sortable) {
        th.addEventListener('click', () => {
          if (sortCol === ci) sortDir = sortDir === 1 ? -1 : sortDir === -1 ? 0 : 1;
          else { sortCol = ci; sortDir = 1; }
          rebuild();
        });
      }
      headCells.push({ th, arrow });
      trHead.append(th);
    });
    thead.append(trHead);
    const tbody = el('tbody');
    table.append(thead, tbody);

    // rows (as original indices) passing the current filter — used by both the
    // table body and the CSV export so export honors the visible/filtered set.
    function filteredOrder() {
      let order = rows.map((_r, idx) => idx);
      if (filterText) {
        const q = filterText.toLowerCase();
        order = order.filter((idx) => cols.some((col) => {
          const v = cellValue(rows[idx], col);
          return v !== undefined && v !== null && String(v).toLowerCase().includes(q);
        }));
      }
      if (sortable && sortCol >= 0 && sortDir !== 0) {
        const col = cols[sortCol];
        order.sort((ia, ib) => {
          const r = numericAware(cellValue(rows[ia], col), cellValue(rows[ib], col));
          return sortDir === 1 ? r : -r;
        });
      }
      return order;
    }

    function rebuild() {
      const order = filteredOrder();
      headCells.forEach((hc, ci) => {
        hc.arrow.textContent = sortable && ci === sortCol && sortDir !== 0 ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
      });
      tbody.replaceChildren();
      for (const origIdx of order) {
        const row = rows[origIdx];
        const tr = el('tr');
        for (const col of cols) {
          const raw = cellValue(row, col);
          const td = el('td', {}, raw === undefined || raw === null ? '' : String(raw));
          if (col.align) td.style.textAlign = col.align;
          ctx.annotate?.register(td, {
            blockId,
            questionId: ctx.questionId,
            target: { kind: 'table-cell', row: origIdx, col: col.key, value: String(raw === undefined || raw === null ? '' : raw) },
          });
          tr.append(td);
        }
        tbody.append(tr);
      }
    }
    rebuild();
    // Tables are visual too: wrap so they get the full-screen viewer like
    // every other visual block (wide tables squeeze in the column).
    const wrap = el('div', { class: 'blk-tablewrap' });
    // Optional toolbar: live filter box + CSV export of the filtered rows.
    if (filterable || exportable) {
      const bar = el('div', { class: 'blk-tablebar' });
      if (filterable) {
        const input = el('input', { type: 'text', class: 'blk-tablefilter', placeholder: 'Filter rows…', 'aria-label': 'Filter table rows' });
        input.addEventListener('input', () => { filterText = input.value.trim(); rebuild(); });
        // don't let a click in the filter start a drag-pan / full-screen
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        bar.append(input);
      }
      if (exportable) {
        const btn = el('button', { type: 'button', class: 'blk-tableexport', title: 'Download the filtered rows as CSV' }, 'CSV');
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const order = filteredOrder();
          const head = cols.map((c) => csvCell(c.label)).join(',');
          const body = order.map((idx) => cols.map((c) => csvCell(cellValue(rows[idx], c))).join(',')).join('\n');
          downloadText('table.csv', head + '\n' + body + '\n', 'text/csv');
        });
        bar.append(btn);
      }
      wrap.append(bar);
    }
    wrap.append(table);
    attachViewer(wrap, { zoomEl: null });
    return wrap;
  }

