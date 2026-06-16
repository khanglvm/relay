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
 *     Make one element commentable: hover shows a comment pin, a per-element
 *     badge counts comments, click opens the board's annotation popover anchored
 *     to the element. Thin shim over relayKit.annotate.register().
 *
 *   relayKit.annotate.auto()
 *     Injected automatically by the server into every custom-HTML iframe. With no
 *     explicit signals it makes a sensible set of content/interactive elements
 *     hover-commentable so the user can annotate ANY meaningful part of the HTML.
 *     If the author marks elements with data-relay-annotate[="Label"] (+ optional
 *     data-relay-detail) or calls commentable(), auto-mode backs off to just those.
 *     Opt out with data-relay-annotate="off" on <html> or <body>.
 */

(function () {
  'use strict';

  // Idempotent: the server may inject a /kit.js load on top of one the author
  // already added. First load wins; a second execution no-ops.
  if (window.relayKit) return;

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
  // annotate — element-level commenting inside the sandboxed iframe
  // ---------------------------------------------------------------------------
  // The board's annotation engine lives in the PARENT page and can't reach into
  // this cross-origin iframe (sandbox without allow-same-origin), so everything
  // here runs iframe-side and talks to the parent over postMessage:
  //   iframe → parent  {relay:'annotate-ready'}                     request counts
  //   iframe → parent  {relay:'annotate-request', ref, label, detail?, rect}
  //   parent → iframe  {relay:'annotate-counts', counts:{ref:n}}    draw badges
  //
  // `ref` is a compact, reload-stable CSS path used as the element's identity so
  // comments re-bind and badges count per element.

  const annotate = (() => {
    // Auto-mode picks anything the user would plausibly point at: every element
    // with its OWN direct text (so div/span-based mockups work, not just
    // semantic tags), plus meaningful leaves (icons, buttons, media) and a few
    // semantic containers worth commenting whole. closest() resolves overlaps to
    // the innermost target on hover.
    const LEAF_TAGS = /^(IMG|BUTTON|A|INPUT|SELECT|TEXTAREA|svg|VIDEO|CANVAS|SUMMARY)$/;
    const SKIP_TAGS = /^(SCRIPT|STYLE|HEAD|META|LINK|TITLE|BASE|NOSCRIPT|TEMPLATE)$/;
    const CONTAINER_SELECTOR =
      'li,td,th,figure,blockquote,article,.card,[role="button"],[role="listitem"],[role="option"]';
    const MAX_AUTO = 400;
    // Replaced elements that can't host a badge child — overlay the badge instead.
    const NO_CHILD = /^(IMG|INPUT|HR|BR|EMBED|CANVAS|VIDEO|svg)$/;

    const byRef = new Map(); // ref -> element
    let mode = null;         // 'auto' | 'explicit' (decided on first scan)
    let started = false;
    let hot = null;          // currently outlined element
    let pin = null;          // floating pin button
    let hideTimer = 0;
    let lastCounts = {};
    let overlayBadges = [];  // [{el, badge}] for replaced elements
    let repoTimer = 0;

    const accent = () => theme.colors.accent;

    // Compact, reload-stable CSS path — the element's identity.
    function refOf(el) {
      if (el.__relayRef) return el.__relayRef;
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1 && n !== document.body && parts.length < 10) {
        let seg = n.tagName.toLowerCase();
        const p = n.parentNode;
        if (p && p.children) {
          const sibs = Array.prototype.filter.call(p.children, (c) => c.tagName === n.tagName);
          if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
        }
        parts.unshift(seg);
        n = p;
      }
      const ref = parts.join('>') || el.tagName.toLowerCase();
      el.__relayRef = ref;
      return ref;
    }

    // Human label when the author didn't supply one.
    function labelOf(el) {
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return aria.trim().slice(0, 80) || el.tagName.toLowerCase();
      if (el.tagName === 'IMG') return (el.getAttribute('alt') || 'Image').trim().slice(0, 80) || 'Image';
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return txt ? txt.slice(0, 80) : el.tagName.toLowerCase();
    }

    function injectStyle() {
      if (document.getElementById('relay-ann-style')) return;
      const s = document.createElement('style');
      s.id = 'relay-ann-style';
      s.textContent = [
        '.relay-ann-hot{outline:2px solid ' + accent() + ' !important;outline-offset:1px !important;}',
        '.relay-ann-badge{position:absolute;top:-7px;right:-7px;min-width:16px;height:16px;padding:0 4px;' +
          'box-sizing:border-box;border-radius:9px;background:' + accent() + ';color:#fff;font:600 10px/16px ' + SANS + ';' +
          'text-align:center;z-index:2147483646;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.25);}',
      ].join('\n');
      (document.head || document.documentElement).appendChild(s);
    }

    function ensurePin() {
      if (pin || !document.body) return pin;
      pin = document.createElement('button');
      pin.type = 'button';
      pin.setAttribute('aria-label', 'Add a comment');
      pin.title = 'Add a comment';
      pin.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'display:none', 'width:22px', 'height:22px',
        'padding:0', 'border:none', 'border-radius:50%', 'cursor:pointer', 'background:' + accent(),
        'color:#fff', 'align-items:center', 'justify-content:center', 'line-height:0',
        'box-shadow:0 1px 4px rgba(0,0,0,.3)',
      ].join(';');
      pin.innerHTML =
        '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
        '<path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v5a1.5 1.5 0 0 1-1.5 1.5H8.4L5 13.4v-2.9H3A1.5 1.5 0 0 1 1.5 9V4A1.5 1.5 0 0 1 3 2.5Z" fill="currentColor"/></svg>';
      pin.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      pin.addEventListener('mouseleave', scheduleHide);
      pin.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (hot) request(hot);
        hidePin();
      });
      document.body.appendChild(pin);
      return pin;
    }

    function showPinFor(el) {
      if (!ensurePin()) return;
      clearTimeout(hideTimer);
      if (hot && hot !== el) hot.classList.remove('relay-ann-hot');
      hot = el;
      el.classList.add('relay-ann-hot');
      const r = el.getBoundingClientRect();
      const w = 22;
      pin.style.display = 'flex';
      pin.style.left = Math.max(2, Math.min(r.right - w / 2, window.innerWidth - w - 2)) + 'px';
      pin.style.top = Math.max(2, Math.min(r.top - w / 2, window.innerHeight - w - 2)) + 'px';
    }

    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hidePin, 220); // grace so the pin itself stays clickable
    }

    function hidePin() {
      clearTimeout(hideTimer);
      if (hot) hot.classList.remove('relay-ann-hot');
      hot = null;
      if (pin) pin.style.display = 'none';
    }

    // Ask the parent to open its annotation popover for this element.
    function request(el) {
      const r = el.getBoundingClientRect();
      const msg = {
        relay: 'annotate-request',
        ref: refOf(el),
        label: String(el.__relayLabel || labelOf(el)).slice(0, 200),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
      if (el.__relayDetail != null) msg.detail = String(el.__relayDetail).slice(0, 500);
      try { parent.postMessage(msg, '*'); } catch (_) {}
    }

    function positionOverlay(el, badge) {
      const r = el.getBoundingClientRect();
      badge.style.left = (r.right + window.scrollX - 9) + 'px';
      badge.style.top = (r.top + window.scrollY - 7) + 'px';
      badge.style.right = 'auto';
    }

    function repositionOverlays() {
      for (const o of overlayBadges) if (o.el.isConnected) positionOverlay(o.el, o.badge);
    }

    function renderBadges(counts) {
      lastCounts = counts || {};
      for (const b of document.querySelectorAll('.relay-ann-badge')) b.remove();
      overlayBadges = [];
      for (const ref of Object.keys(lastCounts)) {
        const n = lastCounts[ref];
        if (!n) continue;
        const el = byRef.get(ref);
        if (!el || !el.isConnected) continue;
        const badge = document.createElement('span');
        badge.className = 'relay-ann-badge';
        badge.textContent = String(n);
        badge.title = n + (n === 1 ? ' comment' : ' comments');
        badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); request(el); });
        if (NO_CHILD.test(el.tagName)) {
          badge.style.position = 'absolute';
          document.body.appendChild(badge);
          overlayBadges.push({ el, badge });
          positionOverlay(el, badge);
        } else {
          if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
          el.appendChild(badge);
        }
      }
    }

    function add(el, label, detail) {
      if (!el || el.nodeType !== 1) return;
      byRef.set(refOf(el), el);
      el.classList.add('relay-annotatable');
      if (label != null && label !== '') el.__relayLabel = String(label);
      if (detail != null) el.__relayDetail = detail;
    }

    // True when the element holds non-whitespace text of its OWN (a direct text
    // node), not just text inherited from descendants.
    function hasDirectText(el) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
      }
      return false;
    }

    function autoPick() {
      let all;
      try { all = document.body.querySelectorAll('*'); } catch (_) { return []; }
      let containers;
      try { containers = new Set(document.querySelectorAll(CONTAINER_SELECTOR)); } catch (_) { containers = new Set(); }
      const out = [];
      for (const el of all) {
        if (out.length >= MAX_AUTO) break;
        if (SKIP_TAGS.test(el.tagName)) continue;
        if (pin && pin.contains(el)) continue;             // our own pin
        if (el.classList && el.classList.contains('relay-ann-badge')) continue;
        if (LEAF_TAGS.test(el.tagName) || containers.has(el) || hasDirectText(el)) out.push(el);
      }
      return out;
    }

    function scan() {
      const signalled = Array.prototype.filter.call(
        document.querySelectorAll('[data-relay-annotate]'),
        (el) => el.getAttribute('data-relay-annotate') !== 'off'
      );
      // ANY explicit signal (attribute or a prior commentable() call) → the
      // author scopes what's annotatable; auto-mode stays off.
      if (mode === null) mode = signalled.length > 0 || byRef.size > 0 ? 'explicit' : 'auto';
      if (mode === 'explicit') {
        for (const el of signalled) add(el, el.getAttribute('data-relay-annotate') || null, el.getAttribute('data-relay-detail'));
        return;
      }
      for (const el of autoPick()) add(el, null, undefined);
    }

    function optedOut() {
      const v = (document.body && document.body.getAttribute('data-relay-annotate')) ||
        document.documentElement.getAttribute('data-relay-annotate');
      return v === 'off';
    }

    function announce() {
      try { parent.postMessage({ relay: 'annotate-ready' }, '*'); } catch (_) {}
    }

    function start() {
      if (started) return;
      if (!document.body) { document.addEventListener('DOMContentLoaded', start, { once: true }); return; }
      started = true;
      injectStyle();
      ensurePin();
      // Delegated hover — closest() resolves nested targets to the innermost.
      document.addEventListener('mouseover', (e) => {
        const t = e.target && e.target.closest && e.target.closest('.relay-annotatable');
        if (t) showPinFor(t);
      }, true);
      document.addEventListener('mouseout', (e) => {
        const t = e.target && e.target.closest && e.target.closest('.relay-annotatable');
        if (t) scheduleHide();
      }, true);
      window.addEventListener('scroll', () => {
        hidePin();
        if (overlayBadges.length) { cancelAnimationFrame(repoTimer); repoTimer = requestAnimationFrame(repositionOverlays); }
      }, true);
      window.addEventListener('resize', () => { hidePin(); repositionOverlays(); });
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (m && typeof m === 'object' && m.relay === 'annotate-counts') renderBadges(m.counts || {});
      });
      // Re-pick up DOM that author JS builds after load. We observe childList
      // only (not attributes, so our own hover-class toggles don't fire it) and
      // ignore mutations that only touch our own pin/badge nodes — otherwise
      // rendering a badge would re-trigger the observer in a tight loop.
      try {
        const ours = (n) =>
          n.nodeType === 1 &&
          (n === pin || (pin && pin.contains(n)) || n.id === 'relay-ann-style' ||
            (n.classList && n.classList.contains('relay-ann-badge')));
        const mo = new MutationObserver((muts) => {
          let relevant = false;
          for (const m of muts) {
            for (const n of m.addedNodes) if (!ours(n)) { relevant = true; break; }
            if (relevant) break;
            for (const n of m.removedNodes) if (!ours(n)) { relevant = true; break; }
            if (relevant) break;
          }
          if (!relevant) return;
          clearTimeout(mo._t);
          mo._t = setTimeout(() => { scan(); renderBadges(lastCounts); announce(); }, 250);
        });
        mo.observe(document.body, { childList: true, subtree: true });
      } catch (_) {}
      announce();
    }

    // Server-injected entrypoint. Idempotent.
    function auto() {
      try {
        if (optedOut()) return;
        if (!document.body) { document.addEventListener('DOMContentLoaded', auto, { once: true }); return; }
        scan();
        start();
      } catch (err) {
        console.warn('[relayKit] annotate.auto error:', err);
      }
    }

    // Explicit per-element registration (also used by commentable()).
    function register(el, label, detail) {
      try {
        add(el, label, detail);
        if (started) renderBadges(lastCounts);
        else start();
      } catch (err) {
        console.warn('[relayKit] annotate.register error:', err);
      }
    }

    return { auto, register };
  })();

  // ---------------------------------------------------------------------------
  // commentable() — back-compat shim over annotate.register()
  // ---------------------------------------------------------------------------

  function commentable(el, label, detail) {
    if (!el) return;
    annotate.register(
      el,
      label != null ? String(label).slice(0, 200) : null,
      detail != null ? String(detail).slice(0, 500) : undefined
    );
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
    annotate,
  };

  window.relayKit = relayKit;
  if (typeof window.kit === 'undefined') {
    window.kit = relayKit;
  }

})();
