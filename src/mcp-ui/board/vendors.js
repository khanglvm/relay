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
  function bytesOf(base64) {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // The preferred route: the host reads the vendor file as a ui:// resource.
  async function vendorFromResource(file) {
    const res = await request('resources/read', { uri: 'ui://relay/vendor/' + file });
    const c = res && Array.isArray(res.contents) ? res.contents[0] : null;
    return c ? (c.text || (c.blob ? new TextDecoder().decode(bytesOf(c.blob)) : '')) : '';
  }
  // For a host that refuses resources/read: the server hands the file over in
  // chunks. The chunks are joined as bytes before decoding, so a UTF-8 character
  // split across two chunks stays whole.
  async function vendorFromTool(file) {
    const parts = [];
    let count = 1;
    for (let i = 0; i < count; i++) {
      const chunk = await callServerTool('relay_asset', { name: file, index: i }, 60000);
      count = chunk.count;
      parts.push(bytesOf(chunk.data));
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    return new TextDecoder().decode(all);
  }
  // Where the server says a vendor file can also be fetched over HTTP, from relay_view.
  let vendorUrls = null;
  function vendorFromUrl(file) {
    return new Promise((resolve, reject) => {
      const url = vendorUrls && vendorUrls[file];
      if (!url) return reject(new Error('no url'));
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve('');
      s.onerror = () => reject(new Error('script failed'));
      document.head.appendChild(s);
    });
  }
  async function ensureVendor(file, globalName) {
    if (window[globalName]) return true;
    for (const load of [vendorFromResource, vendorFromTool, vendorFromUrl]) {
      try {
        const code = await load(file);
        if (!code) {
          if (window[globalName]) return true;
          continue;
        }
        const s = document.createElement('script');
        s.textContent = code;
        document.head.appendChild(s);
        if (window[globalName]) return true;
      } catch {
        // try the next route
      }
    }
    return false;
  }
  async function preloadVendors(spec) {
    const types = blockTypesIn(spec);
    const jobs = [];
    if (types.has('chart')) jobs.push(ensureVendor(...NEED.chart));
    if (types.has('mermaid')) jobs.push(ensureVendor(...NEED.mermaid));
    if (types.has('graphviz')) jobs.push(ensureVendor(...NEED.graphviz));
    if (jobs.length) await Promise.allSettled(jobs);
  }

  // The inline board uses a blob instead of fetching the document from /html/b/<id>.
  const htmlBlocks = new Map();
  function indexHtmlBlocks(spec) {
    htmlBlocks.clear();
    const add = (blocks) => {
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b && b.type === 'html' && typeof b.html === 'string') htmlBlocks.set(b.id, b);
      }
    };
    add(spec.blocks);
    for (const q of spec.questions || []) {
      add(q.blocks);
      for (const o of Array.isArray(q.options) ? q.options : []) if (o) add(o.blocks);
    }
  }
  function htmlBlobSrc(blockId) {
    const block = htmlBlocks.get(blockId);
    const body = block?.html ?? '';
    let doc;
    if (block?.isolated === true || /<html[\s>]/i.test(body)) {
      doc = body;
    } else {
      const dark = effectiveTheme() === 'dark';
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

