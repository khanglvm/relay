  // ---------- helpers ----------
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

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // Humanized target label shown in the popover and the summary list.
  function humanize(t) {
    if (!t || typeof t !== 'object') return 'Element';
    switch (t.kind) {
      case 'chart-element': {
        const parts = [];
        if (t.label !== undefined && t.label !== null && t.label !== '') parts.push(truncate(t.label, 40));
        if (typeof t.datasetIndex === 'number') parts.push(`series ${t.datasetIndex + 1}`);
        if (t.value !== undefined && t.value !== null) {
          parts.push(truncate(typeof t.value === 'object' ? JSON.stringify(t.value) : t.value, 30));
        }
        return 'Chart · ' + (parts.join(' · ') || 'element');
      }
      case 'mermaid-node':
        return 'Diagram · ' + truncate(t.text || t.nodeId || 'node', 50);
      case 'graphviz-node':
        return 'Graph · ' + truncate(t.text || t.nodeId || 'node', 50);
      case 'plantuml-node':
        return 'Diagram · ' + truncate(t.text || 'element', 50);
      case 'image':
        return truncate(t.label || 'Image', 50);
      case 'image-point':
        return (t.label ? truncate(t.label, 30) + ' · ' : 'Image · ') + 'pin ' + Math.round((t.x || 0) * 100) + '%, ' + Math.round((t.y || 0) * 100) + '%';
      case 'image-region': {
        const source = t.side ? t.side.charAt(0).toUpperCase() + t.side.slice(1) + ' · ' : '';
        const area = `${Math.round((t.w || 0) * 100)}×${Math.round((t.h || 0) * 100)}% area`;
        return (t.label ? truncate(t.label, 30) + ' · ' : 'Image · ') + source + area;
      }
      case 'table-cell': {
        let s = `Table · row ${(Number(t.row) || 0) + 1} · ${t.col}`;
        if (t.value !== undefined && t.value !== null && t.value !== '') s += ` — “${truncate(t.value, 30)}”`;
        return s;
      }
      case 'code-line':
        return 'Line ' + t.line + (t.file ? ' · ' + truncate(t.file, 40) : '');
      case 'text':
        return `“${truncate(t.quote || '', 60)}”`;
      case 'html-element':
        return truncate(t.label || 'Element', 50) + (t.detail ? ` — ${truncate(t.detail, 40)}` : '');
      case 'block':
        return 'Whole ' + truncate(t.label || 'block', 40);
      default:
        return t.kind || 'Element';
    }
  }

  // Target equality for badge re-binding = stringify equality within a block.
  const sameTarget = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameBlock = (a, b) => (a ?? null) === (b ?? null);

  // Author chip: "you" (muted) for user comments, "agent" (accent) for agent.
  function chip(author) {
    const agent = author === 'agent';
    return el('span', { class: 'ann-chip' + (agent ? ' ann-chip-agent' : '') }, agent ? 'agent' : 'you');
  }

  // Short HH:MM timestamp (empty string when the date is unparsable).
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function timeEl(iso) {
    const t = fmtTime(iso);
    return t ? el('span', { class: 'ann-time' }, t) : null;
  }

  // ---------- state ----------
  let annotations = [];        // contract annotation objects
  let idCounter = 0;           // continues from max existing "aN"
  let onChange = null;
  let registered = [];         // [{el, info: {blockId, questionId, target}}]
  const summaryEls = new Set();
  let badges = [];             // live badge nodes (rebuilt on every refresh)
  let pendingSelection = null; // {info} captured at mouseup time

  // Text-selection comments are anchored back into the document as inline
  // <mark> highlights. textRoots maps a blockId (null = intro/board) to the
  // element whose text can be highlighted; highlightMap maps a target
  // signature to its live <mark> nodes so we can flash or unwrap them.
  const textRoots = new Map();
  const highlightMap = new Map();

  let dom = null;              // {pin, selBtn, pop, rail, railList, railToggle, railScrim, ...}
  let pinTimer = null;
  let pinEntry = null;
  let popOpen = false;
  let popSave = null;
  let popCloseHook = null;
  let popAnchorEl = null;
  let popPositionFrame = 0;
  const commentDrafts = new Map();
  // Frozen by the host (e.g. relay's connection-lost block): suppress every way
  // to START a comment, so the user can't type feedback that won't be saved.
  let disabled = false;
  let permissions = { add: true, edit: true, delete: true, reply: true };
  let badgeTimer = 0;
  let railOpen = false;

  // Stable signature for a (blockId, target) pair — same key matching() groups by.
  const sigOf = (blockId, target) => JSON.stringify({ b: blockId ?? null, t: target });

  // Brief highlight pulse used by the rail's jump-to.
  function flashEl(target) {
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('ann-flash');
    void target.getBoundingClientRect(); // restart the animation
    target.classList.add('ann-flash');
    setTimeout(() => target.classList.remove('ann-flash'), 1000);
  }

