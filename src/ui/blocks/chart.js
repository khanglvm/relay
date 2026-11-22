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
    // axis/legend/title text: --fg-2 reads clearly on dark; --muted was too dim
    const tick = cssVar('--fg-2') || '#57534e';
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

  function renderChart(block, ctx, blockId) {
    const height = clampHeight(block.height, 320);
    const wrap = el('div', { class: 'blk-chart' });
    wrap.style.height = height + 'px';
    const stage = el('div', { class: 'blk-chart-stage' });
    const canvas = el('canvas');
    stage.append(canvas);
    wrap.append(stage);

    let chartInst = null;
    let chartBadges = [];
    let naturalSize = null;

    const openFor = (target) => (anchor) =>
      ctx.annotate.openExternal({ blockId, questionId: ctx.questionId, target }, anchor);
    function makeBadge(count, cls, onClick) {
      const b = el('span', { class: 'blk-chart-badge ' + cls }, String(count));
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onClick(b); });
      return b;
    }
    // Rebuild the chart's comment badges: one at each annotated DATA POINT
    // (positioned from the Chart.js element geometry) plus a top-right badge for
    // whole-chart comments. Each badge opens that comment's popover on click.
    // Runs on annotation change (onBadgeRefresh) and on chart (re)render/resize
    // (afterRender plugin), so badges stay pinned to their points.
    function syncChartBadges() {
      if (!ctx.annotate) return;
      for (const b of chartBadges) b.remove();
      chartBadges = [];
      const groups = new Map(); // "di:index" -> { target, count }
      let blockCount = 0, blockTarget = null;
      for (const a of ctx.annotate.list()) {
        if (a.blockId !== blockId) continue;
        const t = a.target || {};
        if (t.kind === 'chart-element' && typeof t.datasetIndex === 'number' && typeof t.index === 'number') {
          const k = t.datasetIndex + ':' + t.index;
          const g = groups.get(k) || { target: t, count: 0 };
          g.count++; groups.set(k, g);
        } else {
          blockCount++; blockTarget = blockTarget || t;
        }
      }
      if (chartInst) {
        for (const { target, count } of groups.values()) {
          let elem;
          try { const m = chartInst.getDatasetMeta(target.datasetIndex); elem = m && m.data[target.index]; } catch (_) {}
          if (!elem) continue;
          let pos; try { pos = elem.tooltipPosition(); } catch (_) { pos = { x: elem.x, y: elem.y }; }
          if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
          const badge = makeBadge(count, 'blk-chart-badge-pt', openFor(target));
          badge.style.left = (canvas.offsetLeft + pos.x) + 'px';
          badge.style.top = (canvas.offsetTop + pos.y) + 'px';
          stage.append(badge);
          chartBadges.push(badge);
        }
      }
      if (blockCount > 0) {
        const badge = makeBadge(blockCount, 'blk-chart-badge-corner', openFor(blockTarget || { kind: 'block', label: 'chart' }));
        wrap.append(badge);
        chartBadges.push(badge);
      }
    }

    if (ctx.annotate && ctx.annotate.onBadgeRefresh) ctx.annotate.onBadgeRefresh(syncChartBadges);
    loadChart().then((Chart) => {
      let config = block.config
        ? JSON.parse(JSON.stringify(block.config))
        : simplifiedToConfig(block, ctx);
      config = applyChartTheme(config, ctx);
      // reposition our DOM badges after every (re)render/resize of the chart
      config.plugins = Array.isArray(config.plugins) ? config.plugins : [];
      config.plugins.push({ id: 'relayChartBadges', afterRender: () => syncChartBadges() });
      try {
        chartInst = new Chart(canvas.getContext('2d'), config);
        chartRegistry.push({ chart: chartInst });
        // Chart.js stays responsive inside a stage whose dimensions the shared
        // viewer controls. This gives charts the same bounded, eased wheel zoom
        // as diagrams/images while retaining sharp redraws at every scale.
        naturalSize = {
          w: Math.max(1, Math.round(stage.getBoundingClientRect().width || wrap.clientWidth || 640)),
          h: height,
        };
        attachViewer(wrap, {
          zoomEl: stage,
          natural: () => naturalSize,
          fluidFit: true,
          scaleHeight: true,
          label: 'chart',
          comment: wholeBlockComment(ctx, blockId, 'chart'),
        });
      } catch (err) {
        wrap.replaceChildren(el('div', { class: 'blk-error' }, 'Chart error: ' + (err && err.message ? err.message : String(err))));
        return;
      }
      // hover -> pointer cursor on a hit
      canvas.addEventListener('mousemove', (e) => {
        if (ctx.canComment === false) { canvas.style.cursor = 'default'; return; }
        const hits = chartInst.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
        canvas.style.cursor = hits.length ? 'pointer' : 'default';
      });
      canvas.addEventListener('click', (e) => {
        if (!ctx.annotate || ctx.canComment === false) return;
        const hits = chartInst.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
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
      syncChartBadges();
    }).catch((err) => {
      wrap.replaceChildren(el('div', { class: 'blk-error' }, 'Chart error: ' + (err && err.message ? err.message : String(err))));
    });

    return wrap;
  }

