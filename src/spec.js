import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './util.js';

export const TYPES = ['single', 'multi', 'yesno', 'text', 'textarea', 'scale'];

const ALIASES = {
  radio: 'single',
  choice: 'single',
  select: 'single',
  checkbox: 'multi',
  checkboxes: 'multi',
  boolean: 'yesno',
  bool: 'yesno',
  yn: 'yesno',
  input: 'text',
  string: 'text',
  longtext: 'textarea',
  long: 'textarea',
  rating: 'scale',
  likert: 'scale',
};

const HTML_HEIGHT = { min: 100, max: 2400, boardDefault: 400, questionDefault: 360 };

// Block heights clamp to the same window; defaults vary per block type.
const BLOCK_HEIGHT = { min: 100, max: 2400 };
export const BLOCK_TYPES = ['markdown', 'mermaid', 'graphviz', 'plantuml', 'chart', 'table', 'code', 'diff', 'video', 'html', 'image'];
const CHART_KINDS = ['bar', 'line', 'pie', 'doughnut', 'radar', 'scatter'];

// code/diff blocks may load their text from a local file (like htmlFile). Caps
// keep a runaway file from bloating the board payload.
const TEXT_FILE_MAX_BYTES = 512 * 1024;

// video blocks: a YouTube/Vimeo link embeds via iframe; an http(s) media URL or
// a local file plays in a <video> element (local files stream from the server,
// never embedded, so large clips don't bloat the board).
const VIDEO_MIMES = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
  ogg: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska',
};
const VIDEO_MAX_BYTES = 512 * 1024 * 1024;

// image blocks: local files are embedded as data URIs at spec time (the page
// then loads them via /img/b/<id>), so boards stay self-contained offline.
const IMAGE_MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
};
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const asStr = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function readHtml(obj, cwd, where) {
  if (typeof obj.html === 'string' && obj.html.trim()) return obj.html;
  if (typeof obj.htmlFile === 'string' && obj.htmlFile.trim()) {
    const p = path.resolve(cwd, obj.htmlFile);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      throw new CliError(`${where}: cannot read htmlFile "${obj.htmlFile}" (resolved: ${p})`);
    }
  }
  return '';
}

// Reads an html-block body from either an inline string or a file path.
function readBlockHtml(block, cwd, where) {
  if (typeof block.html === 'string' && block.html) return block.html;
  if (typeof block.htmlFile === 'string' && block.htmlFile.trim()) {
    const p = path.resolve(cwd, block.htmlFile);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      throw new CliError(`${where}: cannot read htmlFile "${block.htmlFile}" (resolved: ${p})`);
    }
  }
  return '';
}

// Reads a code/diff block body from an inline string field or a local file.
// `inlineKey` is the inline field (e.g. "code"/"diff"); `fileKey` its file
// twin (e.g. "codeFile"/"diffFile"). Returns '' when neither is present.
function readTextSource(block, inlineKey, fileKey, cwd, where) {
  if (typeof block[inlineKey] === 'string' && block[inlineKey] !== '') return block[inlineKey];
  if (typeof block[fileKey] === 'string' && block[fileKey].trim()) {
    const p = path.resolve(cwd, block[fileKey]);
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch {
      throw new CliError(`${where}: cannot read ${fileKey} "${block[fileKey]}" (resolved: ${p})`);
    }
    if (buf.length > TEXT_FILE_MAX_BYTES) {
      throw new CliError(`${where}: ${fileKey} "${block[fileKey]}" is ${(buf.length / 1024).toFixed(0)}KB — max ${TEXT_FILE_MAX_BYTES / 1024}KB.`);
    }
    return buf.toString('utf8');
  }
  return '';
}

// Recognizes a YouTube / Vimeo URL (or a bare YouTube id) and returns
// {provider, videoId, start} for an iframe embed, else null. Cross-platform —
// pure string parsing, no URL host assumptions beyond the known providers.
function parseVideoEmbed(src) {
  const s = String(src).trim();
  // bare 11-char YouTube id
  if (/^[\w-]{11}$/.test(s)) return { provider: 'youtube', videoId: s, start: 0 };
  let m;
  if ((m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{11})/i))) {
    const t = s.match(/[?&](?:t|start)=(\d+)/);
    return { provider: 'youtube', videoId: m[1], start: t ? Number(t[1]) : 0 };
  }
  if ((m = s.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) {
    return { provider: 'vimeo', videoId: m[1], start: 0 };
  }
  return null;
}

// Normalizes one block object. `id` is the already-assigned block id.
// Returns the normalized block (with a guaranteed string `type` + `id`).
function normalizeBlock(rawBlock, id, cwd, where) {
  if (rawBlock === null || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
    throw new CliError(`${where}: must be an object with a "type".`);
  }
  let type = asStr(rawBlock.type).trim().toLowerCase();
  if (!type) throw new CliError(`${where}: missing "type". Valid: ${BLOCK_TYPES.join(', ')}.`);
  if (!BLOCK_TYPES.includes(type)) {
    throw new CliError(`${where}: unknown block type "${rawBlock.type}". Valid: ${BLOCK_TYPES.join(', ')}.`);
  }

  const hasHeight = rawBlock.height !== undefined && rawBlock.height !== null && rawBlock.height !== '';

  if (type === 'markdown') {
    const md = asStr(rawBlock.md);
    if (!md.trim()) throw new CliError(`${where}: markdown block needs a non-empty "md" string.`);
    const block = { id, type: 'markdown', md };
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'mermaid') {
    const code = asStr(rawBlock.code);
    if (!code.trim()) throw new CliError(`${where}: mermaid block needs a non-empty "code" string.`);
    const block = { id, type: 'mermaid', code };
    if (rawBlock.editable === true) block.editable = true;
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'graphviz') {
    const dot = asStr(rawBlock.dot);
    if (!dot.trim()) throw new CliError(`${where}: graphviz block needs a non-empty "dot" string.`);
    const block = { id, type: 'graphviz', dot };
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'plantuml') {
    const code = asStr(rawBlock.code);
    if (!code.trim()) throw new CliError(`${where}: plantuml block needs a non-empty "code" string.`);
    const block = { id, type: 'plantuml', code };
    if (rawBlock.server !== undefined && rawBlock.server !== null && rawBlock.server !== '') {
      const server = asStr(rawBlock.server).trim();
      if (!/^https?:\/\/\S+$/i.test(server)) {
        throw new CliError(`${where}: plantuml "server" must be an http(s) URL string.`);
      }
      block.server = server;
    }
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'code') {
    const code = readTextSource(rawBlock, 'code', 'codeFile', cwd, where);
    if (!code) throw new CliError(`${where}: code block needs a "code" string or a readable "codeFile".`);
    const block = { id, type: 'code', code };
    if (rawBlock.lang !== undefined) block.lang = asStr(rawBlock.lang);
    // lang defaults from the codeFile extension when not given explicitly.
    else if (typeof rawBlock.codeFile === 'string' && rawBlock.codeFile.trim()) {
      const ext = path.extname(rawBlock.codeFile).slice(1).toLowerCase();
      if (ext) block.lang = ext;
    }
    if (rawBlock.filename !== undefined) block.filename = asStr(rawBlock.filename);
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'diff') {
    const diff = readTextSource(rawBlock, 'diff', 'diffFile', cwd, where);
    if (!diff.trim()) throw new CliError(`${where}: diff block needs a non-empty "diff" string (unified diff) or a readable "diffFile".`);
    const block = { id, type: 'diff', diff };
    if (rawBlock.lang !== undefined) block.lang = asStr(rawBlock.lang);
    if (rawBlock.filename !== undefined) block.filename = asStr(rawBlock.filename);
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'video') {
    const src = asStr(rawBlock.src ?? rawBlock.file ?? rawBlock.url).trim();
    if (!src) throw new CliError(`${where}: video block needs a "src" (YouTube/Vimeo URL, http(s) media URL, or local file path).`);
    const block = { id, type: 'video' };
    if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
    if (rawBlock.alt !== undefined) block.title = asStr(rawBlock.alt);
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    const embed = parseVideoEmbed(src);
    if (embed) {
      block.provider = embed.provider;
      block.videoId = embed.videoId;
      if (embed.start) block.start = embed.start;
      return block;
    }
    if (/^https?:/i.test(src)) {
      block.src = src;
      const ext = path.extname(src.split(/[?#]/)[0]).slice(1).toLowerCase();
      if (VIDEO_MIMES[ext]) block.mime = VIDEO_MIMES[ext];
      return block;
    }
    // local file — kept as an absolute path the server streams (never embedded
    // in the payload). The client only learns a flag + mime via /video/b/<id>.
    const p = path.resolve(cwd, src);
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = VIDEO_MIMES[ext];
    if (!mime) {
      throw new CliError(`${where}: unsupported video extension ".${ext}" — use ${Object.keys(VIDEO_MIMES).join('/')}, a YouTube/Vimeo URL, or an http(s) media URL.`);
    }
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      throw new CliError(`${where}: cannot read video "${src}" (resolved: ${p})`);
    }
    if (stat.size > VIDEO_MAX_BYTES) {
      throw new CliError(`${where}: video "${src}" is ${(stat.size / 1024 / 1024).toFixed(0)}MB — max ${VIDEO_MAX_BYTES / 1024 / 1024}MB.`);
    }
    block.file = p;
    block.mime = mime;
    if (!block.title) block.title = path.basename(p);
    return block;
  }

  if (type === 'chart') {
    const hasConfig = rawBlock.config && typeof rawBlock.config === 'object' && !Array.isArray(rawBlock.config);
    const hasShorthand =
      typeof rawBlock.kind === 'string' ||
      Array.isArray(rawBlock.labels) ||
      Array.isArray(rawBlock.series);
    if (!hasConfig && !hasShorthand) {
      throw new CliError(`${where}: chart needs "config" (full Chart.js config) or "kind"+"labels"+"series".`);
    }
    const block = { id, type: 'chart' };
    block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, 320);
    if (hasConfig) {
      block.config = rawBlock.config;
      return block;
    }
    // Shorthand form: validate kind/labels/series.
    const kind = asStr(rawBlock.kind).trim().toLowerCase();
    if (!kind) throw new CliError(`${where}: chart shorthand needs a "kind" (${CHART_KINDS.join('|')}).`);
    if (!CHART_KINDS.includes(kind)) {
      throw new CliError(`${where}: unknown chart kind "${rawBlock.kind}". Valid: ${CHART_KINDS.join(', ')}.`);
    }
    if (!Array.isArray(rawBlock.labels)) {
      throw new CliError(`${where}: chart shorthand needs a "labels" array.`);
    }
    if (!Array.isArray(rawBlock.series) || rawBlock.series.length < 1) {
      throw new CliError(`${where}: chart shorthand needs a non-empty "series" array of {label, data[]}.`);
    }
    block.kind = kind;
    block.labels = rawBlock.labels.map((l) => asStr(l));
    block.series = rawBlock.series.map((s, k) => {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        throw new CliError(`${where}.series[${k}]: must be an object {label, data[]}.`);
      }
      if (!Array.isArray(s.data)) {
        throw new CliError(`${where}.series[${k}]: needs a "data" array.`);
      }
      const out = { label: asStr(s.label), data: s.data };
      if (s.color !== undefined) out.color = asStr(s.color);
      return out;
    });
    if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
    return block;
  }

  if (type === 'table') {
    if (!Array.isArray(rawBlock.columns) || rawBlock.columns.length < 1) {
      throw new CliError(`${where}: table needs a non-empty "columns" array (strings or {key,label,align?}).`);
    }
    if (!Array.isArray(rawBlock.rows)) {
      throw new CliError(`${where}: table needs a "rows" array.`);
    }
    const columns = rawBlock.columns.map((c, k) => {
      if (typeof c === 'string' || typeof c === 'number') {
        const key = String(c);
        return { key, label: key };
      }
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        const key = asStr(c.key ?? c.label).trim();
        if (!key) throw new CliError(`${where}.columns[${k}]: needs "key" or "label".`);
        const col = { key, label: asStr(c.label ?? c.key) || key };
        if (c.align !== undefined) col.align = asStr(c.align);
        return col;
      }
      throw new CliError(`${where}.columns[${k}]: must be a string or {key, label, align?}.`);
    });
    // Normalize array rows into objects keyed by column key, so the client
    // (and table-cell annotation values) always index rows the same way.
    const rows = rawBlock.rows.map((r, ri) => {
      if (Array.isArray(r)) {
        const obj = {};
        columns.forEach((col, ci) => {
          obj[col.key] = r[ci];
        });
        return obj;
      }
      if (r && typeof r === 'object') return r;
      throw new CliError(`${where}.rows[${ri}]: must be an array or an object.`);
    });
    const block = { id, type: 'table', columns, rows };
    if (rawBlock.sortable === true) block.sortable = true;
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'image') {
    const src = asStr(rawBlock.src ?? rawBlock.file ?? rawBlock.url).trim();
    if (!src) throw new CliError(`${where}: image block needs a "src" (http(s)/data URL or local file path).`);
    const block = { id, type: 'image' };
    if (rawBlock.alt !== undefined) block.alt = asStr(rawBlock.alt);
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    if (/^(https?:|data:)/i.test(src)) {
      block.src = src;
      return block;
    }
    const p = path.resolve(cwd, src);
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = IMAGE_MIMES[ext];
    if (!mime) {
      throw new CliError(`${where}: unsupported image extension ".${ext}" — use ${Object.keys(IMAGE_MIMES).join('/')}, or an http(s)/data URL.`);
    }
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch {
      throw new CliError(`${where}: cannot read image "${src}" (resolved: ${p})`);
    }
    if (buf.length > IMAGE_MAX_BYTES) {
      throw new CliError(`${where}: image "${src}" is ${(buf.length / 1024 / 1024).toFixed(1)}MB — max ${IMAGE_MAX_BYTES / 1024 / 1024}MB.`);
    }
    block.src = `data:${mime};base64,${buf.toString('base64')}`;
    return block;
  }

  // type === 'html'
  const html = readBlockHtml(rawBlock, cwd, where);
  if (!html) {
    throw new CliError(`${where}: html block needs an "html" string or readable "htmlFile".`);
  }
  return {
    id,
    type: 'html',
    html,
    height: clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, 360),
  };
}

// Builds the normalized block list for a scope (board or question).
// Legacy html/htmlFile become a PREPENDED html block; ids are assigned in
// final order with `prefix` ('' for board → b1,b2…; '<qid>-' for questions).
function buildBlocks(rawObj, cwd, where, prefix) {
  const blocks = [];
  let n = 0;
  const nextId = () => `${prefix}b${++n}`;

  // Legacy html/htmlFile → a single prepended html block. htmlHeight applies.
  const legacyHtml = readHtml(rawObj, cwd, where);
  if (legacyHtml) {
    const def = prefix ? HTML_HEIGHT.questionDefault : HTML_HEIGHT.boardDefault;
    blocks.push({
      id: nextId(),
      type: 'html',
      html: legacyHtml,
      height: clampInt(rawObj.htmlHeight, HTML_HEIGHT.min, HTML_HEIGHT.max, def),
    });
  }

  if (rawObj.blocks !== undefined && rawObj.blocks !== null) {
    if (!Array.isArray(rawObj.blocks)) throw new CliError(`${where}.blocks: must be an array.`);
    rawObj.blocks.forEach((b, i) => {
      blocks.push(normalizeBlock(b, nextId(), cwd, `${where}.blocks[${i}]`));
    });
  }
  return blocks;
}

export function normalizeSpec(raw, { cwd = process.cwd() } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('Spec must be a JSON object. Run `rly agent` for the schema and examples.');
  }
  const spec = {
    title: asStr(raw.title).trim() || 'Relay',
    intro: asStr(raw.intro),
    blocks: buildBlocks(raw, cwd, 'board', ''),
    allowPartial: raw.allowPartial !== false,
    note: raw.note !== false,
    autoClose: raw.autoClose !== false,
    questions: [],
    submitLabel: '',
  };

  const rawQs = raw.questions == null ? [] : raw.questions;
  if (!Array.isArray(rawQs)) throw new CliError('"questions" must be an array.');

  const seen = new Set();
  rawQs.forEach((rq, i) => {
    const where = `questions[${i}]`;
    if (rq === null || typeof rq !== 'object' || Array.isArray(rq)) {
      throw new CliError(`${where}: must be an object.`);
    }
    const label = asStr(rq.label ?? rq.question ?? rq.text).trim();
    if (!label) throw new CliError(`${where}: missing "label".`);

    let type = asStr(rq.type).trim().toLowerCase() || 'text';
    type = ALIASES[type] || type;
    if (!TYPES.includes(type)) {
      throw new CliError(`${where}: unknown type "${rq.type}". Valid: ${TYPES.join(', ')} (plus aliases like radio/checkbox/boolean/rating).`);
    }

    const id = asStr(rq.id).trim() || `q${i + 1}`;
    if (seen.has(id)) throw new CliError(`${where}: duplicate question id "${id}".`);
    seen.add(id);

    const q = {
      id,
      type,
      label,
      description: asStr(rq.description),
      required: rq.required === true,
      // Radio (single) questions show the optional per-answer note by default so
      // the user can qualify their pick; other types stay opt-in. An explicit
      // note:false turns it off for a single question.
      note: rq.note === undefined ? type === 'single' : rq.note === true,
      blocks: buildBlocks(rq, cwd, where, `${id}-`),
      placeholder: asStr(rq.placeholder),
    };

    if (type === 'single' || type === 'multi') {
      const opts = Array.isArray(rq.options) ? rq.options : [];
      q.options = opts.map((o, j) => {
        if (typeof o === 'string' || typeof o === 'number') {
          return { value: String(o), label: String(o) };
        }
        if (o && typeof o === 'object') {
          const value = asStr(o.value ?? o.label).trim();
          const olabel = asStr(o.label ?? o.value).trim();
          if (!value) throw new CliError(`${where}.options[${j}]: needs "value" or "label".`);
          const out = { value, label: olabel || value };
          if (o.description) out.description = asStr(o.description);
          // Per-option visuals: any block type, rendered inside the option card
          // (ids <qid>-o<n>-b<m>). Lets a choice show its example instead of
          // making the user read-and-guess.
          const oblocks = buildBlocks(o, cwd, `${where}.options[${j}]`, `${id}-o${j + 1}-`);
          if (oblocks.length) out.blocks = oblocks;
          return out;
        }
        throw new CliError(`${where}.options[${j}]: must be a string or {value, label, description?, blocks?}.`);
      });
      if (q.options.length < 1) {
        throw new CliError(`${where}: type "${type}" needs at least 1 option.`);
      }
      q.other = rq.other === true;
    }

    if (type === 'scale') {
      q.min = clampInt(rq.min, 0, 9, 1);
      q.max = clampInt(rq.max, q.min + 1, 10, Math.max(5, q.min + 1));
      q.minLabel = asStr(rq.minLabel);
      q.maxLabel = asStr(rq.maxLabel);
    }

    if (rq.default !== undefined) q.default = rq.default;
    spec.questions.push(q);
  });

  if (!spec.questions.length && !spec.blocks.length) {
    throw new CliError('Spec needs "questions" and/or "blocks"/"html" — nothing to show.');
  }
  spec.submitLabel = asStr(raw.submitLabel).trim() || (spec.questions.length ? 'Submit' : 'Acknowledge');
  return spec;
}

// Inline question syntax for `rly ask -q`:  "[!]label::type::opt1,opt2"
// Leading "!" marks the question required. type defaults to "text".
export function questionFromInline(s, i) {
  let body = asStr(s).trim();
  let required = false;
  if (body.startsWith('!')) {
    required = true;
    body = body.slice(1).trim();
  }
  const [label, type, options] = body.split('::').map((p) => p.trim());
  if (!label) throw new CliError(`-q #${i + 1}: empty question text.`);
  const q = { label, required };
  if (type) q.type = type;
  if (options) q.options = options.split(',').map((o) => o.trim()).filter(Boolean);
  return q;
}

const BLOCK_SCHEMA = {
  type: 'array',
  description:
    'Rich content blocks rendered in order. Board-level blocks show above the questions; per-question blocks show above the control. Each is annotatable (element-level comments returned in result.annotations).',
  items: {
    type: 'object',
    required: ['type'],
    properties: {
      type: { type: 'string', enum: BLOCK_TYPES },
      md: { type: 'string', description: 'markdown: built-in mini renderer (no external library) — headings, lists, code, quotes, links, and GFM pipe tables. Text selections are commentable. For real tabular data prefer a "table" block (sortable + per-cell comments).' },
      code: { type: 'string', description: 'mermaid: diagram source (e.g. "graph TD; A-->B"); plantuml: the @startuml…@enduml source; code: the source to display (syntax-highlighted with line numbers).' },
      codeFile: { type: 'string', description: 'code: path to a local source file to load + display instead of inline "code". Resolved against the CWD; lang defaults from the file extension.' },
      filename: { type: 'string', description: 'code/diff: optional file name/path shown as a header label above the block.' },
      editable: { type: 'boolean', description: 'mermaid: when true, render an "Edit diagram" toggle so the user can edit the diagram source live. The edited source is returned in result.blockEdits[<blockId>].' },
      dot: { type: 'string', description: 'graphviz: DOT source (e.g. "digraph { a -> b }"). Rendered offline via vendored Viz.js; nodes and edges are individually commentable.' },
      server: { type: 'string', description: 'plantuml: PlantUML server base URL (http(s)). Defaults to https://www.plantuml.com/plantuml. Diagrams render via this server (needs network).' },
      lang: { type: 'string', description: 'code/diff block: language hint for syntax highlighting (js, ts, py, go, rust, java, c, cpp, csharp, ruby, php, swift, kotlin, sql, yaml, json, sh, css, html, …).' },
      diff: { type: 'string', description: 'diff: a unified diff (git diff / diff -u output) — rendered as a colored, line-numbered comparison with +added / −removed / context rows and file/hunk headers. No git needed; just write/paste the diff text.' },
      diffFile: { type: 'string', description: 'diff: path to a local file containing a unified diff (alternative to "diff"). Resolved against the CWD.' },
      config: { type: 'object', description: 'chart: a full Chart.js config object.' },
      kind: { type: 'string', enum: CHART_KINDS, description: 'chart shorthand: chart kind (alternative to "config").' },
      labels: { type: 'array', description: 'chart shorthand: x-axis / category labels.' },
      series: {
        type: 'array',
        description: 'chart shorthand: [{label, data:[...], color?}]. Chart data points are individually commentable.',
        items: { type: 'object', properties: { label: { type: 'string' }, data: { type: 'array' }, color: { type: 'string' } } },
      },
      title: { type: 'string', description: 'chart shorthand: chart title. video: title/caption shown under the player.' },
      columns: {
        type: 'array',
        description: 'table: strings, or {key, label, align?}. Cells are commentable.',
        items: { anyOf: [{ type: 'string' }, { type: 'object' }] },
      },
      rows: { type: 'array', description: 'table: array of arrays (positional) or array of objects (keyed by column key).' },
      sortable: { type: 'boolean', description: 'table: enable click-to-sort headers.' },
      html: { type: 'string', description: 'html: custom markup rendered in a sandboxed iframe.' },
      htmlFile: { type: 'string', description: 'html: path to an HTML file (alternative to "html").' },
      src: { type: 'string', description: 'image: http(s)/data URL, or a local file path (png/jpg/gif/webp/svg/avif/bmp — embedded at spec time, served offline). video: a YouTube/Vimeo URL (embeds an iframe player), an http(s) media URL, or a local video file (mp4/webm/ogv/mov/mkv/m4v — streamed from the server, never embedded).' },
      alt: { type: 'string', description: 'image: alt text / annotation label. video: accessible title for the player.' },
      height: { type: 'integer', minimum: BLOCK_HEIGHT.min, maximum: BLOCK_HEIGHT.max, description: 'Block height in px. Defaults: chart 320, html 360; markdown/table/code flow naturally; mermaid/graphviz/plantuml/image natural (max 1200, scrolls).' },
    },
  },
};

export const SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'relay board spec',
  type: 'object',
  description:
    'A relay board. Renders an optional intro, board-level blocks, then questions (each with optional per-question blocks), then a submit button. The result JSON contains "answers", "comment", per-question "notes", "annotations" (element-level comments the user attached to any block — see the annotation shape below), and "blockEdits" (a map blockId→edited source for any editable mermaid block the user changed, null when none).',
  properties: {
    title: { type: 'string', description: 'Board title (default "Relay")' },
    intro: { type: 'string', description: 'Intro text shown under the title. Newlines preserved.' },
    blocks: BLOCK_SCHEMA,
    html: { type: 'string', description: 'Legacy: board-level custom HTML. Normalized into a single html block PREPENDED to "blocks".' },
    htmlFile: { type: 'string', description: 'Legacy: path to an HTML file (alternative to "html"). Resolved against the CWD. Normalized into a prepended html block.' },
    htmlHeight: { type: 'integer', minimum: HTML_HEIGHT.min, maximum: HTML_HEIGHT.max, default: HTML_HEIGHT.boardDefault, description: 'Legacy: iframe height for the html/htmlFile block.' },
    allowPartial: { type: 'boolean', default: true, description: 'When true, users may submit with unanswered questions (returned in "skipped").' },
    note: { type: 'boolean', default: true, description: 'Show an optional free-text note box ("Anything else?") returned as "comment".' },
    autoClose: { type: 'boolean', default: true, description: 'Try to close the browser tab automatically after submit.' },
    submitLabel: { type: 'string', description: 'Submit button label. Defaults: "Submit", or "Acknowledge" when there are no questions.' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label'],
        properties: {
          id: { type: 'string', description: 'Answer key in the result JSON. Defaults to q1, q2, …' },
          type: { type: 'string', enum: ['single', 'multi', 'yesno', 'text', 'textarea', 'scale'], default: 'text' },
          label: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean', default: false },
          options: {
            type: 'array',
            description: 'For single/multi. Strings, or {value, label, description, blocks?}. An option\'s "blocks" render INSIDE that option card — use them to show each choice (image/chart/mermaid/html…) instead of describing it in words.',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                    blocks: { ...BLOCK_SCHEMA, description: 'Visuals for THIS option, rendered inside its card. Same block types as everywhere else. Keep them compact (height ~140–260).' },
                  },
                },
              ],
            },
          },
          other: { type: 'boolean', default: false, description: 'single/multi: add a free-text "Other" option. Its text is returned verbatim as the value.' },
          note: { type: 'boolean', description: 'Small optional free-text field under the question (to qualify an answer). Returned separately as result.notes[questionId]. Defaults to true for "single" (radio) questions so users can comment on their pick, false for other types; set note:false to hide it on a single question.' },
          placeholder: { type: 'string', description: 'For text/textarea.' },
          default: { description: 'Pre-selected value. Shape matches the answer shape for the type.' },
          min: { type: 'integer', default: 1, description: 'scale only' },
          max: { type: 'integer', default: 5, maximum: 10, description: 'scale only' },
          minLabel: { type: 'string', description: 'scale only' },
          maxLabel: { type: 'string', description: 'scale only' },
          blocks: BLOCK_SCHEMA,
          html: { type: 'string', description: 'Legacy: per-question custom HTML. Normalized into an html block prepended to this question\'s "blocks".' },
          htmlFile: { type: 'string', description: 'Legacy: path to an HTML file (alternative to "html").' },
          htmlHeight: { type: 'integer', minimum: HTML_HEIGHT.min, maximum: HTML_HEIGHT.max, default: HTML_HEIGHT.questionDefault, description: 'Legacy: iframe height for the html/htmlFile block.' },
        },
      },
    },
    annotations: {
      type: 'array',
      readOnly: true,
      description:
        'Returned in the result (not part of the input spec). Element-level comments the user attached to blocks. Each: {id, questionId|null, blockId|null, target:{kind:"chart-element"|"mermaid-node"|"graphviz-node"|"table-cell"|"text"|"html-element"|"image", …}, text, createdAt}. For html-element, target carries a stable ref + label; users can hover any element of a custom-HTML block (automatic) or ones the author marked with data-relay-annotate.',
    },
    blockEdits: {
      type: 'object',
      readOnly: true,
      description:
        'Returned in the result (not part of the input spec). A map blockId→edited mermaid source for any editable mermaid block the user changed. null when the user made no edits. Read result.blockEdits[<blockId>] for the user\'s edited diagram source.',
    },
  },
  anyOf: [{ required: ['questions'] }, { required: ['blocks'] }, { required: ['html'] }, { required: ['htmlFile'] }],
};
