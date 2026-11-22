// The image block, and the image reader that compare blocks share.
import fs from 'node:fs';
import path from 'node:path';
import { resolveReadable } from '../../file-access.js';
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT, IMAGE_MAX_BYTES, IMAGE_MIMES } from '../constants.js';

// Resolve an image source (shared by the `image` and `compare` blocks): an
// http(s)/data URL passes through; a local file is read + embedded as a data
// URI (capped) so the board stays self-contained offline.
export function resolveImageSrc(srcRaw, files, where, field) {
  const src = asStr(srcRaw).trim();
  if (!src) throw new CliError(`${where}: ${field} needs a "src" (http(s)/data URL or local file path).`);
  if (/^(https?:|data:)/i.test(src)) return src;
  const ext = path.extname(src).slice(1).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) throw new CliError(`${where}: ${field}: unsupported image extension ".${ext}" — use ${Object.keys(IMAGE_MIMES).join('/')}, or an http(s)/data URL.`);
  const { file: p } = resolveReadable(files, src, where, field);
  let buf;
  try { buf = fs.readFileSync(p); } catch { throw new CliError(`${where}: ${field}: cannot read image "${src}" (resolved: ${p})`); }
  if (buf.length > IMAGE_MAX_BYTES) throw new CliError(`${where}: ${field}: image "${src}" is ${(buf.length / 1024 / 1024).toFixed(1)}MB — max ${IMAGE_MAX_BYTES / 1024 / 1024}MB.`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Normalizes one image block. `id` is the already-assigned block id.
export function normalizeImageBlock(rawBlock, id, files, where, hasHeight) {
  const block = { id, type: 'image' };
  block.src = resolveImageSrc(rawBlock.src ?? rawBlock.file ?? rawBlock.url, files, where, 'image block');
  if (rawBlock.alt !== undefined) block.alt = asStr(rawBlock.alt);
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}
