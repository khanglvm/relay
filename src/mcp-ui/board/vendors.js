  // ======================================================================
  // vendored libraries pulled through the host bridge (resources/read)
  // ----------------------------------------------------------------------
  // blocks.js lazy-loads Chart.js / Mermaid / Viz.js via <script src="/vendor/…">
  // and short-circuits when the global already exists. There's no server here,
  // so we fetch the vendor source over the bridge and define the global up
  // front; blocks.js then never reaches for the (absent) /vendor route.
  const NEED = { chart: ['chart.umd.js', 'Chart'], mermaid: ['mermaid.min.js', 'mermaid'], graphviz: ['viz-standalone.js', 'Viz'] };
  function blockTypesIn(spec) {
    const types = new Set();
    const scan = (blocks) => {
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b && b.type) types.add(b.type);
        if (b && Array.isArray(b.blocks)) scan(b.blocks);
      }
    };
    scan(spec.blocks);
    for (const q of spec.questions || []) {
      scan(q.blocks);
      for (const o of Array.isArray(q.options) ? q.options : []) if (o) scan(o.blocks);
    }
    return types;
  }
  async function ensureVendor(file, globalName) {
    if (window[globalName]) return true;
    try {
      const res = await request('resources/read', { uri: 'ui://relay/vendor/' + file });
      const c = res && Array.isArray(res.contents) ? res.contents[0] : null;
      const code = c && (c.text || (c.blob ? atob(c.blob) : ''));
      if (!code) return false;
      const s = document.createElement('script');
      s.textContent = code;
      document.head.appendChild(s);
      return Boolean(window[globalName]);
    } catch {
      return false;
    }
  }
  async function preloadVendors(spec) {
    const types = blockTypesIn(spec);
    const jobs = [];
    if (types.has('chart')) jobs.push(ensureVendor(...NEED.chart));
    if (types.has('mermaid')) jobs.push(ensureVendor(...NEED.mermaid));
    if (types.has('graphviz')) jobs.push(ensureVendor(...NEED.graphviz));
    if (jobs.length) await Promise.allSettled(jobs);
  }

  // html blocks: the browser board serves each in its own iframe from
  // /html/b/<id>. Here we wrap the body into a self-contained document and hand
  // blocks.js a blob: URL for the iframe src (same sandbox, no server needed).
  const htmlBodies = new Map();
  function indexHtmlBlocks(spec) {
    const add = (blocks) => {
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b && b.type === 'html' && typeof b.html === 'string') htmlBodies.set(b.id, b.html);
      }
    };
    add(spec.blocks);
    for (const q of spec.questions || []) {
      add(q.blocks);
      for (const o of Array.isArray(q.options) ? q.options : []) if (o) add(o.blocks);
    }
  }
  function htmlBlobSrc(blockId) {
    const body = htmlBodies.get(blockId) || '';
    const dark = effectiveTheme() === 'dark';
    let doc;
    if (/<html[\s>]/i.test(body)) {
      doc = body;
    } else {
      const bg = dark ? '#282624' : '#ffffff';
      const fg = dark ? '#edeae4' : '#1c1b19';
      doc =
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<style>:root{color-scheme:' + (dark ? 'dark' : 'light') + '}' +
        'body{margin:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;' +
        'background:' + bg + ';color:' + fg + '}</style></head><body>' + body + '</body></html>';
    }
    try {
      return URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    } catch {
      return 'data:text/html;charset=utf-8,' + encodeURIComponent(doc);
    }
  }

