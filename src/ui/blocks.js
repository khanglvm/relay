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
  // Brighter/more saturated than the surfaces behind them so series stay legible
  // on the dark card (#282624) — the muted set washed out at a glance.
  const PALETTE_DARK = ['#e8a07a', '#74cfa0', '#88b4e8', '#e3c46a', '#c4a0db', '#c2b9ad'];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------- local file paths → click-to-open links ----------
  // Agents routinely write a path (~/clip.mp4, ./src/app.js, /abs/file) and the
  // user expects to click it open, not copy it into a terminal. We turn such
  // paths into links that POST to /api/open, where the server opens them in the
  // OS default app. FILE_PATH_RE / looksLikeLocalPath MUST match the same logic
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
      `title="Open ${raw} in the default app">` +
      `<span class="rly-filelink-ico" aria-hidden="true"></span>` +
      `<span class="rly-filelink-txt">${label}</span></a>`
    );
  }

  // ---------- markdown mini renderer (NO library) ----------
  // Escape FIRST, then apply transforms on the already-escaped text. Because
  // <, >, & are gone, our generated tags are the only real tags in the output.
  function mdInline(escaped) {
    // Stash code/link/file-link HTML behind \0-delimited placeholders so the
    // later path-autolink and bold/italic passes can't re-tokenize inside them.
    // \0 never appears in real text, so the placeholders can't collide with it.
    const stash = [];
    const keep = (html) => '\0' + (stash.push(html) - 1) + '\0';

    let s = escaped;
    // inline code first so its contents aren't treated as bold/italic/links —
    // a backtick span that is ITSELF a lone path opens instead of just showing.
    s = s.replace(/`([^`]+)`/g, (_m, c) =>
      looksLikeLocalPath(c) ? keep(fileLinkHtml(c.trim(), c, true)) : keep(`<code>${c}</code>`)
    );
    // images ![alt](src) BEFORE links so the leading "!" isn't stranded as text.
    // A remote/data image embeds inline; a local path stays a click-to-open link
    // (the board server doesn't serve the source file's directory).
    // ponytail: remote/data images embed; local-relative images open in the app
    // rather than render — add directory serving only if users need inline locals.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
      if (/^(https?:|data:image\/)/i.test(url)) return keep(`<img class="md-img" src="${url}" alt="${alt}" loading="lazy">`);
      if (looksLikeLocalPath(url)) return keep(fileLinkHtml(url, alt || url, false));
      return `![${alt}](${url})`; // unknown scheme — leave literal, don't link
    });
    // links [text](url) — url is already escaped; a local-path target becomes a
    // click-to-open link, otherwise a normal link (guarding odd schemes).
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
      if (looksLikeLocalPath(url)) return keep(fileLinkHtml(url, text, false));
      const safe = /^(https?:|mailto:|\/|#|\.)/i.test(url) ? url : '#';
      return keep(`<a href="${safe}" target="_blank" rel="noopener">${text}</a>`);
    });
    // bare paths in running text (the common case: the agent just typed a path)
    s = s.replace(FILE_PATH_RE, (m) => (looksLikeLocalPath(m) ? keep(fileLinkHtml(m, m, false)) : m));
    // bold then italic (bold uses ** so must run before single *)
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
    s = s.replace(/\*([^*]+)\*/g, (_m, c) => `<em>${c}</em>`);
    // underscore emphasis __bold__ / _italic_, only at word boundaries so
    // snake_case and RLY_BOARD_ID are left alone (CommonMark intraword rule).
    s = s.replace(/(^|[^A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/g, (_m, p, c) => `${p}<strong>${c}</strong>`);
    s = s.replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, (_m, p, c) => `${p}<em>${c}</em>`);
    // restore the stashed HTML — loop so a placeholder nested inside another
    // stashed fragment (e.g. a code span inside a link's text) is also resolved.
    let guard = 0;
    while (s.indexOf('\0') !== -1 && guard++ < 6) {
      s = s.replace(/\0(\d+)\0/g, (_m, i) => (stash[Number(i)] !== undefined ? stash[Number(i)] : ''));
    }
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

    // GFM pipe tables — a header row of "| a | b |" cells immediately followed
    // by a separator row of dashes (with optional ":" alignment markers).
    // Rendered as a real .blk-table so it matches the dedicated table block.
    function splitRow(row) {
      const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
      return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
    }
    function isSepRow(row) {
      if (!row || row.indexOf('|') === -1) return false;
      const cells = splitRow(row);
      return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
    }
    function isTableStart(idx) {
      const head = lines[idx];
      return (
        idx + 1 < lines.length &&
        head.indexOf('|') !== -1 &&
        !isSepRow(head) &&
        isSepRow(lines[idx + 1])
      );
    }
    function consumeTable() {
      const headers = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      i += 2;
      const body = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].indexOf('|') !== -1 && !isSepRow(lines[i])) {
        body.push(splitRow(lines[i]));
        i++;
      }
      const ncols = headers.length;
      const alignAttr = (ci) => (aligns[ci] ? ` style="text-align:${aligns[ci]}"` : '');
      const cell = (tag, ci, text) => `<${tag}${alignAttr(ci)}>${mdInline(esc(text == null ? '' : text))}</${tag}>`;
      let out = '<div class="md-tablewrap"><table class="blk-table md-table"><thead><tr>';
      for (let c = 0; c < ncols; c++) out += cell('th', c, headers[c]);
      out += '</tr></thead><tbody>';
      for (const r of body) {
        out += '<tr>';
        for (let c = 0; c < ncols; c++) out += cell('td', c, r[c]);
        out += '</tr>';
      }
      out += '</tbody></table></div>';
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

      // GFM pipe table (header row + dash separator)
      if (isTableStart(i)) { html += consumeTable(); continue; }

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
        !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
        !isTableStart(i)
      ) {
        buf.push(lines[i]);
        i++;
      }
      html += `<p>${mdInline(esc(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }

    root.innerHTML = html;
    return root;
  }

  // ---------- code tinter (lightweight, zero-dependency, offline) ----------
  // Per language we record its comment style(s), whether it has backtick
  // strings, and its keyword set. From those a single alternation regex tints
  // comments / strings / numbers / keywords in one pass. Unknown languages
  // render as plain escaped text; css / html / xml get bespoke patterns.
  // Mirrors the wide-compat goal: no library, works in every browser offline.
  const LANGS = {
    js: { c: true, tmpl: true, kw: 'await async break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while yield' },
    ts: { c: true, tmpl: true, kw: 'abstract any as asserts async await boolean break case catch class const continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of private protected public readonly return satisfies set static string super switch this throw true try type typeof undefined unknown var void while yield' },
    json: { kw: 'true false null' },
    py: { hash: true, kw: 'and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return self True try while with yield' },
    sh: { hash: true, kw: 'if then else elif fi for while until do done case esac function in return export local readonly echo cd set unset source eval exec trap exit' },
    go: { c: true, tmpl: true, kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota' },
    rust: { c: true, kw: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while' },
    java: { c: true, kw: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient true false try void volatile while var record sealed' },
    c: { c: true, kw: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL' },
    cpp: { c: true, kw: 'alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while' },
    csharp: { c: true, kw: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await yield' },
    ruby: { hash: true, kw: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true unless until when while yield require attr_accessor' },
    php: { c: true, hash: true, kw: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends false final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new null or print private protected public readonly return static switch throw trait true try unset use var while xor yield' },
    swift: { c: true, kw: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self throw throws true try' },
    kotlin: { c: true, kw: 'abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do dynamic else enum external false final finally for fun get if import in infix init inline inner interface internal is lateinit lazy null object open operator out override package private protected public reified return sealed set super suspend this throw true try typealias val var vararg when where while' },
    yaml: { hash: true, kw: 'true false null yes no on off' },
    toml: { hash: true, kw: 'true false' },
    sql: { c: true, sql: true, kwi: true, kw: 'select from where insert into values update set delete create table alter drop index view join inner left right outer full on as and or not null is in like between group by order having limit offset union all distinct count sum avg min max case when then else end primary key foreign references default unique constraint cascade asc desc returning with' },
    css: { special: 'css' },
    html: { special: 'html' },
  };
  const LANG_ALIAS = {
    javascript: 'js', node: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    typescript: 'ts', tsx: 'ts',
    shell: 'sh', bash: 'sh', zsh: 'sh', console: 'sh',
    python: 'py', py3: 'py',
    golang: 'go', rs: 'rust', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'c#': 'csharp', cs: 'csharp',
    rb: 'ruby', kt: 'kotlin',
    yml: 'yaml', xml: 'html', svg: 'html', htm: 'html',
    jsonc: 'json', json5: 'json',
  };

  function tintCode(code, lang) {
    const key0 = (lang || '').toLowerCase().trim();
    const cfg = LANGS[LANG_ALIAS[key0] || key0];
    if (!cfg) return esc(code); // unknown lang -> plain

    // Build ONE alternation regex with a parallel classes[] so group g (1-based)
    // maps to classes[g-1]. Each pushed source is wrapped in exactly one
    // capturing group; the source bodies use only non-capturing groups.
    const parts = [];
    const classes = [];
    const push = (src, cls) => { parts.push('(' + src + ')'); classes.push(cls); };
    if (cfg.special === 'css') {
      push(/\/\*[\s\S]*?\*\//.source, 'com');
      push(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/.source, 'str');
      push(/[A-Za-z-]+(?=\s*:)/.source, 'kw');
      push(/\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/.source, 'num');
    } else if (cfg.special === 'html') {
      push(/<!--[\s\S]*?-->/.source, 'com');
      push(/<\/?[A-Za-z][\w-]*|\/?>/.source, 'kw');
      push(/"[^"]*"/.source, 'str');
    } else {
      if (cfg.c) { push(/\/\*[\s\S]*?\*\//.source, 'com'); push(/\/\/[^\n]*/.source, 'com'); }
      if (cfg.hash) push(/#[^\n]*/.source, 'com');
      if (cfg.sql) push(/--[^\n]*/.source, 'com');
      push((cfg.tmpl
        ? /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/
        : /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/).source, 'str');
      push(/\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/.source, 'num');
      let kws = (cfg.kw || '').split(' ').filter(Boolean);
      if (cfg.kwi) kws = kws.concat(kws.map((k) => k.toUpperCase())); // SQL: also UPPERCASE
      if (kws.length) push('\\b(?:' + kws.join('|') + ')\\b', 'kw');
    }
    const rx = new RegExp(parts.join('|'), 'g');
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

  // A line-number gutter element for `text` (aria-hidden + non-selectable so a
  // select-to-comment grabs only the code, not the numbers). `startAt` default 1.
  function lineGutter(text, startAt) {
    const n = Math.max(1, String(text).replace(/\n+$/, '').split('\n').length);
    const g = el('div', { class: 'blk-gutter', 'aria-hidden': 'true' });
    let s = '';
    for (let i = 0; i < n; i++) s += (startAt || 1) + i + '\n';
    g.textContent = s;
    return g;
  }

  function renderCode(block, ctx, blockId) {
    // Drop a single trailing newline so the last source line isn't rendered as
    // an empty row the gutter has no number for (files usually end in "\n").
    const raw = (block.code || '').replace(/\n$/, '');
    const code = el('code');
    code.innerHTML = tintCode(raw, block.lang);
    const pre = el('pre', { class: 'blk-pre', 'data-lang': block.lang || '' }, code);
    const row = el('div', { class: 'blk-coderow' }, lineGutter(raw), pre);
    const wrap = el('div', { class: 'blk-codewrap' });
    // Optional file-name + language header above the code.
    if (block.filename || block.lang) {
      wrap.append(el('div', { class: 'blk-codehead' },
        el('span', { class: 'blk-codename' }, block.filename || ''),
        el('span', { class: 'blk-codelang' }, block.lang || '')
      ));
    }
    wrap.append(row);
    // select-to-comment on the code text (like markdown), plus a whole-block
    // comment + full-screen via the shared viewer toolbar
    ctx && ctx.annotate && ctx.annotate.enableTextSelection(pre, { blockId, questionId: ctx.questionId });
    attachViewer(wrap, { zoomEl: null, label: 'code', comment: wholeBlockComment(ctx, blockId, 'code') });
    return wrap;
  }

  // ---------- diff (unified / git diff) ----------
  // No git is involved — the agent supplies the diff text. Parsed once into
  // rows, then rendered either UNIFIED (one column, +/- signs) or SPLIT (old |
  // new side-by-side). A header toggle flips between the two live; the block's
  // "view" sets the initial mode. Each code line is tinted by lang.

  // Parse a unified diff into a flat row list: {kind, text, oldNo, newNo}
  // (line numbers stored 0-based; rendered +1).
  function parseDiff(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const rows = [];
    let oldNo = 0;
    let newNo = 0;
    for (const line of lines) {
      if (/^@@/.test(line)) {
        const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
        if (m) { oldNo = Number(m[1]) - 1; newNo = Number(m[2]) - 1; }
        rows.push({ kind: 'hunk', text: line });
      } else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |copy )/.test(line)) {
        rows.push({ kind: 'meta', text: line });
      } else if (line[0] === '+') {
        rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
      } else if (line[0] === '-') {
        rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
      } else {
        rows.push({ kind: 'ctx', text: line[0] === ' ' ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
      }
    }
    return rows;
  }

  function diffNoTd(n, extraClass) {
    const td = el('td', { class: 'diff-no' + (extraClass ? ' ' + extraClass : ''), 'aria-hidden': 'true' });
    if (n !== undefined && n !== null) td.textContent = String(n + 1);
    return td;
  }
  function diffCodeTd(html, extraClass) {
    const c = el('code');
    c.innerHTML = html || ' ';
    return el('td', { class: 'diff-code' + (extraClass ? ' ' + extraClass : '') }, c);
  }

  // Unified: oldNo | newNo | sign | code
  function buildUnifiedDiff(rows, lang) {
    const tbody = el('tbody');
    for (const r of rows) {
      const full = r.kind === 'hunk' || r.kind === 'meta';
      const codeHtml = full ? esc(r.text) : tintCode(r.text, lang);
      const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '';
      tbody.append(el('tr', { class: 'diff-row diff-' + r.kind },
        diffNoTd(r.oldNo),
        diffNoTd(r.newNo),
        el('td', { class: 'diff-sign', 'aria-hidden': 'true' }, sign),
        diffCodeTd(codeHtml)
      ));
    }
    return el('table', { class: 'blk-difftable' }, tbody);
  }

  // Split: oldNo | old code || newNo | new code. A run of removed lines is
  // paired row-by-row with the following run of added lines; the shorter side
  // gets filler cells. Context shows identically on both sides.
  function buildSplitDiff(rows, lang) {
    const tbody = el('tbody');
    const fullRow = (cls, text) => {
      const c = el('code');
      c.innerHTML = esc(text) || ' ';
      tbody.append(el('tr', { class: 'diff-row diff-' + cls }, el('td', { class: 'diff-code', colspan: '4' }, c)));
    };
    let dels = [];
    let adds = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        const d = dels[i];
        const a = adds[i];
        const left = d
          ? [diffNoTd(d.oldNo, 'diff-del'), diffCodeTd(tintCode(d.text, lang), 'diff-del')]
          : [diffNoTd(null, 'diff-fill'), diffCodeTd(' ', 'diff-fill')];
        const right = a
          ? [diffNoTd(a.newNo, 'diff-newside diff-add'), diffCodeTd(tintCode(a.text, lang), 'diff-add')]
          : [diffNoTd(null, 'diff-fill diff-newside'), diffCodeTd(' ', 'diff-fill')];
        tbody.append(el('tr', { class: 'diff-row' }, left[0], left[1], right[0], right[1]));
      }
      dels = [];
      adds = [];
    };
    for (const r of rows) {
      if (r.kind === 'del') { dels.push(r); continue; }
      if (r.kind === 'add') { adds.push(r); continue; }
      flush();
      if (r.kind === 'hunk') fullRow('hunk', r.text);
      else if (r.kind === 'meta') fullRow('meta', r.text);
      else {
        const html = tintCode(r.text, lang);
        tbody.append(el('tr', { class: 'diff-row diff-ctx' },
          diffNoTd(r.oldNo), diffCodeTd(html),
          diffNoTd(r.newNo, 'diff-newside'), diffCodeTd(html)
        ));
      }
    }
    flush();
    return el('table', { class: 'blk-difftable blk-difftable-split' }, tbody);
  }

  function renderDiff(block, ctx, blockId) {
    const rows = parseDiff(block.diff);
    let view = block.view === 'split' ? 'split' : 'unified';
    const scroll = el('div', { class: 'blk-diffscroll' });
    const paint = () => {
      scroll.innerHTML = '';
      scroll.append(view === 'split' ? buildSplitDiff(rows, block.lang) : buildUnifiedDiff(rows, block.lang));
    };
    paint();

    const wrap = el('div', { class: 'blk-codewrap blk-diffwrap' });
    // header: file name (left) + a Unified/Split view toggle (right)
    const toggle = el('button', { class: 'blk-difftoggle', type: 'button', title: 'Toggle side-by-side view' });
    const syncToggle = () => { toggle.textContent = view === 'split' ? 'Unified view' : 'Split view'; };
    syncToggle();
    toggle.addEventListener('mousedown', (e) => e.stopPropagation());
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view = view === 'split' ? 'unified' : 'split';
      wrap.classList.toggle('is-split', view === 'split');
      syncToggle();
      paint();
    });
    wrap.append(el('div', { class: 'blk-codehead' },
      el('span', { class: 'blk-codename' }, block.filename || ''),
      toggle
    ));
    wrap.classList.toggle('is-split', view === 'split');
    wrap.append(scroll);
    // select-to-comment stays bound to the stable scroll container across toggles
    ctx && ctx.annotate && ctx.annotate.enableTextSelection(scroll, { blockId, questionId: ctx.questionId });
    attachViewer(wrap, { zoomEl: null, label: 'diff', comment: wholeBlockComment(ctx, blockId, 'diff') });
    return wrap;
  }
  // ---------- video (YouTube/Vimeo embed, local stream, or direct URL) ----------
  function renderVideo(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-videowrap' });
    let media;
    if (block.provider === 'youtube') {
      const q = block.start ? '?start=' + block.start : '';
      media = el('iframe', {
        class: 'blk-video-embed',
        src: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(block.videoId) + q,
        title: block.title || 'YouTube video',
        frameborder: '0',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
        referrerpolicy: 'strict-origin-when-cross-origin',
        allowfullscreen: 'true',
        loading: 'lazy',
      });
    } else if (block.provider === 'vimeo') {
      media = el('iframe', {
        class: 'blk-video-embed',
        src: 'https://player.vimeo.com/video/' + encodeURIComponent(block.videoId),
        title: block.title || 'Vimeo video',
        frameborder: '0',
        allow: 'autoplay; fullscreen; picture-in-picture',
        allowfullscreen: 'true',
        loading: 'lazy',
      });
    } else {
      // local file (served via /video/b/<id>) or a direct http(s) media URL
      const src = block.hasFile ? '/video/b/' + encodeURIComponent(blockId) : block.src;
      media = el('video', { class: 'blk-video', controls: 'true', preload: 'metadata', playsinline: 'true' });
      if (block.title) media.setAttribute('title', block.title);
      const source = el('source', { src });
      if (block.mime) source.setAttribute('type', block.mime);
      media.append(source);
      media.append(document.createTextNode('Your browser cannot play this video.'));
    }
    wrap.append(media);
    if (block.title) wrap.append(el('div', { class: 'blk-videocap' }, block.title));
    // whole-block comment + the comment pin (no zoom/full-screen for media)
    attachViewer(wrap, { zoomEl: null, label: 'video', comment: wholeBlockComment(ctx, blockId, 'video') });
    return wrap;
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
    // Tables are visual too: wrap so they get the full-screen viewer like
    // every other visual block (wide tables squeeze in the column).
    const wrap = el('div', { class: 'blk-tablewrap' }, table);
    attachViewer(wrap, { zoomEl: null });
    return wrap;
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

  let vizPromise = null;
  function loadViz() {
    if (window.Viz) return Promise.resolve(window.Viz);
    if (vizPromise) return vizPromise;
    vizPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/viz-standalone.js';
      s.onload = () => (window.Viz ? resolve(window.Viz) : reject(new Error('Graphviz failed to load')));
      s.onerror = () => reject(new Error('Graphviz failed to load'));
      document.head.appendChild(s);
    });
    return vizPromise;
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
    const canvas = el('canvas');
    wrap.append(canvas);

    let chartInst = null;
    let chartBadges = [];

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
          wrap.append(badge);
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
    // full-screen + whole-chart comment only; charts redraw responsively (no pixel zoom)
    attachViewer(wrap, { zoomEl: null, label: 'chart', comment: wholeBlockComment(ctx, blockId, 'chart') });

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
      } catch (err) {
        wrap.replaceChildren(el('div', { class: 'blk-error' }, 'Chart error: ' + (err && err.message ? err.message : String(err))));
        return;
      }
      // hover -> pointer cursor on a hit
      canvas.addEventListener('mousemove', (e) => {
        const hits = chartInst.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
        canvas.style.cursor = hits.length ? 'pointer' : 'default';
      });
      canvas.addEventListener('click', (e) => {
        if (!ctx.annotate) return;
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

  // ---------- mermaid ----------
  let mermaidSeq = 0;
  // Registries so a live theme toggle can re-render diagrams and restyle
  // charts without a page reload.
  const mermaidRegistry = [];
  const chartRegistry = [];

  // Effective code = the user's edit if present, else the authored block.code.
  // Used by the initial render, the editor's live preview, and the theme
  // re-render registry path so an edit survives a theme toggle.
  function effectiveMermaidCode(entry) {
    const { block, ctx, blockId } = entry;
    const edited = ctx.edits ? ctx.edits[blockId] : undefined;
    if (edited !== undefined && edited !== null) return edited;
    // The live editor keeps entry.code as the source of truth; if the host's
    // ctx.edits hasn't been updated yet but the user has diverged from the
    // original, preserve that divergence (don't snap back to block.code).
    if (entry.code !== undefined && entry.code !== (block.code || '')) return entry.code;
    return block.code || '';
  }

  function renderMermaid(block, ctx, blockId) {
    const container = el('div', { class: 'blk-mermaid' });
    // Honor an authored height as the scrollable viewport: a diagram taller than
    // this overflows and becomes drag-pannable in place (was silently ignored —
    // diagrams only ever fit-to-width). No height keeps the 1200px CSS cap.
    if (block.height != null) container.style.maxHeight = clampHeight(block.height, 1200) + 'px';
    const entry = { container, block, ctx, blockId };
    entry.code = effectiveMermaidCode(entry);
    mermaidRegistry.push(entry);

    if (!block.editable) {
      drawMermaid(entry);
      return container;
    }

    // Editable: wrap the diagram + an editor below it. The wrapper is what the
    // dispatcher appends; the registry still tracks `container` (the diagram).
    const wrap = el('div', { class: 'blk-mermaid-wrap' });
    wrap.append(container);
    wrap.append(buildMermaidEditor(entry));
    drawMermaid(entry);
    return wrap;
  }

  // Editor: toggle button + collapsible panel (textarea + Reset + status line).
  // Live re-render is debounced 600ms; errors show inline WITHOUT destroying the
  // last good diagram. Each accepted change calls ctx.onBlockEdit(blockId, code)
  // (null when the value matches the original block.code again).
  function buildMermaidEditor(entry) {
    const { block, ctx, blockId, container } = entry;
    const original = block.code || '';

    const toggleBtn = el('button', { type: 'button', class: 'blk-edit-btn' }, 'Edit diagram');
    const panel = el('div', { class: 'blk-editor', hidden: '' });

    const ta = el('textarea', { class: 'blk-editor-ta', spellcheck: 'false' });
    ta.value = entry.code;

    const status = el('div', { class: 'blk-editor-status' }, '');
    const resetBtn = el('button', { type: 'button', class: 'blk-editor-reset' }, 'Reset');
    const row = el('div', { class: 'blk-editor-row' }, resetBtn, status);
    panel.append(ta, row);

    let open = false;
    toggleBtn.addEventListener('click', () => {
      open = !open;
      panel.hidden = !open;
      toggleBtn.classList.toggle('is-open', open);
      if (open) ta.focus();
    });

    let timer = null;
    function reportEdit(code) {
      // Only report a real divergence; equal-to-original clears the edit (null).
      try {
        if (code === original) ctx.onBlockEdit(blockId, null);
        else ctx.onBlockEdit(blockId, code);
      } catch {
        // host callback failures must not break editing
      }
    }

    // Try to render `code`; on success swap the diagram + re-register annotation
    // targets (via drawMermaid) and report the edit; on failure keep the last
    // good diagram and show the error inline.
    function applyCode(code) {
      previewMermaid(entry, code)
        .then(() => {
          status.textContent = '';
          status.classList.remove('has-error');
          entry.code = code;
          reportEdit(code);
        })
        .catch((err) => {
          status.textContent = 'diagram error: ' + (err && err.message ? err.message : String(err));
          status.classList.add('has-error');
        });
    }

    ta.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      const code = ta.value;
      timer = setTimeout(() => applyCode(code), 600);
    });

    resetBtn.addEventListener('click', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      ta.value = original;
      applyCode(original);
    });

    return el('div', { class: 'blk-mermaid-edit' }, toggleBtn, panel);
  }

  // Render `code` for the editor preview WITHOUT mutating entry.code on failure.
  // Resolves once the diagram is swapped into the container (annotation targets
  // re-registered by drawMermaid); rejects with the render error so the caller
  // can show it inline and keep the last good diagram.
  function previewMermaid(entry, code) {
    const prev = entry.code;
    entry.code = code;
    return new Promise((resolve, reject) => {
      drawMermaid(entry, { onDone: resolve, onError: reject });
    }).catch((err) => {
      entry.code = prev;
      throw err;
    });
  }

  function drawMermaid(entry, hooks) {
    const { container, ctx, blockId } = entry;
    const onError = hooks && hooks.onError ? hooks.onError : null;
    const onDone = hooks && hooks.onDone ? hooks.onDone : null;
    const fail = (err) => {
      if (onError) onError(err);
      else showMermaidErr(container, err);
    };
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
      const code = entry.code !== undefined ? entry.code : effectiveMermaidCode(entry);
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
        if (ctx.annotate) {
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
        }
        // re-attach per render: innerHTML replacement above wiped the old bar
        if (svgEl) attachViewer(container, { zoomEl: svgEl, natural: svgNatural(svgEl), label: 'diagram', comment: wholeBlockComment(ctx, blockId, 'diagram') });
        if (onDone) onDone();
      };
      try {
        const ret = mermaid.render(id, code);
        if (ret && typeof ret.then === 'function') {
          ret.then((r) => onSvg(r.svg)).catch((err) => fail(err));
        } else if (ret && ret.svg) {
          onSvg(ret.svg);
        } else if (typeof ret === 'string') {
          onSvg(ret);
        } else {
          // legacy callback signature: render(id, code, cb)
          mermaid.render(id, code, (svg) => onSvg(svg));
        }
      } catch (err) {
        fail(err);
      }
    }).catch((err) => fail(err));
  }

  // Live theme toggle: re-render mermaid diagrams with the new mermaid theme
  // and restyle existing charts' grid/tick/legend colors in place.
  function onThemeChange() {
    for (const entry of mermaidRegistry) {
      try {
        // re-render with the effective code so an edit survives the toggle
        entry.code = effectiveMermaidCode(entry);
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

  // ---------- graphviz (offline, vendored Viz.js -> SVG) ----------
  // Same sizing rule as mermaid: never upscale past the diagram's natural
  // width; shrink on narrow screens. Authors set their own colors so there is
  // no theme re-render.
  function sizeDiagramSvg(svgEl) {
    if (!svgEl) return;
    svgEl.removeAttribute('height');
    svgEl.removeAttribute('width');
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    if (vb && vb.width > 0) {
      svgEl.style.width = '100%';
      svgEl.style.maxWidth = Math.ceil(vb.width) + 'px';
      svgEl.style.height = 'auto';
    } else {
      svgEl.style.maxWidth = '100%';
    }
  }

  function renderGraphviz(block, ctx, blockId) {
    const container = el('div', { class: 'blk-graphviz' });
    // honor authored height as the scrollable viewport (see renderMermaid)
    if (block.height != null) container.style.maxHeight = clampHeight(block.height, 1200) + 'px';
    loadViz()
      .then((Viz) => Viz.instance())
      .then((viz) => {
        const svgEl = viz.renderSVGElement(block.dot || '');
        sizeDiagramSvg(svgEl);
        container.replaceChildren(svgEl);
        attachViewer(container, { zoomEl: svgEl, natural: svgNatural(svgEl), label: 'graph', comment: wholeBlockComment(ctx, blockId, 'graph') });
        if (!ctx.annotate) return;
        const parts = svgEl.querySelectorAll('g.node, g.edge');
        parts.forEach((g) => {
          const titleEl = g.querySelector('title');
          const nodeId = (g.id || (titleEl && titleEl.textContent) || '').trim();
          // Label text lives in <text> elements; g.textContent would also
          // include the <title> child and duplicate the label.
          const labels = Array.from(g.querySelectorAll('text')).map((t) => t.textContent.trim()).filter(Boolean);
          const text = (labels.join(' ') || (titleEl && titleEl.textContent) || '').trim().slice(0, 120);
          ctx.annotate.register(g, {
            blockId,
            questionId: ctx.questionId,
            target: {
              kind: 'graphviz-node',
              nodeId,
              text,
            },
          });
        });
      })
      .catch((err) => {
        container.replaceChildren(
          el('div', { class: 'blk-error' }, 'Graphviz error: ' + (err && err.message ? err.message : String(err)))
        );
      });
    return container;
  }

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

  // ---------- image ----------
  // src is a remote URL, or absent for embedded local files (served by the
  // board server at /img/b/<id>). Same sizing rule as diagrams: never upscale
  // past natural width; zoom/full-screen viewer attached once loaded.
  function renderImage(block, ctx, blockId) {
    const container = el('div', { class: 'blk-imagewrap' });
    const src = typeof block.src === 'string' && block.src
      ? block.src
      : '/img/b/' + encodeURIComponent(blockId);
    const img = el('img', {
      class: 'blk-img',
      src,
      alt: block.alt || 'image',
      loading: 'lazy',
    });
    // The per-block height only caps the COMPACT inline preview — the viewer
    // lifts it on zoom / full-screen so the user can always reach full detail.
    const fitMaxHeight = block.height ? clampHeight(block.height, 360) : null;
    if (fitMaxHeight) img.style.maxHeight = fitMaxHeight + 'px';
    img.addEventListener('error', () => {
      container.replaceChildren(el('div', { class: 'blk-error' }, 'Image failed to load'));
    });
    container.append(img);
    const attachImgViewer = () =>
      attachViewer(container, {
        zoomEl: img,
        natural: () => (img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null),
        label: 'image',
        comment: wholeBlockComment(ctx, blockId, 'image'),
        fitMaxHeight,
      });
    if (img.complete && img.naturalWidth > 0) attachImgViewer();
    else img.addEventListener('load', attachImgViewer, { once: true });
    if (ctx.annotate) {
      ctx.annotate.register(img, {
        blockId,
        questionId: ctx.questionId,
        target: { kind: 'image', label: block.alt || 'Image' },
      });
    }
    return container;
  }

  // ---------- palette ----------
  // Color palettes as swatch cards: hover a swatch to reveal its hex, click to
  // copy it. One palette may be {featured:true} → a larger spotlight row. Lets
  // an agent present a curated palette with one structured block instead of
  // hand-writing HTML. Swatches and the whole block are commentable.
  function copyColor(text, btn) {
    const done = () => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 900);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {});
        return;
      }
    } catch { /* fall through */ }
    done(); // no clipboard (sandbox) — still flash feedback
  }

  function paletteCard(p, big, ctx, blockId) {
    const card = el('div', { class: 'pal-card' + (big ? ' pal-spotlight' : '') });
    const row = el('div', { class: 'pal-swatches' });
    for (const c of p.colors) {
      const sw = el('button', { class: 'pal-sw', type: 'button', style: 'background:' + c, title: 'Copy ' + c });
      sw.append(el('span', { class: 'pal-hex' }, c));
      sw.addEventListener('click', () => copyColor(c, sw));
      if (ctx.annotate) {
        ctx.annotate.register(sw, {
          blockId,
          questionId: ctx.questionId,
          target: { kind: 'swatch', label: (p.name ? p.name + ' · ' : '') + c },
        });
      }
      row.append(sw);
    }
    card.append(row);
    const info = el('div', { class: 'pal-info' });
    const meta = el('div', { class: 'pal-meta' });
    if (p.name) meta.append(el('div', { class: 'pal-name' }, p.name));
    if (p.sub) meta.append(el('div', { class: 'pal-sub' }, p.sub));
    info.append(meta);
    if (p.tag) info.append(el('span', { class: 'pal-tag' + (p.tagTone ? ' tone-' + p.tagTone : '') }, p.tag));
    if (p.name || p.sub || p.tag) card.append(info);
    return card;
  }

  function renderPalette(block, ctx, blockId) {
    const wrap = el('div', { class: 'blk-palette' });
    const palettes = Array.isArray(block.palettes) ? block.palettes : [];
    if (block.title) wrap.append(el('div', { class: 'pal-title' }, block.title));
    const grid = el('div', { class: 'pal-grid' });
    for (const p of palettes) {
      if (p.featured) wrap.append(paletteCard(p, true, ctx, blockId));
      else grid.append(paletteCard(p, false, ctx, blockId));
    }
    if (grid.childNodes.length) wrap.append(grid);
    return wrap;
  }

  // ---------- viewer controls (zoom / fit / full-screen) ----------
  // Large diagrams get squeezed to the column width; these controls let the
  // user zoom (buttons or cmd/ctrl+wheel) and expand any visual block into a
  // full-screen overlay. An overlay — NOT the native Fullscreen API — keeps
  // the annotation pins/badges/popover usable while expanded (they live on
  // <body>, which native fullscreen would hide).
  let fullOpen = null; // container currently expanded
  // full-screen content insets — must mirror the .blk-full padding in blocks.css
  // so the fit-to-screen scale clears the fixed toolbar + leaves a small margin.
  const FULL_PAD_X = 24, FULL_PAD_TOP = 44, FULL_PAD_BOTTOM = 24;

  // Toolbar icons: full-screen (4-corner expand) and a speech-bubble for the
  // "comment on the whole block" button. Zoom is both cmd/ctrl+wheel AND
  // explicit −/+ buttons (the % doubles as a reset-to-fit button).
  const ICON_EXPAND =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 9V3h6M10 10 3 3M15 3h6v6M14 10l7-7M9 21H3v-6M10 14l-7 7M21 15v6h-6M14 14l7 7"/></svg>';
  const ICON_COMMENT =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>';

  function exitFull() {
    if (!fullOpen) return;
    const c = fullOpen;
    c.classList.remove('blk-full');
    document.body.classList.remove('blk-full-open');
    const btn = c.querySelector('.blk-tools .tool-full');
    if (btn) btn.innerHTML = ICON_EXPAND;
    fullOpen = null;
    window.dispatchEvent(new Event('resize'));
    if (c._rlyToolsSync) c._rlyToolsSync(); // re-pin toolbar to its scrolled corner
    if (c._rlyZoom) c._rlyZoom.reapply(); // restore the compact inline height cap
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fullOpen) exitFull();
  });

  // Drag-to-pan: grab anywhere on a scrollable visual (a tall/zoomed diagram or
  // oversized image) and drag to move across it, instead of hunting for the
  // scrollbars. Self-gates on overflow, so charts and html iframes — which are
  // always sized to fit — never engage. Annotation on diagrams/images is
  // hover-pin based (not a node click), so a pan can't create a stray
  // annotation; a real drag still swallows the trailing click as a guard.
  // Returns a refresh() the viewer calls whenever content size changes (zoom,
  // full-screen, re-render) so the grab affordance tracks pannability.
  function enablePan(scrollEl) {
    let pending = false, active = false;
    let sx = 0, sy = 0, sl = 0, st = 0, pid = null;
    const THRESH = 4; // px before a press becomes a drag (keeps clicks clickable)

    const pannable = () =>
      scrollEl.scrollWidth - scrollEl.clientWidth > 1 ||
      scrollEl.scrollHeight - scrollEl.clientHeight > 1;
    const refresh = () => scrollEl.classList.toggle('blk-pannable', pannable());

    scrollEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !pannable()) return;
      // leave the toolbar, the diagram editor, and real controls interactive
      if (e.target.closest && e.target.closest('.blk-tools, .blk-editor, button, a, input, textarea, select')) return;
      pending = true; active = false;
      sx = e.clientX; sy = e.clientY;
      sl = scrollEl.scrollLeft; st = scrollEl.scrollTop;
      pid = e.pointerId;
    });
    scrollEl.addEventListener('pointermove', (e) => {
      if (!pending) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!active) {
        if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return;
        active = true;
        scrollEl.classList.add('blk-panning');
        try { scrollEl.setPointerCapture(pid); } catch (_) {}
      }
      e.preventDefault();
      scrollEl.scrollLeft = sl - dx;
      scrollEl.scrollTop = st - dy;
    });
    const end = () => {
      if (active) {
        scrollEl.classList.remove('blk-panning');
        try { scrollEl.releasePointerCapture(pid); } catch (_) {}
        // a drag ends in a click on whatever was under the release — swallow it
        // once so it can't trigger anything the user didn't mean to click
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        scrollEl.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => scrollEl.removeEventListener('click', swallow, true), 0);
      }
      pending = false; active = false; pid = null;
    };
    scrollEl.addEventListener('pointerup', end);
    scrollEl.addEventListener('pointercancel', end);
    window.addEventListener('resize', refresh);
    return refresh;
  }

  // Build the onComment thunk for attachViewer: opens the annotation popover
  // with a block-scoped target ("Whole chart/diagram/…") so a user can comment
  // on the visual as a whole. null when annotation is off (omits the button).
  function wholeBlockComment(ctx, blockId, label) {
    if (!ctx || !ctx.annotate) return null;
    const a = ctx.annotate;
    return {
      open: (anchorEl) =>
        a.openExternal({ blockId, questionId: ctx.questionId, target: { kind: 'block', label } }, anchorEl),
      // true once this block carries a whole-block comment
      active: () => a.list().some((x) => x.blockId === blockId && x.target && x.target.kind === 'block'),
      // fires on any annotation change; returns an unsubscribe
      subscribe: (fn) => (a.onBadgeRefresh ? a.onBadgeRefresh(fn) : () => {}),
    };
  }

  // opts: { zoomEl, natural, comment, label } — zoomEl null means no pixel
  // zoom (charts/html/code: full-screen + comment only, no zoom buttons).
  // comment (optional) = { open(anchor), active(), subscribe(fn) } wiring the
  // "comment on the whole block" button + its already-commented style.
  function attachViewer(container, opts) {
    if (container._rlyTools) container._rlyTools.remove();
    container.classList.add('blk-viewer');
    const zoomable = Boolean(opts && opts.zoomEl);
    const label = (opts && opts.label) || 'visual';

    // pan listeners bind once per container; mermaid re-renders re-call
    // attachViewer, so reuse the existing refresh() instead of re-binding
    if (!container._rlyPan) container._rlyPan = enablePan(container);
    const refreshPan = container._rlyPan;

    // The toolbar is absolute inside the scroll box, so it scrolls away when the
    // user pans/scrolls. Counter-translate it by the scroll offset to pin it to
    // the visible corner (off in full-screen, where it is position:fixed). Bound
    // once; always re-reads the current toolbar (mermaid rebuilds it on render).
    if (!container._rlyToolsSync) {
      const sync = () => {
        const tb = container._rlyTools;
        if (!tb) return;
        if (container.classList.contains('blk-full')) { tb.style.transform = ''; return; }
        const x = container.scrollLeft, y = container.scrollTop;
        tb.style.transform = x || y ? 'translate(' + x + 'px,' + y + 'px)' : '';
      };
      container.addEventListener('scroll', sync);
      container._rlyToolsSync = sync;
    }

    // zoom level persists across re-renders; the wheel handler (bound once)
    // delegates through container._rlyZoom so it never holds a stale zoomEl
    if (container._rlyZ === undefined) container._rlyZ = null; // null = fit-to-width
    const pct = el('span', { class: 'tool-pct' }, 'fit');
    function apply() {
      if (!zoomable) return;
      const target = opts.zoomEl;
      const nat = opts.natural();
      const z = container._rlyZ;
      const full = container.classList.contains('blk-full');
      // A per-block height caps only the compact inline preview. The moment the
      // user zooms in (z !== null) or goes full-screen they want pixel detail, so
      // lift the cap there; restore it when back to the inline fit view.
      if (opts.fitMaxHeight != null) {
        target.style.maxHeight = z === null && !full ? opts.fitMaxHeight + 'px' : 'none';
      }
      if (z === null && full && nat && nat.w && nat.h) {
        // Full-screen default: scale the diagram/image to fill the viewport
        // (contain — enlarge a small one, shrink a big one) so it's readable at
        // a glance without reaching for the zoom buttons. CSS margin:auto centers
        // it; it stays pannable once the user zooms past this fit.
        const availW = window.innerWidth - FULL_PAD_X * 2;
        const availH = window.innerHeight - FULL_PAD_TOP - FULL_PAD_BOTTOM;
        const scale = Math.min(availW / nat.w, availH / nat.h);
        target.style.maxWidth = 'none';
        target.style.width = Math.max(1, Math.round(nat.w * scale)) + 'px';
        target.style.height = 'auto';
        pct.textContent = 'fit';
      } else if (z === null || !nat || !nat.w) {
        target.style.width = '100%';
        target.style.maxWidth = nat && nat.w ? Math.ceil(nat.w) + 'px' : '100%';
        target.style.height = 'auto';
        pct.textContent = 'fit';
      } else {
        target.style.maxWidth = 'none';
        target.style.width = Math.round(nat.w * z) + 'px';
        target.style.height = 'auto';
        pct.textContent = Math.round(z * 100) + '%';
      }
      window.dispatchEvent(new Event('resize')); // annotation badges reposition
      refreshPan();                              // content size → grab affordance
      container._rlyToolsSync();                 // keep the toolbar pinned
    }
    function currentZ() {
      if (container._rlyZ !== null) return container._rlyZ;
      const nat = opts.natural();
      if (!nat || !nat.w) return 1;
      const shown = opts.zoomEl.getBoundingClientRect().width;
      return shown > 0 ? shown / nat.w : 1;
    }
    function setZoom(next) {
      container._rlyZ = next === null ? null : Math.min(8, Math.max(0.2, next));
      apply();
    }
    container._rlyZoom = { setZoom, currentZ, reapply: apply };

    const tools = el('div', { class: 'blk-tools' });

    // comment on the whole block (leftmost) — opens the annotation popover with
    // a block-scoped target so a user can comment without picking an element.
    // The button gains a .has-comment style once the block carries one, kept in
    // sync via the annotate badge-refresh subscription (bound once per container).
    if (opts && opts.comment) {
      const cmt = opts.comment;
      const cBtn = el('button', { class: 'tool-comment', type: 'button', title: 'Comment on this whole ' + label });
      cBtn.innerHTML = ICON_COMMENT;
      cBtn.addEventListener('click', (e) => { e.stopPropagation(); cmt.open(container); });
      tools.append(cBtn);
      container._rlyCmtSync = () => {
        const b = container._rlyTools && container._rlyTools.querySelector('.tool-comment');
        if (b && cmt.active) b.classList.toggle('has-comment', !!cmt.active());
      };
      if (!container._rlyCmtHook && cmt.subscribe) {
        container._rlyCmtHook = cmt.subscribe(() => container._rlyCmtSync && container._rlyCmtSync());
      }
    }

    if (zoomable) {
      // cmd/ctrl+wheel zoom, bound ONCE (re-binding per render would stack);
      // delegates to the current controller so it never uses a stale zoomEl
      if (!container._rlyWheel) {
        const onWheel = (e) => {
          if (!(e.ctrlKey || e.metaKey) || !container._rlyZoom) return;
          e.preventDefault();
          container._rlyZoom.setZoom(container._rlyZoom.currentZ() * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        };
        container.addEventListener('wheel', onWheel, { passive: false });
        container._rlyWheel = onWheel;
      }
      const zoomOut = el('button', { class: 'tool-zoom', type: 'button', title: 'Zoom out' }, '−');
      const zoomIn = el('button', { class: 'tool-zoom', type: 'button', title: 'Zoom in' }, '+');
      zoomOut.addEventListener('click', (e) => { e.stopPropagation(); setZoom(currentZ() / 1.2); });
      zoomIn.addEventListener('click', (e) => { e.stopPropagation(); setZoom(currentZ() * 1.2); });
      pct.classList.add('is-btn');
      pct.title = 'Reset to fit';
      pct.addEventListener('click', (e) => { e.stopPropagation(); setZoom(null); });
      tools.append(zoomOut, pct, zoomIn);
    }

    const fullBtn = el('button', { class: 'tool-full', type: 'button', title: 'Full screen (Esc closes; ⌘/Ctrl+wheel zooms)' });
    fullBtn.innerHTML = ICON_EXPAND;
    fullBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fullOpen === container) { exitFull(); return; }
      exitFull();
      container.classList.add('blk-full');
      document.body.classList.add('blk-full-open');
      fullOpen = container;
      fullBtn.textContent = '✕';
      window.dispatchEvent(new Event('resize'));
      container._rlyToolsSync();
      if (container._rlyZoom) container._rlyZoom.reapply(); // lift any inline height cap
    });
    tools.append(fullBtn);

    container.append(tools);
    container._rlyTools = tools;
    if (zoomable) apply();
    // non-zoomable diagrams (tall mermaid, oversized image) can still overflow
    refreshPan();
    container._rlyToolsSync();
    if (container._rlyCmtSync) container._rlyCmtSync(); // reflect existing comment
  }

  function svgNatural(svgEl) {
    return () => {
      const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
      return vb && vb.width > 0 ? { w: vb.width, h: vb.height } : null;
    };
  }

  // ---------- html (sandboxed iframe) ----------
  function renderHtml(block, ctx, blockId) {
    const height = clampHeight(block.height, 360);
    const iframe = el('iframe', {
      class: 'viz',
      'data-block-id': blockId,
      'data-question-id': ctx.questionId || '',
      src: ctx.htmlSrc(blockId),
      height: String(height),
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals',
      loading: 'lazy',
    });
    const wrap = el('div', { class: 'blk-htmlwrap' }, iframe);
    attachViewer(wrap, { zoomEl: null, label: 'embed', comment: wholeBlockComment(ctx, blockId, 'embed') });
    return wrap;
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
        inner = renderCode(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'diff':
        inner = renderDiff(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'video':
        inner = renderVideo(block, ctx, blockId);
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
      case 'graphviz':
        inner = renderGraphviz(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'plantuml':
        inner = renderPlantuml(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'html':
        inner = renderHtml(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'image':
        inner = renderImage(block, ctx, blockId);
        wrapper.append(inner);
        break;
      case 'palette':
        inner = renderPalette(block, ctx, blockId);
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
      // editable-mermaid plumbing: edits maps blockId -> edited code; onBlockEdit
      // reports an accepted change (or null to clear back to the original).
      edits: ctx && ctx.edits ? ctx.edits : {},
      onBlockEdit:
        ctx && typeof ctx.onBlockEdit === 'function' ? ctx.onBlockEdit : () => {},
    };
    for (const block of list) {
      if (!block || !block.type) continue;
      container.append(renderBlock(block, safeCtx));
    }
  }

  // ---------- file-link open behavior ----------
  // A small toast pinned top-center (reuses the .toast style from style.css).
  // tone 'err' adds .toast-err so failures read as a problem, not a success.
  function fileToast(message, tone) {
    const t = el('div', { class: 'toast' + (tone === 'err' ? ' toast-err' : '') }, message);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  // POST the clicked path to /api/open; the server opens it in the OS default
  // app. The link is disabled mid-flight so a double-click can't double-open.
  async function openFilePath(a) {
    const p = a.dataset.rlyOpen;
    if (!p || a.classList.contains('is-opening')) return;
    a.classList.add('is-opening');
    try {
      const r = await fetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      let data = {};
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      if (r.ok && data.ok) fileToast('Opened ' + (data.name || p));
      else fileToast((data.error || 'Could not open') + ' — ' + p, 'err');
    } catch {
      fileToast('Could not reach the server to open ' + p, 'err');
    } finally {
      a.classList.remove('is-opening');
    }
  }

  // Delegated once on the document so it catches file-links anywhere they are
  // rendered — the intro, any markdown block, or a markdown pipe-table cell.
  // Keyboard-activatable (Enter/Space) since the links are role="link" anchors
  // with no href (the open happens via fetch, not navigation).
  function initFileLinks() {
    if (window.__relayFileLinksReady) return;
    window.__relayFileLinksReady = true;
    const hit = (e) => (e.target.closest ? e.target.closest('a.rly-filelink') : null);
    document.addEventListener('click', (e) => {
      const a = hit(e);
      if (!a) return;
      e.preventDefault();
      openFilePath(a);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const a = hit(e);
      if (!a) return;
      e.preventDefault();
      openFilePath(a);
    });
  }
  initFileLinks();

  window.RelayBlocks = { render, onThemeChange, renderMarkdown };
})();
