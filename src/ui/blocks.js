// blocks.js — window.RelayBlocks: renders normalized "blocks" (markdown,
// table, code, chart, mermaid, html) into a container. Zero runtime deps;
// vanilla DOM. Chart.js / Mermaid are vendored and lazy-loaded on demand.
// XSS-safe: all source text is HTML-escaped before any markdown transform.
(() => {
  'use strict';

  // ---------- tiny DOM helper (mirrors app.js idiom) ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(c));
    }
    return n;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- chart palette (from contract) ----------
  const PALETTE_LIGHT = ['#c2674b', '#4d8a66', '#5a7ca8', '#b9913f', '#8a6da3', '#57534e'];
  const PALETTE_DARK = ['#d98e67', '#6fbf92', '#7c9fcc', '#d4b061', '#ad8fc2', '#a29c93'];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------- markdown mini renderer (NO library) ----------
  // Escape FIRST, then apply transforms on the already-escaped text. Because
  // <, >, & are gone, our generated tags are the only real tags in the output.
  function mdInline(escaped) {
    let s = escaped;
    // inline code first so its contents aren't treated as bold/italic/links
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    // links [text](url) — url is already escaped; guard javascript: schemes
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
      const safe = /^(https?:|mailto:|\/|#|\.)/i.test(url) ? url : '#';
      return `<a href="${safe}" target="_blank" rel="noopener">${text}</a>`;
    });
    // bold then italic (bold uses ** so must run before single *)
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
    s = s.replace(/\*([^*]+)\*/g, (_m, c) => `<em>${c}</em>`);
    return s;
  }

  function renderMarkdown(md) {
    const root = el('div', { class: 'md' });
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let i = 0;

    // list-stack rendering supports one nesting level (indent >= 2 spaces)
    function consumeList() {
      const blocks = []; // {ordered, items:[{html, sub:[...]}]}
      let cur = null;
      while (i < lines.length) {
        const line = lines[i];
        const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        const indent = m[1].length;
        const ordered = /\d+\./.test(m[2]);
        const content = mdInline(esc(m[3]));
        if (indent >= 2 && cur && cur.items.length) {
          // nested under the previous top-level item
          const parent = cur.items[cur.items.length - 1];
          if (!parent.sub) parent.sub = { ordered, items: [] };
          parent.sub.items.push(content);
        } else {
          if (!cur || cur.ordered !== ordered) {
            cur = { ordered, items: [] };
            blocks.push(cur);
          }
          cur.items.push({ html: content, sub: null });
        }
        i++;
      }
      let out = '';
      for (const b of blocks) {
        const tag = b.ordered ? 'ol' : 'ul';
        out += `<${tag}>`;
        for (const it of b.items) {
          out += `<li>${it.html}`;
          if (it.sub) {
            const st = it.sub.ordered ? 'ol' : 'ul';
            out += `<${st}>` + it.sub.items.map((x) => `<li>${x}</li>`).join('') + `</${st}>`;
          }
          out += '</li>';
        }
        out += `</${tag}>`;
      }
      return out;
    }

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block ```lang
      const fence = line.match(/^```\s*([\w+-]*)\s*$/);
      if (fence) {
        i++;
        const buf = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        if (i < lines.length) i++; // closing fence
        html += `<pre class="md-pre"><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }

      // horizontal rule
      if (/^\s*---+\s*$/.test(line)) { html += '<hr>'; i++; continue; }

      // headings
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        html += `<h${lvl}>${mdInline(esc(h[2]))}</h${lvl}>`;
        i++;
        continue;
      }

      // blockquote (collapse consecutive > lines)
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += `<blockquote>${mdInline(esc(buf.join(' ')))}</blockquote>`;
        continue;
      }

      // lists
      if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) { html += consumeList(); continue; }

      // blank line
      if (/^\s*$/.test(line)) { i++; continue; }

      // paragraph — accumulate until blank / block boundary
      const buf = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^\s*---+\s*$/.test(lines[i]) &&
        !/^#{1,3}\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      html += `<p>${mdInline(esc(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }

    root.innerHTML = html;
    return root;
  }

  // ---------- code tinter (lightweight regex highlighter) ----------
  const KEYWORDS = {
    js: 'await async break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while yield',
    ts: 'await async break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return super switch this throw true try type typeof undefined var void while yield',
    json: 'true false null',
    py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
    sh: 'if then else elif fi for while do done case esac function in return export local echo cd',
    css: '',
    html: '',
  };

  function tintCode(code, lang) {
    const langKey = (lang || '').toLowerCase();
    const alias = { javascript: 'js', typescript: 'ts', shell: 'sh', bash: 'sh', python: 'py' };
    const key = alias[langKey] || langKey;
    if (!Object.prototype.hasOwnProperty.call(KEYWORDS, key)) {
      return esc(code); // unknown lang -> plain
    }
    // Single-pass tokenizer over the RAW source: one alternation regex, each
    // match escaped + wrapped as it is emitted. No placeholders — placeholder
    // text gets re-tokenized by later passes and corrupts the output.
    const kws = (KEYWORDS[key] || '').split(' ').filter(Boolean);
    const kwAlt = kws.length ? kws.join('|') : 'A\\bB'; // alternation that never matches
    let rx;
    let classes;
    if (key === 'css') {
      rx = new RegExp(
        /(\/\*[\s\S]*?\*\/)/.source +
          '|' + /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.source +
          '|' + /([A-Za-z-]+(?=\s*:))/.source +
          '|' + /(\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)/.source,
        'g'
      );
      classes = ['com', 'str', 'kw', 'num'];
    } else if (key === 'html') {
      rx = new RegExp(
        /(<!--[\s\S]*?-->)/.source +
          '|' + /(<\/?[A-Za-z][\w-]*|\/?>)/.source +
          '|' + /("[^"]*")/.source,
        'g'
      );
      classes = ['com', 'kw', 'str'];
    } else {
      const comment = key === 'py' || key === 'sh'
        ? /(#[^\n]*)/.source
        : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.source;
      const str = key === 'py' || key === 'sh'
        ? /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.source
        : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/.source;
      rx = new RegExp(
        comment +
          '|' + str +
          '|' + /(\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b)/.source +
          '|(\\b(?:' + kwAlt + ')\\b)',
        'g'
      );
      classes = ['com', 'str', 'num', 'kw'];
    }
    let out = '';
    let last = 0;
    let m;
    while ((m = rx.exec(code))) {
      out += esc(code.slice(last, m.index));
      let cls = null;
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          cls = classes[g - 1];
          break;
        }
      }
      out += cls ? '<span class="tok-' + cls + '">' + esc(m[0]) + '</span>' : esc(m[0]);
      last = m.index + m[0].length;
      if (m[0].length === 0) rx.lastIndex++;
    }
    out += esc(code.slice(last));
    return out;
  }

  function renderCode(block) {
    const code = el('code');
    code.innerHTML = tintCode(block.code || '', block.lang);
    return el('pre', { class: 'blk-pre', 'data-lang': block.lang || '' }, code);
  }

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

  function renderTable(block, ctx, blockId) {
    const cols = normalizeColumns(block.columns);
    const rows = block.rows || [];
    const sortable = block.sortable === true;
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

    function rebuild() {
      // keep original row indices stable across sorts
      let order = rows.map((_r, idx) => idx);
      if (sortable && sortCol >= 0 && sortDir !== 0) {
        const col = cols[sortCol];
        order.sort((ia, ib) => {
          const r = numericAware(cellValue(rows[ia], col), cellValue(rows[ib], col));
          return sortDir === 1 ? r : -r;
        });
      }
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
    return table;
  }

  // ---------- lazy vendor loaders (cached promises) ----------
  let chartPromise = null;
  function loadChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (chartPromise) return chartPromise;
    chartPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/chart.umd.js';
      s.onload = () => (window.Chart ? resolve(window.Chart) : reject(new Error('Chart.js failed to load')));
      s.onerror = () => reject(new Error('Chart.js failed to load'));
      document.head.appendChild(s);
    });
    return chartPromise;
  }

  let mermaidPromise = null;
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid.min.js';
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid failed to load')));
      s.onerror = () => reject(new Error('Mermaid failed to load'));
      document.head.appendChild(s);
    });
    return mermaidPromise;
  }

  // ---------- chart ----------
  function clampHeight(h, def) {
    const n = Number(h);
    if (!Number.isFinite(n)) return def;
    return Math.max(100, Math.min(2400, n));
  }

  function palette() {
    return (document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches))
      ? PALETTE_DARK
      : PALETTE_LIGHT;
  }

  function themeDefaults(ctx) {
    const grid = cssVar('--border') || '#ece9e4';
    const tick = cssVar('--muted') || '#8a8580';
    const fontFamily = cssVar('--sans') || 'sans-serif';
    return { grid, tick, fontFamily };
  }

  // Apply theme defaults only where unset (deep, conservative).
  function applyChartTheme(config, ctx) {
    const { grid, tick, fontFamily } = themeDefaults(ctx);
    config.options = config.options || {};
    const o = config.options;
    if (o.responsive === undefined) o.responsive = true;
    if (o.maintainAspectRatio === undefined) o.maintainAspectRatio = false;
    if (o.animation === undefined) o.animation = false;
    o.plugins = o.plugins || {};
    o.plugins.legend = o.plugins.legend || {};
    o.plugins.legend.labels = o.plugins.legend.labels || {};
    if (o.plugins.legend.labels.color === undefined) o.plugins.legend.labels.color = tick;
    if (o.plugins.legend.labels.font === undefined) o.plugins.legend.labels.font = { family: fontFamily, size: 12 };
    if (o.plugins.title && o.plugins.title.color === undefined) o.plugins.title.color = tick;

    const styleAxis = (ax) => {
      if (!ax || typeof ax !== 'object') return;
      ax.grid = ax.grid || {};
      if (ax.grid.color === undefined) ax.grid.color = grid;
      ax.ticks = ax.ticks || {};
      if (ax.ticks.color === undefined) ax.ticks.color = tick;
      if (ax.ticks.font === undefined) ax.ticks.font = { family: fontFamily, size: 12 };
    };
    o.scales = o.scales || {};
    // Chart.js v3+ uses named scales (x/y/r). Style any present; for simplified
    // configs we pre-create x/y below.
    for (const key of Object.keys(o.scales)) styleAxis(o.scales[key]);
    return config;
  }

  function simplifiedToConfig(block, ctx) {
    const pal = palette();
    const kind = block.kind || 'bar';
    const series = block.series || [];
    const datasets = series.map((s, i) => {
      const color = s.color || pal[i % pal.length];
      const ds = {
        label: s.label !== undefined ? s.label : `Series ${i + 1}`,
        data: s.data || [],
      };
      if (kind === 'line') {
        ds.borderColor = color;
        ds.backgroundColor = color;
        ds.tension = 0.25;
        ds.pointRadius = 3;
      } else if (kind === 'pie' || kind === 'doughnut') {
        ds.backgroundColor = (s.data || []).map((_d, di) => s.color || pal[di % pal.length]);
        ds.borderColor = cssVar('--card') || '#fff';
        ds.borderWidth = 2;
      } else if (kind === 'radar') {
        ds.borderColor = color;
        ds.backgroundColor = color + '33';
        ds.pointBackgroundColor = color;
      } else {
        ds.backgroundColor = color;
        ds.borderColor = color;
      }
      return ds;
    });
    const config = {
      type: kind,
      data: { labels: block.labels || [], datasets },
      options: {},
    };
    if (block.title) {
      config.options.plugins = { title: { display: true, text: block.title } };
    }
    // pre-create x/y scales for cartesian kinds so theme styling applies
    if (kind === 'bar' || kind === 'line' || kind === 'scatter') {
      config.options.scales = { x: {}, y: {} };
    }
    return config;
  }

  function chartAnnotationCount(ctx, blockId) {
    if (!ctx.annotate) return 0;
    return ctx.annotate.list().filter(
      (a) => a.blockId === blockId && a.target && a.target.kind === 'chart-element'
    ).length;
  }

  function renderChart(block, ctx, blockId) {
    const height = clampHeight(block.height, 320);
    const wrap = el('div', { class: 'blk-chart' });
    wrap.style.height = height + 'px';
    const canvas = el('canvas');
    wrap.append(canvas);

    const badge = el('span', { class: 'blk-chart-badge' }, '');
    function syncBadge() {
      const n = chartAnnotationCount(ctx, blockId);
      if (n > 0) { badge.textContent = String(n); badge.style.display = ''; }
      else badge.style.display = 'none';
    }
    syncBadge();
    wrap.append(badge);

    loadChart().then((Chart) => {
      let config = block.config
        ? JSON.parse(JSON.stringify(block.config))
        : simplifiedToConfig(block, ctx);
      config = applyChartTheme(config, ctx);
      let chart;
      try {
        chart = new Chart(canvas.getContext('2d'), config);
        chartRegistry.push({ chart });
      } catch (err) {
        wrap.replaceChildren(el('div', { class: 'blk-error' }, 'Chart error: ' + (err && err.message ? err.message : String(err))));
        return;
      }
      // hover -> pointer cursor on a hit
      canvas.addEventListener('mousemove', (e) => {
        const hits = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
        canvas.style.cursor = hits.length ? 'pointer' : 'default';
      });
      canvas.addEventListener('click', (e) => {
        if (!ctx.annotate) return;
        const hits = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
        if (!hits.length) return;
        const { datasetIndex, index } = hits[0];
        const ds = config.data.datasets[datasetIndex] || {};
        const label = config.data.labels ? config.data.labels[index] : undefined;
        const value = Array.isArray(ds.data) ? ds.data[index] : undefined;
        ctx.annotate.openExternal(
          {
            blockId,
            questionId: ctx.questionId,
            target: { kind: 'chart-element', datasetIndex, index, label: label !== undefined ? String(label) : '', value },
          },
          wrap
        );
      });
    }).catch((err) => {
      wrap.replaceChildren(el('div', { class: 'blk-error' }, 'Chart error: ' + (err && err.message ? err.message : String(err))));
    });

    // expose a refresh hook so the list can update the badge after changes
    wrap._relaySyncBadge = syncBadge;
    return wrap;
  }

  // ---------- mermaid ----------
  let mermaidSeq = 0;
  // Registries so a live theme toggle can re-render diagrams and restyle
  // charts without a page reload.
  const mermaidRegistry = [];
  const chartRegistry = [];

  function renderMermaid(block, ctx, blockId) {
    const container = el('div', { class: 'blk-mermaid' });
    const entry = { container, block, ctx, blockId };
    mermaidRegistry.push(entry);
    drawMermaid(entry);
    return container;
  }

  function drawMermaid(entry) {
    const { container, block, ctx, blockId } = entry;
    loadMermaid().then((mermaid) => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: ctx.theme() === 'dark' ? 'dark' : 'neutral',
          securityLevel: 'strict',
        });
      } catch {
        // ignore re-init issues
      }
      const id = 'rly-mmd-' + (++mermaidSeq);
      const code = block.code || '';
      const onSvg = (svg) => {
        container.innerHTML = svg;
        const svgEl = container.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('height');
          svgEl.removeAttribute('width');
          const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
          if (vb && vb.width > 0) {
            // never upscale past the diagram's natural size; still shrink on
            // narrow screens (a 112px-wide graph must not stretch to 820px)
            svgEl.style.width = '100%';
            svgEl.style.maxWidth = Math.ceil(vb.width) + 'px';
            svgEl.style.height = 'auto';
          } else {
            svgEl.style.maxWidth = '100%';
          }
        }
        if (!ctx.annotate) return;
        const nodes = container.querySelectorAll('.node, .edgeLabel');
        nodes.forEach((g) => {
          ctx.annotate.register(g, {
            blockId,
            questionId: ctx.questionId,
            target: {
              kind: 'mermaid-node',
              nodeId: g.id || '',
              text: (g.textContent || '').trim().slice(0, 120),
            },
          });
        });
      };
      try {
        const ret = mermaid.render(id, code);
        if (ret && typeof ret.then === 'function') {
          ret.then((r) => onSvg(r.svg)).catch((err) => showMermaidErr(container, err));
        } else if (ret && ret.svg) {
          onSvg(ret.svg);
        } else if (typeof ret === 'string') {
          onSvg(ret);
        } else {
          // legacy callback signature: render(id, code, cb)
          mermaid.render(id, code, (svg) => onSvg(svg));
        }
      } catch (err) {
        showMermaidErr(container, err);
      }
    }).catch((err) => showMermaidErr(container, err));
  }

  // Live theme toggle: re-render mermaid diagrams with the new mermaid theme
  // and restyle existing charts' grid/tick/legend colors in place.
  function onThemeChange() {
    for (const entry of mermaidRegistry) {
      try {
        drawMermaid(entry);
      } catch {
        // keep the previous svg on failure
      }
    }
    const { grid, tick } = themeDefaults();
    for (const { chart } of chartRegistry) {
      try {
        const o = chart.options || {};
        if (o.plugins && o.plugins.legend && o.plugins.legend.labels) o.plugins.legend.labels.color = tick;
        if (o.plugins && o.plugins.title) o.plugins.title.color = tick;
        if (o.scales) {
          for (const k of Object.keys(o.scales)) {
            const ax = o.scales[k];
            if (!ax) continue;
            if (ax.grid) ax.grid.color = grid;
            if (ax.ticks) ax.ticks.color = tick;
          }
        }
        chart.update('none');
      } catch {
        // chart may already be destroyed
      }
    }
  }

  function showMermaidErr(container, err) {
    container.replaceChildren(
      el('div', { class: 'blk-error' }, 'Diagram error: ' + (err && err.message ? err.message : String(err)))
    );
  }

  // ---------- html (sandboxed iframe) ----------
  function renderHtml(block, ctx, blockId) {
    const height = clampHeight(block.height, 360);
    return el('iframe', {
      class: 'viz',
      'data-block-id': blockId,
      'data-question-id': ctx.questionId || '',
      src: ctx.htmlSrc(blockId),
      height: String(height),
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals',
      loading: 'lazy',
    });
  }

  // ---------- dispatch ----------
  function renderBlock(block, ctx) {
    const blockId = block.id;
    const wrapper = el('div', { class: 'blk blk-' + block.type, 'data-block-id': blockId });
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
        inner = renderCode(block);
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
      case 'html':
        inner = renderHtml(block, ctx, blockId);
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
    };
    for (const block of list) {
      if (!block || !block.type) continue;
      container.append(renderBlock(block, safeCtx));
    }
  }

  window.RelayBlocks = { render, onThemeChange };
})();
