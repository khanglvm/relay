// The table block: CSV, TSV and JSON row files, and normalization.
import path from 'node:path';
import { readReadable } from '../../file-access.js';
import { CliError } from '../../util.js';
import { BLOCK_HEIGHT, TEXT_FILE_MAX_BYTES } from '../constants.js';
import { asStr, clampInt } from '../sources.js';

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
function loadRowsFile(file, files, where) {
  const { file: p, buf } = readReadable(files, file, where, 'rowsFile');
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

// Normalizes one table block. `id` is the already-assigned block id.
export function normalizeTableBlock(rawBlock, id, files, where, hasHeight) {
  // Rows/columns may come from a local .csv/.tsv/.json file instead of inline.
  let rawColumns = rawBlock.columns;
  let rawRows = rawBlock.rows;
  if (typeof rawBlock.rowsFile === 'string' && rawBlock.rowsFile.trim() && !Array.isArray(rawRows)) {
    const loaded = loadRowsFile(rawBlock.rowsFile, files, where);
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
