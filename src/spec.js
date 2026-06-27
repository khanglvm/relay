import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './util.js';

export const TYPES = ['single', 'multi', 'yesno', 'text', 'textarea', 'scale', 'color', 'rank', 'checklist', 'allocate'];

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
  colour: 'color',
  swatch: 'color',
  ranking: 'rank',
  order: 'rank',
  ordering: 'rank',
  prioritize: 'rank',
  sort: 'rank',
  signoff: 'checklist',
  'sign-off': 'checklist',
  qa: 'checklist',
  allocation: 'allocate',
  budget: 'allocate',
  distribute: 'allocate',
  points: 'allocate',
};

const HTML_HEIGHT = { min: 100, max: 2400, boardDefault: 400, questionDefault: 360 };

// Block heights clamp to the same window; defaults vary per block type.
const BLOCK_HEIGHT = { min: 100, max: 2400 };
export const BLOCK_TYPES = ['markdown', 'mermaid', 'graphviz', 'plantuml', 'chart', 'table', 'code', 'diff', 'video', 'html', 'image', 'palette', 'kpi', 'typography', 'compare'];
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

// Resolve an image source (shared by the `image` and `compare` blocks): an
// http(s)/data URL passes through; a local file is read + embedded as a data
// URI (capped) so the board stays self-contained offline.
function resolveImageSrc(srcRaw, cwd, where, field) {
  const src = asStr(srcRaw).trim();
  if (!src) throw new CliError(`${where}: ${field} needs a "src" (http(s)/data URL or local file path).`);
  if (/^(https?:|data:)/i.test(src)) return src;
  const p = path.resolve(cwd, src);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) throw new CliError(`${where}: ${field}: unsupported image extension ".${ext}" — use ${Object.keys(IMAGE_MIMES).join('/')}, or an http(s)/data URL.`);
  let buf;
  try { buf = fs.readFileSync(p); } catch { throw new CliError(`${where}: ${field}: cannot read image "${src}" (resolved: ${p})`); }
  if (buf.length > IMAGE_MAX_BYTES) throw new CliError(`${where}: ${field}: image "${src}" is ${(buf.length / 1024 / 1024).toFixed(1)}MB — max ${IMAGE_MAX_BYTES / 1024 / 1024}MB.`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Minimal RFC-4180-ish CSV/TSV parser: handles quoted fields containing the
// delimiter, embedded newlines, and "" escaped quotes. Returns an array of rows
// (each an array of string cells). Library-free.
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === delim) pushField();
    else if (c === '\n') pushRow();
    else if (c === '\r') { /* swallow CR (CRLF) */ }
    else field += c;
  }
  if (field.length || row.length) pushRow();
  // drop a single trailing empty row from a final newline
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

// Load table {columns, rows} from a local .csv/.tsv/.json file (rowsFile).
// CSV/TSV: first row = header → column keys. JSON: an array of objects (columns
// from the union of keys) or arrays (needs explicit "columns").
function loadRowsFile(file, cwd, where) {
  const p = path.resolve(cwd, file);
  let buf;
  try { buf = fs.readFileSync(p); } catch { throw new CliError(`${where}: cannot read rowsFile "${file}" (resolved: ${p})`); }
  if (buf.length > TEXT_FILE_MAX_BYTES) {
    throw new CliError(`${where}: rowsFile "${file}" is ${(buf.length / 1024).toFixed(0)}KB — max ${TEXT_FILE_MAX_BYTES / 1024}KB.`);
  }
  const text = buf.toString('utf8');
  const ext = path.extname(p).slice(1).toLowerCase();
  if (ext === 'json') {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new CliError(`${where}: rowsFile "${file}" JSON parse error: ${e.message}`); }
    if (!Array.isArray(data)) throw new CliError(`${where}: rowsFile "${file}" JSON must be an array of rows.`);
    const cols = [];
    for (const r of data) {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      }
    }
    return { columns: cols, rows: data };
  }
  const parsed = parseDelimited(text, ext === 'tsv' ? '\t' : ',');
  if (!parsed.length) return { columns: [], rows: [] };
  const header = parsed[0].map((h) => String(h).trim());
  const rows = parsed.slice(1).map((cells) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] !== undefined ? cells[i] : ''; });
    return obj;
  });
  return { columns: header, rows };
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
    const md = readTextSource(rawBlock, 'md', 'mdFile', cwd, where);
    if (!md.trim()) throw new CliError(`${where}: markdown block needs a non-empty "md" string or a readable "mdFile".`);
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
    const view = asStr(rawBlock.view).trim().toLowerCase();
    if (view === 'split' || view === 'unified') block.view = view;
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
    // Rows/columns may come from a local .csv/.tsv/.json file instead of inline.
    let rawColumns = rawBlock.columns;
    let rawRows = rawBlock.rows;
    if (typeof rawBlock.rowsFile === 'string' && rawBlock.rowsFile.trim() && !Array.isArray(rawRows)) {
      const loaded = loadRowsFile(rawBlock.rowsFile, cwd, where);
      rawRows = loaded.rows;
      if (!Array.isArray(rawColumns) || !rawColumns.length) rawColumns = loaded.columns;
    }
    if (!Array.isArray(rawColumns) || rawColumns.length < 1) {
      throw new CliError(`${where}: table needs a non-empty "columns" array (strings or {key,label,align?})${rawBlock.rowsFile ? ' — the rowsFile had no header/keys to infer them' : ''}.`);
    }
    if (!Array.isArray(rawRows)) {
      throw new CliError(`${where}: table needs a "rows" array or a readable "rowsFile".`);
    }
    const columns = rawColumns.map((c, k) => {
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
    const rows = rawRows.map((r, ri) => {
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
    if (rawBlock.filterable === true) block.filterable = true;
    if (rawBlock.exportable === true) block.exportable = true;
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'image') {
    const block = { id, type: 'image' };
    block.src = resolveImageSrc(rawBlock.src ?? rawBlock.file ?? rawBlock.url, cwd, where, 'image block');
    if (rawBlock.alt !== undefined) block.alt = asStr(rawBlock.alt);
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'kpi') {
    // Stat cards: a row of big-number metrics, each with an optional delta
    // (up/down tinted) and sublabel. For "revenue ↑12%" at a glance, no chart.
    const rawItems = Array.isArray(rawBlock.items) ? rawBlock.items : [];
    if (!rawItems.length) throw new CliError(`${where}: kpi block needs a non-empty "items" array of {label, value, delta?, dir?, sub?}.`);
    const items = rawItems.map((it, k) => {
      if (it === null || typeof it !== 'object' || Array.isArray(it)) throw new CliError(`${where}.items[${k}]: must be an object {label, value, …}.`);
      const out = { label: asStr(it.label), value: asStr(it.value) };
      if (it.delta !== undefined && it.delta !== null && it.delta !== '') out.delta = asStr(it.delta);
      const dir = asStr(it.dir ?? it.deltaDir).trim().toLowerCase();
      if (dir === 'up' || dir === 'down' || dir === 'flat') out.dir = dir;
      if (it.sub !== undefined) out.sub = asStr(it.sub);
      return out;
    });
    const block = { id, type: 'kpi', items };
    if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
    return block;
  }

  if (type === 'typography') {
    // Type specimens: render sample text at given size/weight/font so a designer
    // can react to type choices the way they react to a palette.
    const raw = Array.isArray(rawBlock.specimens) ? rawBlock.specimens : (Array.isArray(rawBlock.samples) ? rawBlock.samples : []);
    if (!raw.length) throw new CliError(`${where}: typography block needs a non-empty "specimens" array of {label?, size?, weight?, text?}.`);
    const specimens = raw.map((s, k) => {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new CliError(`${where}.specimens[${k}]: must be an object.`);
      const out = { text: asStr(s.text ?? s.sample) || 'The quick brown fox jumps over the lazy dog' };
      if (s.label !== undefined) out.label = asStr(s.label);
      if (s.size !== undefined) out.size = asStr(s.size);
      if (s.weight !== undefined) out.weight = asStr(s.weight);
      if (s.font !== undefined) out.font = asStr(s.font);
      const lh = s.lineHeight ?? s.leading;
      if (lh !== undefined) out.lineHeight = asStr(lh);
      const ls = s.letterSpacing ?? s.tracking;
      if (ls !== undefined) out.letterSpacing = asStr(ls);
      return out;
    });
    const block = { id, type: 'typography', specimens };
    if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
    if (rawBlock.font !== undefined) block.font = asStr(rawBlock.font);
    return block;
  }

  if (type === 'compare') {
    // Before/after: two images with a draggable divider to compare a redesign.
    const beforeRaw = rawBlock.before && typeof rawBlock.before === 'object' ? rawBlock.before.src : (rawBlock.before ?? rawBlock.beforeSrc);
    const afterRaw = rawBlock.after && typeof rawBlock.after === 'object' ? rawBlock.after.src : (rawBlock.after ?? rawBlock.afterSrc);
    const block = {
      id, type: 'compare',
      before: resolveImageSrc(beforeRaw, cwd, where, '"before"'),
      after: resolveImageSrc(afterRaw, cwd, where, '"after"'),
    };
    block.beforeLabel = asStr(rawBlock.beforeLabel ?? (rawBlock.before && rawBlock.before.label) ?? 'Before') || 'Before';
    block.afterLabel = asStr(rawBlock.afterLabel ?? (rawBlock.after && rawBlock.after.label) ?? 'After') || 'After';
    if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
    return block;
  }

  if (type === 'palette') {
    // Accept either { palettes: [{name, colors:[…]}, …] } or a single-palette
    // shorthand { name?, colors:[…] }. Each palette needs a non-empty colors
    // array of CSS color strings (#rrggbb, rgb(), hsl(), named — kept as given).
    const rawList = Array.isArray(rawBlock.palettes)
      ? rawBlock.palettes
      : (Array.isArray(rawBlock.colors) ? [{ name: rawBlock.name, sub: rawBlock.sub, colors: rawBlock.colors }] : null);
    if (!rawList || !rawList.length) {
      throw new CliError(`${where}: palette block needs "palettes" (array) or a "colors" array.`);
    }
    const palettes = rawList.map((p, j) => {
      if (!p || typeof p !== 'object') throw new CliError(`${where}.palettes[${j}]: must be an object with "colors".`);
      const colors = (Array.isArray(p.colors) ? p.colors : [])
        .map((c) => asStr(c).trim())
        .filter(Boolean);
      if (!colors.length) throw new CliError(`${where}.palettes[${j}]: needs a non-empty "colors" array.`);
      const out = { colors };
      if (p.name !== undefined) out.name = asStr(p.name);
      const sub = p.sub ?? p.mood;
      if (sub !== undefined) out.sub = asStr(sub);
      const tag = p.badge ?? p.tag;
      if (tag !== undefined) out.tag = asStr(tag);
      if (p.tagTone !== undefined) out.tagTone = asStr(p.tagTone).trim().toLowerCase();
      if (p.featured === true) out.featured = true;
      return out;
    });
    const block = { id, type: 'palette', palettes };
    if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
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
      const nb = normalizeBlock(b, nextId(), cwd, `${where}.blocks[${i}]`);
      // Cross-block fields handled uniformly so every block type supports them:
      // `ref` = a stable name a markdown reference link can open in a modal;
      // `pins` = enable coordinate pin-comments on an image.
      if (b && typeof b === 'object') {
        if (typeof b.ref === 'string' && b.ref.trim()) nb.ref = b.ref.trim();
        if (nb.type === 'image' && b.pins === true) nb.pins = true;
      }
      blocks.push(nb);
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
      // Decision types (single/rank/checklist/allocate) show the optional
      // per-answer note by default so the user can qualify their pick; other
      // types stay opt-in. An explicit note:false turns it off.
      note: rq.note === undefined
        ? (type === 'single' || type === 'rank' || type === 'checklist' || type === 'allocate')
        : rq.note === true,
      blocks: buildBlocks(rq, cwd, where, `${id}-`),
      placeholder: asStr(rq.placeholder),
    };

    if (type === 'single' || type === 'multi' || type === 'rank' || type === 'checklist' || type === 'allocate') {
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
      const minOpts = type === 'rank' ? 2 : 1;
      if (q.options.length < minOpts) {
        throw new CliError(`${where}: type "${type}" needs at least ${minOpts} option${minOpts > 1 ? 's' : ''}.`);
      }
      // Radio (single) questions include an "Other" free-text option by default so
      // the user is never boxed into the listed choices; opt out with other:false.
      // Multi stays opt-in (checkbox lists are usually exhaustive on purpose).
      // rank/checklist/allocate operate over a fixed set, so no "Other".
      if (type === 'single' || type === 'multi') {
        q.other = type === 'single' ? rq.other !== false : rq.other === true;
      }
    }

    if (type === 'checklist') {
      // Per-item status control. Default Pass / Fail / N/A; override with
      // "statuses" (strings or {value,label,tone?}). tone colors the chip.
      const rawSt = Array.isArray(rq.statuses) && rq.statuses.length
        ? rq.statuses
        : [{ value: 'pass', label: 'Pass', tone: 'ok' }, { value: 'fail', label: 'Fail', tone: 'bad' }, { value: 'na', label: 'N/A', tone: 'muted' }];
      q.statuses = rawSt.map((s, k) => {
        if (typeof s === 'string' || typeof s === 'number') {
          const value = String(s).trim();
          return { value, label: value === 'na' ? 'N/A' : value.charAt(0).toUpperCase() + value.slice(1) };
        }
        if (s && typeof s === 'object') {
          const value = asStr(s.value ?? s.label).trim();
          if (!value) throw new CliError(`${where}.statuses[${k}]: needs "value" or "label".`);
          const out = { value, label: asStr(s.label ?? s.value) || value };
          const tone = asStr(s.tone).trim().toLowerCase();
          if (tone) out.tone = tone;
          return out;
        }
        throw new CliError(`${where}.statuses[${k}]: must be a string or {value, label, tone?}.`);
      });
      if (q.statuses.length < 2) throw new CliError(`${where}: checklist needs ≥2 "statuses".`);
    }

    if (type === 'allocate') {
      q.total = clampInt(rq.total, 1, 1000000, 100);
      if (rq.unit !== undefined) q.unit = asStr(rq.unit);
    }

    if (type === 'scale') {
      q.min = clampInt(rq.min, 0, 9, 1);
      q.max = clampInt(rq.max, q.min + 1, 10, Math.max(5, q.min + 1));
      q.minLabel = asStr(rq.minLabel);
      q.maxLabel = asStr(rq.maxLabel);
    }

    if (type === 'color') {
      // Optional preset swatches the user can click beside the native picker.
      const presets = (Array.isArray(rq.presets) ? rq.presets : [])
        .map((c) => asStr(c).trim())
        .filter(Boolean);
      if (presets.length) q.presets = presets;
      // Richer "pick from a palette": labeled swatch cards. Each click selects
      // that color as the answer and each card is individually commentable.
      // Items: a color string, or {value|color, label?}. Any CSS color system.
      if (Array.isArray(rq.palette) && rq.palette.length) {
        q.palette = rq.palette.map((p, k) => {
          if (typeof p === 'string' || typeof p === 'number') {
            const value = String(p).trim();
            return { value, label: value };
          }
          if (p && typeof p === 'object') {
            const value = asStr(p.value ?? p.color).trim();
            if (!value) throw new CliError(`${where}.palette[${k}]: needs a "value" or "color".`);
            return { value, label: asStr(p.label ?? p.name) || value };
          }
          throw new CliError(`${where}.palette[${k}]: must be a color string or {value/color, label?}.`);
        }).filter((p) => p.value);
      }
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
      md: { type: 'string', description: 'markdown: built-in mini renderer (no external library) — headings, lists, code, quotes, links, images, and GFM pipe tables. Text selections are commentable. For real tabular data prefer a "table" block (sortable + per-cell comments).' },
      mdFile: { type: 'string', description: 'markdown: path to a local .md file to load + render instead of inline "md" (e.g. view a README/plan/report). Resolved against the CWD. Quick view of one or more files: `rly view a.md b.md`.' },
      code: { type: 'string', description: 'mermaid: diagram source (e.g. "graph TD; A-->B"); plantuml: the @startuml…@enduml source; code: the source to display (syntax-highlighted with line numbers).' },
      codeFile: { type: 'string', description: 'code: path to a local source file to load + display instead of inline "code". Resolved against the CWD; lang defaults from the file extension.' },
      filename: { type: 'string', description: 'code/diff: optional file name/path shown as a header label above the block.' },
      editable: { type: 'boolean', description: 'mermaid: when true, render an "Edit diagram" toggle so the user can edit the diagram source live. The edited source is returned in result.blockEdits[<blockId>].' },
      dot: { type: 'string', description: 'graphviz: DOT source (e.g. "digraph { a -> b }"). Rendered offline via vendored Viz.js; nodes and edges are individually commentable.' },
      server: { type: 'string', description: 'plantuml: PlantUML server base URL (http(s)). Defaults to https://www.plantuml.com/plantuml. Diagrams render via this server (needs network).' },
      lang: { type: 'string', description: 'code/diff block: language hint for syntax highlighting (js, ts, py, go, rust, java, c, cpp, csharp, ruby, php, swift, kotlin, sql, yaml, json, sh, css, html, …).' },
      diff: { type: 'string', description: 'diff: a unified diff (git diff / diff -u output) — rendered as a colored, line-numbered comparison with +added / −removed / context rows and file/hunk headers. No git needed; just write/paste the diff text.' },
      diffFile: { type: 'string', description: 'diff: path to a local file containing a unified diff (alternative to "diff"). Resolved against the CWD.' },
      view: { type: 'string', enum: ['unified', 'split'], description: 'diff: initial layout — "unified" (default, one column) or "split" (side-by-side old vs new). The viewer also has a live toggle either way.' },
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
      rowsFile: { type: 'string', description: 'table: load rows from a local .csv/.tsv/.json file instead of inline "rows". CSV/TSV first row is the header (becomes "columns" if omitted); JSON is an array of objects. Resolved against the CWD. Quick view: `rly view data.csv`.' },
      sortable: { type: 'boolean', description: 'table: enable click-to-sort headers.' },
      filterable: { type: 'boolean', description: 'table: show a filter box that live-filters rows by substring across all cells. Good for large tables.' },
      exportable: { type: 'boolean', description: 'table: show a "CSV" button that downloads the (filtered) rows as a CSV file.' },
      html: { type: 'string', description: 'html: custom markup rendered in a sandboxed iframe.' },
      htmlFile: { type: 'string', description: 'html: path to an HTML file (alternative to "html").' },
      src: { type: 'string', description: 'image: http(s)/data URL, or a local file path (png/jpg/gif/webp/svg/avif/bmp — embedded at spec time, served offline). video: a YouTube/Vimeo URL (embeds an iframe player), an http(s) media URL, or a local video file (mp4/webm/ogv/mov/mkv/m4v — streamed from the server, never embedded).' },
      alt: { type: 'string', description: 'image: alt text / annotation label. video: accessible title for the player.' },
      palettes: {
        type: 'array',
        description: 'palette: one or more color palettes to display as swatch cards. Each swatch reveals its hex on hover and copies it on click; mark one {featured:true} to show it as a larger spotlight. Each item: {name?, sub? (or mood?), tag? (or badge?), tagTone? (warm|cool|neutral|nature|bold|digital), featured?, colors:[…]}.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sub: { type: 'string' },
            mood: { type: 'string' },
            tag: { type: 'string' },
            badge: { type: 'string' },
            tagTone: { type: 'string', enum: ['warm', 'cool', 'neutral', 'nature', 'bold', 'digital'] },
            featured: { type: 'boolean' },
            colors: { type: 'array', items: { type: 'string' }, description: 'CSS colors — #rrggbb, rgb()/hsl(), or named.' },
          },
          required: ['colors'],
        },
      },
      colors: { type: 'array', items: { type: 'string' }, description: 'palette shorthand: colors for a single palette (use "palettes" for several named ones). Pairs with block-level "name".' },
      name: { type: 'string', description: 'palette shorthand: name for the single "colors" palette.' },
      items: {
        type: 'array',
        description: 'kpi: stat cards. Each {label, value, delta?, dir? (up|down|flat — tints the delta), sub?}. Big-number metrics at a glance ("Revenue $1.2M ↑12%") with no chart.',
        items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, delta: { type: 'string' }, dir: { type: 'string', enum: ['up', 'down', 'flat'] }, sub: { type: 'string' } }, required: ['value'] },
      },
      specimens: {
        type: 'array',
        description: 'typography: type specimens rendered at the given style. Each {label?, size? (e.g. "32px"/"2rem"), weight? (e.g. "600"), font?, lineHeight?, letterSpacing?, text?}. Block-level "font" sets a default family.',
        items: { type: 'object', properties: { label: { type: 'string' }, size: { type: 'string' }, weight: { type: 'string' }, font: { type: 'string' }, lineHeight: { type: 'string' }, letterSpacing: { type: 'string' }, text: { type: 'string' } } },
      },
      ref: { type: 'string', description: 'Any block: a stable name (e.g. "velocity") that a markdown reference link [see chart](#ref:velocity) can open in a full-screen modal — so a question can point back to a visual shown earlier instead of making the user scroll up.' },
      pins: { type: 'boolean', description: 'image: enable coordinate pin-comments — the user clicks any point on the image to drop a comment anchored to that spot (Figma-style), returned as a {kind:"image-point", x, y} annotation.' },
      before: { description: 'compare: the "before" image — an http(s)/data URL, a local file path, or {src, label}.' },
      after: { description: 'compare: the "after" image — an http(s)/data URL, a local file path, or {src, label}.' },
      beforeLabel: { type: 'string', description: 'compare: caption for the before side (default "Before").' },
      afterLabel: { type: 'string', description: 'compare: caption for the after side (default "After").' },
      height: { type: 'integer', minimum: BLOCK_HEIGHT.min, maximum: BLOCK_HEIGHT.max, description: 'Block height in px. Defaults: chart 320, html 360; markdown/table/code flow naturally; mermaid/graphviz/plantuml natural (max 800, scrolls; set a larger height to override); image/compare natural.' },
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
          type: { type: 'string', enum: ['single', 'multi', 'yesno', 'text', 'textarea', 'scale', 'color', 'rank', 'checklist', 'allocate'], default: 'text' },
          label: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean', default: false },
          options: {
            type: 'array',
            description: 'For single/multi/rank/checklist/allocate. Strings, or {value, label, description, blocks?}. An option\'s "blocks" render INSIDE that option card — use them to show each choice (image/chart/mermaid/html…) instead of describing it in words. "rank": user reorders (drag/↑↓), answer is the ordered values, ≥2 options. "checklist": each option gets a status (see "statuses"), answer is {value: status}. "allocate": user distributes "total" across options, answer is {value: number}.',
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
          other: { type: 'boolean', description: 'Add a free-text "Other" option (a multi-line textarea); its text is returned verbatim as the value. Defaults ON for "single" (radio) questions so the user is never boxed in — set other:false to remove it; "multi" stays opt-in (other:true).' },
          note: { type: 'boolean', description: 'Small optional free-text field under the question (to qualify an answer). Returned separately as result.notes[questionId]. Defaults to true for the decision types — single, rank, checklist, allocate — so users can qualify their pick; false for other types. Set note:false to hide it, note:true to add it.' },
          placeholder: { type: 'string', description: 'For text/textarea.' },
          default: { description: 'Pre-selected value. Shape matches the answer shape for the type.' },
          min: { type: 'integer', default: 1, description: 'scale only' },
          max: { type: 'integer', default: 5, maximum: 10, description: 'scale only' },
          minLabel: { type: 'string', description: 'scale only' },
          maxLabel: { type: 'string', description: 'scale only' },
          presets: { type: 'array', items: { type: 'string' }, description: 'color only: optional small preset swatches (CSS colors) shown beside the native picker for one-click selection. The answer is returned as a color string.' },
          palette: { type: 'array', description: 'color only: a "pick from a palette" of labeled swatch CARDS — each click selects that color as the answer, and each card is individually commentable (per-color feedback). Items: a CSS color string (hex/rgb/hsl/named — multiple color systems supported via the browser, no library), or {value (or color), label?}. The native picker stays available for a custom color.', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
          statuses: { type: 'array', description: 'checklist only: the per-item statuses (default Pass / Fail / N/A). Strings, or {value, label, tone?} where tone ∈ ok|bad|muted|warn tints the chip. Answer is a map {optionValue: statusValue} for the items the user set.', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
          total: { type: 'integer', minimum: 1, default: 100, description: 'allocate only: the budget to distribute across options (default 100). Answer is a map {optionValue: number}.' },
          unit: { type: 'string', description: 'allocate only: optional unit label shown next to the total (e.g. "%", "pts", "hrs").' },
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
