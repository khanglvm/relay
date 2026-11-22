  // ---------- text-selection highlights ----------
  // Re-locate a saved text quote inside a root using its prefix/suffix anchors,
  // returning a live Range (or null when the text can't be found anymore).
  function findRangeByQuote(root, target) {
    const quote = target && target.quote ? String(target.quote) : '';
    if (!quote) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const map = []; // [{ node, start }] start = offset in `full`
    let full = '';
    let node;
    while ((node = walker.nextNode())) {
      map.push({ node, start: full.length });
      full += node.nodeValue;
    }
    if (!map.length) return null;
    const prefix = target.prefix || '';
    const suffix = target.suffix || '';
    const hits = [];
    let from = 0;
    let idx;
    while ((idx = full.indexOf(quote, from)) !== -1) {
      hits.push(idx);
      from = idx + 1;
    }
    if (!hits.length) return null;
    let chosen = hits[0];
    for (const h of hits) {
      const before = full.slice(Math.max(0, h - prefix.length), h);
      const after = full.slice(h + quote.length, h + quote.length + suffix.length);
      if ((!prefix || before.endsWith(prefix)) && (!suffix || after.startsWith(suffix))) {
        chosen = h;
        break;
      }
    }
    const locate = (off) => {
      for (const m of map) {
        if (off <= m.start + m.node.nodeValue.length) return { node: m.node, offset: off - m.start };
      }
      const last = map[map.length - 1];
      return { node: last.node, offset: last.node.nodeValue.length };
    };
    const s = locate(chosen);
    const e = locate(chosen + quote.length);
    const range = document.createRange();
    try {
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
    } catch {
      return null;
    }
    return range;
  }

  // Wrap every text-node segment inside `range` in its own <mark>; clicking a
  // mark opens the comment popover for that target. Returns the mark nodes.
  function wrapRange(range, sig, info) {
    const sC = range.startContainer;
    const sO = range.startOffset;
    const eC = range.endContainer;
    const eO = range.endOffset;
    const anc = range.commonAncestorContainer;
    const root = anc.nodeType === 1 ? anc : anc.parentNode;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const all = [];
    let n;
    while ((n = walker.nextNode())) all.push(n);
    // Decide membership BEFORE mutating the DOM (splitText adds new siblings).
    const inRange = all.filter((node) => {
      try {
        return range.intersectsNode(node);
      } catch {
        return false;
      }
    });
    const marks = [];
    for (const orig of inRange) {
      let fromOff = 0;
      let toOff = orig.nodeValue.length;
      if (orig === sC) fromOff = sO;
      if (orig === eC) toOff = eO;
      if (fromOff >= toOff) continue;
      let seg = orig;
      if (fromOff > 0) seg = seg.splitText(fromOff);
      if (toOff - fromOff < seg.nodeValue.length) seg.splitText(toOff - fromOff);
      const mark = el('mark', { class: 'ann-hl', 'data-sig': sig });
      seg.parentNode.insertBefore(mark, seg);
      mark.appendChild(seg);
      mark.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPopover(info, mark);
      });
      marks.push(mark);
    }
    return marks;
  }

  function unwrapHighlight(sig) {
    const marks = highlightMap.get(sig);
    if (!marks) return;
    for (const m of marks) {
      if (!m.isConnected) continue;
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    highlightMap.delete(sig);
  }

  // Highlight every saved text annotation whose blockId matches this root and
  // that isn't already wrapped (idempotent — safe to call on every register).
  function applyHighlightsForRoot(root, blockId) {
    const key = blockId ?? null;
    const seen = new Set();
    for (const a of annotations) {
      if (!a.target || a.target.kind !== 'text') continue;
      if ((a.blockId ?? null) !== key) continue;
      const sig = sigOf(a.blockId, a.target);
      if (seen.has(sig) || highlightMap.has(sig)) continue;
      seen.add(sig);
      const range = findRangeByQuote(root, a.target);
      if (!range) continue;
      const info = { blockId: a.blockId ?? null, questionId: a.questionId ?? null, target: a.target };
      const marks = wrapRange(range, sig, info);
      if (marks.length) highlightMap.set(sig, marks);
    }
  }

