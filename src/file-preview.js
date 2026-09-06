import fs from 'node:fs';
import path from 'node:path';
import { normalizeSpec } from './spec.js';

const TEXT_LIMIT = 1024 * 1024;
const MEDIA = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'], '.webp': ['image', 'image/webp'], '.avif': ['image', 'image/avif'],
  '.svg': ['image', 'image/svg+xml'], '.ico': ['image', 'image/x-icon'],
  '.pdf': ['pdf', 'application/pdf'],
  '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.ogv': ['video', 'video/ogg'],
  '.mov': ['video', 'video/quicktime'], '.m4v': ['video', 'video/mp4'],
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.ogg': ['audio', 'audio/ogg'],
  '.m4a': ['audio', 'audio/mp4'], '.flac': ['audio', 'audio/flac'],
};

// Source citations use :line[:column] or #Lline[-Lend]. Strip before resolving
// and allowlisting; the browser never chooses an unrelated filesystem target.
export function splitFileReference(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:-L?([1-9]\d*))?)$/);
  if (!match) return { path: value, line: null, endLine: null };
  const line = Number(match[1] || match[3]);
  return { path: value.slice(0, match.index), line, endLine: Math.max(line, Number(match[4]) || line) };
}

export function mediaType(target) {
  return MEDIA[path.extname(target).toLowerCase()] || null;
}

export function filePreview(target, stat, reference) {
  const base = { name: path.basename(target), size: stat.size, line: reference.line, endLine: reference.endLine };
  const unavailable = (reason) => ({ ...base, kind: 'unsupported', reason });
  if (!stat.isFile()) return unavailable('Directories cannot be previewed. Open this location in an app.');
  const media = mediaType(target);
  if (media) return { ...base, kind: media[0], mime: media[1] };
  if (stat.size > TEXT_LIMIT) return unavailable('Text previews are limited to 1 MiB. Open this file in an app.');
  // Read at most the limit + 1 even if a file grows between stat and read.
  const fd = fs.openSync(target, 'r');
  let bytes;
  try {
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    bytes = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
  } finally { fs.closeSync(fd); }
  if (bytes.length > TEXT_LIMIT) return unavailable('Text previews are limited to 1 MiB. Open this file in an app.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return unavailable('This file is binary or uses an unsupported text encoding. Open it in an app.'); }
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) return unavailable('This binary file cannot be previewed. Open it in an app.');
  if (text.split('\n').length > 20000) return unavailable('This file has too many lines to preview. Open it in an app.');
  const ext = path.extname(target).slice(1).toLowerCase();
  const lang = ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', sh: 'bash' })[ext] || ext;
  let kind = /^(md|markdown|mdown)$/.test(ext) ? 'markdown' : /^(html|htm)$/.test(ext) ? 'html' : 'code';
  if (!reference.line && /^(csv|tsv)$/.test(ext)) {
    try {
      const block = normalizeSpec({ blocks: [{ type: 'table', rowsFile: target, sortable: true, filterable: true }] }).blocks[0];
      return { ...base, kind: 'table', block, text, lang };
    } catch { /* malformed tables remain readable as source */ }
  }
  return { ...base, kind, text, lang };
}
