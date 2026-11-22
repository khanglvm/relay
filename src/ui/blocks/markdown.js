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
    // reference links [label](#ref:name) / [label](#block:id) open the named/identified
    // block in a full-screen modal — so a question can point back to a chart/image
    // shown earlier without the user scrolling up. Runs before the generic link
    // pass so the #ref:/#block: target isn't rendered as a plain href.
    s = s.replace(/\[([^\]]+)\]\(#(ref|block):([^)\s]+)\)/g, (_m, label, kind, target) =>
      keep(`<a class="rly-reflink" role="button" tabindex="0" data-rly-${kind === 'block' ? 'refid' : 'ref'}="${target}" title="Open this visual">` +
        `<span class="rly-reflink-ico" aria-hidden="true"></span><span>${label}</span></a>`));
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

