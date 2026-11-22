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

  // A line-number gutter for `text` (non-selectable so a select-to-comment grabs
  // only the code, not the numbers). When annotation is on, each number becomes a
  // hover/click target to comment on that exact line (kind:'code-line'); the
  // numbers still don't enter a text selection. `startAt` default 1.
  function lineGutter(text, startAt, ctx, blockId, filename) {
    const n = Math.max(1, String(text).replace(/\n+$/, '').split('\n').length);
    const annotate = ctx && ctx.annotate;
    const g = el('div', { class: 'blk-gutter' + (annotate ? ' blk-gutter-c' : ''), 'aria-hidden': annotate ? null : 'true' });
    for (let i = 0; i < n; i++) {
      const ln = (startAt || 1) + i;
      const lineEl = el('div', { class: 'blk-gutterline' }, String(ln));
      if (annotate) {
        annotate.register(lineEl, {
          blockId, questionId: ctx.questionId,
          target: { kind: 'code-line', line: ln, file: filename || '' },
        });
      }
      g.append(lineEl);
    }
    return g;
  }

  function renderCode(block, ctx, blockId) {
    // Drop a single trailing newline so the last source line isn't rendered as
    // an empty row the gutter has no number for (files usually end in "\n").
    const raw = (block.code || '').replace(/\n$/, '');
    const code = el('code');
    code.innerHTML = tintCode(raw, block.lang);
    const pre = el('pre', { class: 'blk-pre', 'data-lang': block.lang || '' }, code);
    const row = el('div', { class: 'blk-coderow' }, lineGutter(raw, 1, ctx, blockId, block.filename), pre);
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

