  // ---------- plantuml (server-rendered; client deflate-raw + base64 variant) ----------
  const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

  // PlantUML's base64 variant: 3 bytes -> 4 chars using PLANTUML_ALPHABET.
  function encode64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b1 = bytes[i];
      const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += PLANTUML_ALPHABET[b1 >> 2];
      out += PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)];
      if (i + 1 < bytes.length) out += PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)];
      if (i + 2 < bytes.length) out += PLANTUML_ALPHABET[b3 & 0x3f];
    }
    return out;
  }

  async function encodePlantUml(code) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('CompressionStream unavailable');
    }
    const bytes = new TextEncoder().encode(String(code));
    const blob = new Blob([bytes]);
    const compressed = await new Response(
      blob.stream().pipeThrough(new CompressionStream('deflate-raw'))
    ).arrayBuffer();
    return encode64(new Uint8Array(compressed));
  }

  // Fetch a remote SVG and return a sanitized inline <svg> element, so its parts
  // become annotatable. Rejects on network/CORS failure (caller falls back to an
  // <img>). The SVG is sanitized — it comes from a remote, author-set server, so
  // strip scripts / foreignObject / on* handlers / javascript: links before it
  // ever touches the document.
  function fetchInlineSvg(url) {
    return fetch(url, { credentials: 'omit', mode: 'cors' })
      .then((r) => {
        if (!r.ok) throw new Error('http ' + r.status);
        // only trust a declared SVG/XML payload; anything else → <img> fallback
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct && !ct.includes('svg') && !ct.includes('xml')) throw new Error('not svg: ' + ct);
        return r.text();
      })
      .then((text) => {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('bad svg');
        const svg = doc.querySelector('svg');
        if (!svg) throw new Error('no svg');
        sanitizeSvg(svg);
        return document.importNode(svg, true);
      });
  }

  // The SVG comes from a remote, author-set server, so strip everything active
  // or capable of fetching an external resource before it touches the document.
  // Script execution is already impossible here (DOMParser doesn't run scripts;
  // importNode+appendChild never starts an SVG <script>), but we still drop
  // <script>/<foreignObject>/<style>, on* handlers, non-fragment href/xlink:href
  // (<use>/<image>/<a>), and any url(...) that doesn't point at a #fragment —
  // those are client-side SSRF / beacon vectors and there is no CSP backstop.
  function sanitizeSvg(root) {
    root.querySelectorAll('script, foreignObject, style').forEach((n) => n.remove());
    const walk = (n) => {
      if (n.nodeType === 1) {
        for (const attr of Array.from(n.attributes)) {
          const name = attr.name.toLowerCase();
          const val = (attr.value || '').replace(/\s+/g, '').toLowerCase();
          const isHref = name === 'href' || name.endsWith(':href');
          if (
            name.startsWith('on') ||                 // event handlers
            (isHref && !val.startsWith('#')) ||       // only same-document fragment refs
            /url\((?!['"]?#)/.test(val)               // url() to anything but a #fragment
          ) {
            n.removeAttribute(attr.name);
          }
        }
      }
      n.childNodes.forEach(walk);
    };
    walk(root);
  }

  function renderPlantuml(block, ctx, blockId) {
    const container = el('div', { class: 'blk-plantuml' });
    const fail = () =>
      container.replaceChildren(
        el('div', { class: 'blk-error' }, 'PlantUML needs network access and a modern browser')
      );
    encodePlantUml(block.code || '')
      .then((encoded) => {
        const server = block.server || 'https://www.plantuml.com/plantuml';
        const url = server + '/svg/' + encoded;
        // Prefer inline SVG (per-element annotation); fall back to an opaque
        // <img> if the server blocks cross-origin fetch or anything fails.
        fetchInlineSvg(url)
          .then((svg) => mountPlantumlSvg(container, svg, block, ctx, blockId))
          .catch(() => mountPlantumlImg(container, url, fail, block, ctx, blockId));
      })
      .catch(fail);
    return container;
  }

  function mountPlantumlSvg(container, svg, block, ctx, blockId) {
    if (block.height != null) container.style.maxHeight = clampHeight(block.height, 1200) + 'px';
    sizeDiagramSvg(svg);
    container.replaceChildren(svg);
    attachViewer(container, {
      zoomEl: svg,
      natural: svgNatural(svg),
      label: 'diagram',
      comment: wholeBlockComment(ctx, blockId, 'diagram'),
    });
    if (!ctx.annotate) return;
    // register the text labels as annotation targets (participant boxes, message
    // labels, …) — the meaningful, clickable parts of a PlantUML diagram.
    // `idx` disambiguates: PlantUML repeats participant labels top AND bottom,
    // so without a unique key one comment would badge BOTH identical-text nodes.
    svg.querySelectorAll('text').forEach((t, idx) => {
      const text = (t.textContent || '').trim();
      if (!text) return;
      ctx.annotate.register(t, {
        blockId,
        questionId: ctx.questionId,
        target: { kind: 'plantuml-node', idx, text: text.slice(0, 120) },
      });
    });
  }

  function mountPlantumlImg(container, url, fail, block, ctx, blockId) {
    const img = el('img', { class: 'blk-plantuml-img', src: url, alt: 'PlantUML diagram', loading: 'lazy' });
    if (block.height != null) img.style.height = clampHeight(block.height, 360) + 'px';
    img.addEventListener('error', fail);
    container.replaceChildren(img);
    const attachImgViewer = () =>
      attachViewer(container, {
        zoomEl: img,
        natural: () => (img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null),
        label: 'diagram',
        comment: wholeBlockComment(ctx, blockId, 'diagram'),
      });
    if (img.complete && img.naturalWidth > 0) attachImgViewer();
    else img.addEventListener('load', attachImgViewer, { once: true });
    if (ctx.annotate) {
      ctx.annotate.register(img, {
        blockId,
        questionId: ctx.questionId,
        target: { kind: 'image', label: 'PlantUML diagram' },
      });
    }
  }

