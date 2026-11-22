// The pdf block.
import path from 'node:path';
import { resolveReadable } from '../../file-access.js';
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT, PDF_MAX_BYTES, PDF_MIME } from '../constants.js';

// Normalizes one pdf block. `id` is the already-assigned block id.
export function normalizePdfBlock(rawBlock, id, files, where, hasHeight) {
  const src = asStr(rawBlock.src ?? rawBlock.file ?? rawBlock.url).trim();
  if (!src) throw new CliError(`${where}: pdf block needs a "src" (http(s) PDF URL or local .pdf file path).`);
  const block = { id, type: 'pdf' };
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  if (rawBlock.alt !== undefined && block.title === undefined) block.title = asStr(rawBlock.alt);
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  if (/^https?:/i.test(src)) {
    block.src = src;
    block.mime = PDF_MIME;
    if (!block.title) block.title = path.basename(src.split(/[?#]/)[0]) || 'PDF';
    return block;
  }
  const ext = path.extname(src).slice(1).toLowerCase();
  if (ext !== 'pdf') throw new CliError(`${where}: unsupported pdf extension ".${ext}" — use a local .pdf file or an http(s) PDF URL.`);
  const { file: p, stat } = resolveReadable(files, src, where, 'pdf');
  if (stat.size > PDF_MAX_BYTES) {
    throw new CliError(`${where}: pdf "${src}" is ${(stat.size / 1024 / 1024).toFixed(0)}MB — max ${PDF_MAX_BYTES / 1024 / 1024}MB.`);
  }
  block.file = p;
  block.mime = PDF_MIME;
  if (!block.title) block.title = path.basename(p);
  return block;
}
