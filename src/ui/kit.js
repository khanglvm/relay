/**
 * relay kit.js — loaded INSIDE sandboxed custom-HTML iframes via <script src="/kit.js">.
 * NO access to the parent DOM (sandbox without allow-same-origin) — only postMessage.
 *
 * Public API (window.relayKit and window.kit):
 *
 *   relayKit.theme
 *     Parsed from ?theme=light|dark in location.search.
 *     { mode: 'light'|'dark',
 *       colors: { bg, card, fg, fg2, muted, accent, accentSoft, border, danger, ok } }
 *
 *   relayKit.applyBaseStyles()
 *     Injects <style> into document.head setting body font/bg/color from current theme.
 *
 *   relayKit.chart(el, cfgOrSimple, opts?) -> Promise<ChartInstance>
 *     Lazy-loads /vendor/chart.umd.js (cached).
 *     Accepts either a full Chart.js config object OR the simplified relay shape:
 *       { kind, labels, series:[{label,data,color?}], title?, height? }
 *     Creates a <canvas> inside el. opts.height overrides height (default 300).
 *     Returns Promise resolving to the Chart instance.
 *
 *   relayKit.mermaid(el, code) -> Promise<SVGElement>
 *     Lazy-loads /vendor/mermaid.min.js (cached).
 *     Theme: dark mode -> 'dark', light -> 'neutral'. securityLevel 'strict'.
 *     Renders svg into el. On error renders muted error text inside el.
 *     Returns Promise resolving to the svg element.
 *
 *   relayKit.table(el, { columns, rows, sortable? })
 *     Normalizes and renders an HTML table inside el.
 *     columns: string[] | [{key,label,align?}]
 *     rows: any[][] | object[]
 *     sortable: click column header to sort ascending/descending.
 *
 *   relayKit.commentable(el, label, detail?)
 *     Hover: 1px dashed accent outline + cursor pointer + title "add a comment".
 *     Click: parent.postMessage({relay:'annotate-request', label, detail}, '*').
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  const COLORS = {
    light: {
      bg: '#fcfbf9',
      card: '#ffffff',
      fg: '#1c1b19',
      fg2: '#57534e',
      muted: '#8a8580',
      accent: '#c2674b',
      accentSoft: '#f5e9e3',
      border: '#ece9e4',
      danger: '#bc4434',
      ok: '#4d8a66',
    },
    dark: {
      bg: '#201e1c',
      card: '#282624',
      fg: '#edeae4',
      fg2: '#beb9b0',
      muted: '#a29c93',
      accent: '#d08159',
      accentSoft: '#3b2e26',
      border: '#393632',
      danger: '#e06c57',
      ok: '#6fbf92',
    },
  };

  const CHART_PALETTE = {
    light: ['#c2674b', '#4d8a66', '#5a7ca8', '#b9913f', '#8a6da3', '#57534e'],
    dark:  ['#d08159', '#6fbf92', '#7a9dc8', '#d4aa5f', '#a98dc3', '#a29c93'],
  };

  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  function parseThemeMode() {
    try {
      const params = new URLSearchParams(location.search);
      const t = params.get('theme');
      if (t === 'dark') return 'dark';
      if (t === 'light') return 'light';
    } catch (_) {}
    return 'light';
  }

  const mode = parseThemeMode();

  const theme = {
    mode,
    colors: COLORS[mode],
  };

  function applyBaseStyles() {
    try {
      const c = theme.colors;
      const style = document.createElement('style');
      style.textContent = [
        `body {`,
        `  background: ${c.bg};`,
        `  color: ${c.fg};`,
        `  font: 16px/1.6 ${SANS};`,
        `  -webkit-font-smoothing: antialiased;`,
        `  margin: 0; padding: 8px;`,
        `  box-sizing: border-box;`,
        `}`,
        `*, *::before, *::after { box-sizing: inherit; }`,
      ].join('\n');
      document.head.appendChild(style);
    } catch (err) {
      console.warn('[relayKit] applyBaseStyles error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Lazy vendor loader
  // ---------------------------------------------------------------------------

  const _scriptCache = {};

  function loadScript(src) {
    if (_scriptCache[src]) return _scriptCache[src];
    _scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
    return _scriptCache[src];
  }

  // ---------------------------------------------------------------------------
  // chart()
  // ---------------------------------------------------------------------------

  function normalizeChartConfig(cfgOrSimple) {
    // If it already looks like a full Chart.js config (has .type), pass through
    if (cfgOrSimple && cfgOrSimple.type && cfgOrSimple.data) {
      return cfgOrSimple;
    }
    // Simplified relay shape
    const s = cfgOrSimple || {};
    const kind = s.kind || 'bar';
    const palette = CHART_PALETTE[mode];
    const datasets = (s.series || []).map((serie, i) => ({
      label: serie.label || '',
      data: serie.data || [],
      backgroundColor: serie.color || palette[i % palette.length],
      borderColor: serie.color || palette[i % palette.length],
      borderWidth: kind === 'line' ? 2 : 0,
      fill: false,
      tension: 0.3,
    }));
    const cfg = {
      type: kind,
      data: {
        labels: s.labels || [],
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: theme.colors.fg, font: { family: SANS } } },
          title: s.title
            ? { display: true, text: s.title, color: theme.colors.fg, font: { family: SANS, size: 14 } }
            : { display: false },
        },
        scales: {},
      },
    };
    // Add scale colors for cartesian charts
    if (['bar', 'line', 'scatter'].includes(kind)) {
      cfg.options.scales = {
        x: { ticks: { color: theme.colors.muted }, grid: { color: theme.colors.border } },
        y: { ticks: { color: theme.colors.muted }, grid: { color: theme.colors.border } },
      };
    }
    return cfg;
  }

  async function chart(el, cfgOrSimple, opts) {
    try {
      await loadScript('/vendor/chart.umd.js');
      const Chart = window.Chart;
      if (!Chart) throw new Error('Chart.js did not expose window.Chart');

      const height = (opts && opts.height) || (cfgOrSimple && cfgOrSimple.height) || 300;
      const clampedHeight = Math.min(Math.max(Number(height) || 300, 100), 2400);

      // Create canvas
      el.innerHTML = '';
      el.style.position = 'relative';
      el.style.height = clampedHeight + 'px';
      const canvas = document.createElement('canvas');
      el.appendChild(canvas);

      const config = normalizeChartConfig(cfgOrSimple);
      return new Chart(canvas, config);
    } catch (err) {
      console.warn('[relayKit] chart error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // mermaid()
  // ---------------------------------------------------------------------------

  let _mermaidReady = false;

  async function mermaid(el, code) {
    try {
      await loadScript('/vendor/mermaid.min.js');
      const m = window.mermaid;
      if (!m) throw new Error('mermaid did not expose window.mermaid');

      if (!_mermaidReady) {
        m.initialize({
          startOnLoad: false,
          theme: mode === 'dark' ? 'dark' : 'neutral',
          securityLevel: 'strict',
        });
        _mermaidReady = true;
      }

      el.innerHTML = '';
      const id = 'kit-mermaid-' + Math.random().toString(36).slice(2);
      let svgHtml;
      try {
        const result = await m.render(id, code);
        svgHtml = typeof result === 'object' ? result.svg : result;
      } catch (renderErr) {
        el.style.color = theme.colors.muted;
        el.style.fontSize = '0.85rem';
        el.style.padding = '8px';
        el.textContent = 'Diagram error: ' + renderErr.message;
        console.warn('[relayKit] mermaid render error:', renderErr);
        return null;
      }
      el.innerHTML = svgHtml;
      el.style.maxHeight = '1200px';
      el.style.overflow = 'auto';
      return el.querySelector('svg');
    } catch (err) {
      console.warn('[relayKit] mermaid error:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // table()
  // ---------------------------------------------------------------------------

  function table(el, opts) {
    try {
      const { columns = [], rows = [], sortable = false } = opts || {};

      // Normalize columns -> [{key, label, align}]
      const cols = columns.map((c, i) => {
        if (typeof c === 'string') return { key: String(i), label: c, align: 'left' };
        return { key: c.key || String(i), label: c.label || c.key || '', align: c.align || 'left' };
      });

      // Normalize rows -> string[][]
      function normalizeRow(r) {
        if (Array.isArray(r)) return r.map(v => (v == null ? '' : String(v)));
        return cols.map(c => {
          const v = r[c.key];
          return v == null ? '' : String(v);
        });
      }

      let data = rows.map(normalizeRow);

      const c = theme.colors;

      // Build table HTML
      function buildTable(data) {
        const tableEl = document.createElement('table');
        tableEl.style.cssText = [
          'width:100%', 'border-collapse:collapse',
          `font-family:${SANS}`, 'font-size:0.9rem',
          `color:${c.fg}`,
        ].join(';');

        // Header
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        cols.forEach((col, ci) => {
          const th = document.createElement('th');
          th.textContent = col.label;
          th.style.cssText = [
            `text-align:${col.align}`,
            `padding:8px 12px`,
            `border-bottom:1px solid ${c.border}`,
            `color:${c.muted}`,
            'font-size:0.78rem',
            'letter-spacing:0.06em',
            'text-transform:uppercase',
            'font-weight:600',
          ].join(';');
          if (sortable) {
            th.style.cursor = 'pointer';
            th.title = 'Sort';
            let dir = 0;
            th.addEventListener('click', () => {
              dir = dir === 1 ? -1 : 1;
              data.sort((a, b) => {
                const av = a[ci] || '', bv = b[ci] || '';
                const an = parseFloat(av), bn = parseFloat(bv);
                if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
                return av.localeCompare(bv) * dir;
              });
              rebuildBody(data);
            });
          }
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        tableEl.appendChild(thead);

        const tbody = document.createElement('tbody');
        tableEl.appendChild(tbody);

        function rebuildBody(rows) {
          tbody.innerHTML = '';
          rows.forEach((row, ri) => {
            const tr = document.createElement('tr');
            tr.style.background = ri % 2 === 0 ? 'transparent' : (mode === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)');
            row.forEach((cell, ci) => {
              const td = document.createElement('td');
              td.textContent = cell;
              td.style.cssText = [
                `text-align:${cols[ci].align}`,
                'padding:8px 12px',
                `border-bottom:1px solid ${c.border}`,
              ].join(';');
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
        }

        rebuildBody(data);
        return tableEl;
      }

      el.innerHTML = '';
      el.appendChild(buildTable(data));
    } catch (err) {
      console.warn('[relayKit] table error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // commentable()
  // ---------------------------------------------------------------------------

  function commentable(el, label, detail) {
    try {
      const lStr = String(label || '').slice(0, 200);
      const dStr = detail != null ? String(detail).slice(0, 500) : undefined;
      const accent = theme.colors.accent;

      el.style.cursor = 'pointer';
      el.title = 'add a comment';

      el.addEventListener('mouseenter', () => {
        el.style.outline = `1px dashed ${accent}`;
        el.style.outlineOffset = '2px';
      });
      el.addEventListener('mouseleave', () => {
        el.style.outline = '';
        el.style.outlineOffset = '';
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const msg = { relay: 'annotate-request', label: lStr };
        if (dStr !== undefined) msg.detail = dStr;
        try {
          parent.postMessage(msg, '*');
        } catch (postErr) {
          console.warn('[relayKit] commentable postMessage error:', postErr);
        }
      });
    } catch (err) {
      console.warn('[relayKit] commentable error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Expose global
  // ---------------------------------------------------------------------------

  const relayKit = {
    theme,
    applyBaseStyles,
    chart,
    mermaid,
    table,
    commentable,
  };

  window.relayKit = relayKit;
  if (typeof window.kit === 'undefined') {
    window.kit = relayKit;
  }

})();
