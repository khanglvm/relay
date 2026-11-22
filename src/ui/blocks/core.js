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
  // Brighter/more saturated than the surfaces behind them so series stay legible
  // on the dark card (#282624) — the muted set washed out at a glance.
  const PALETTE_DARK = ['#e8a07a', '#74cfa0', '#88b4e8', '#e3c46a', '#c4a0db', '#c2b9ad'];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------- local file paths → click-to-open links ----------
  // Agents routinely write a path (~/clip.mp4, ./src/app.js, /abs/file) and the
  // user expects to click it open, not copy it into a terminal. We turn such
  // paths into links that preview files in a dialog, with an explicit app-open
  // fallback. FILE_PATH_RE / looksLikeLocalPath MUST match the same logic
  // in server.js so the page only links what the server will agree to open.
  // The body class also excludes \0 (the placeholder delimiter mdInline uses
  // below) so a path butted against a stashed span can't swallow it; \0 never
  // appears in real text, so this doesn't change which real paths match.
  const FILE_PATH_RE =
    /(?<![\w@:./])(?:file:\/\/\/?[^\s)<>"'`*\0]+|~\/[^\s)<>"'`*\0]+|\.{1,2}\/[^\s)<>"'`*\0]+|\/[^\s)<>"'`*\0]+|[A-Za-z]:[\\/][^\s)<>"'`*\0]+)/g;

  // Note: candidates here are HTML-escaped (esc() ran first), but escaping only
  // touches & < > " ' — none of which appear in a path's structural prefix, so
  // these tests are safe to run on the escaped text. Mirrors server.js.
  function looksLikeLocalPath(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!t || /\s/.test(t)) return false;
    if (/^file:\/\//i.test(t)) return true;
    if (/^[A-Za-z]:[\\/]/.test(t)) return true; // windows drive
    if (t === '~' || /^~\//.test(t)) return true;
    if (/^\.\.?\//.test(t)) return true; // ./ or ../
    if (t.startsWith('/')) return /\/[^/]+\/[^/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
    return false;
  }

  // Builds the <a> for a file path. `raw` and `label` are already escaped, so
  // they embed safely inside the attribute and text. codeStyle keeps the
  // monospace look when the path came from a `backtick` span.
  function fileLinkHtml(raw, label, codeStyle) {
    const cls = 'rly-filelink' + (codeStyle ? ' rly-filelink-code' : '');
    return (
      `<a class="${cls}" role="link" tabindex="0" data-rly-open="${raw}" ` +
      `title="Preview ${raw}" aria-haspopup="dialog">` +
      `<span class="rly-filelink-ico" aria-hidden="true"></span>` +
      `<span class="rly-filelink-txt">${label}</span></a>`
    );
  }

