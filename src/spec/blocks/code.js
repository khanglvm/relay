// The code and diff blocks.
import path from 'node:path';
import { CliError } from '../../util.js';
import { asStr, clampInt, readTextSource } from '../sources.js';
import { BLOCK_HEIGHT } from '../constants.js';

// Normalizes one code block. `id` is the already-assigned block id.
export function normalizeCodeBlock(rawBlock, id, files, where, hasHeight) {
  const code = readTextSource(rawBlock, 'code', 'codeFile', files, where);
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

// Normalizes one diff block. `id` is the already-assigned block id.
export function normalizeDiffBlock(rawBlock, id, files, where, hasHeight) {
  const diff = readTextSource(rawBlock, 'diff', 'diffFile', files, where);
  if (!diff.trim()) throw new CliError(`${where}: diff block needs a non-empty "diff" string (unified diff) or a readable "diffFile".`);
  const block = { id, type: 'diff', diff };
  if (rawBlock.lang !== undefined) block.lang = asStr(rawBlock.lang);
  if (rawBlock.filename !== undefined) block.filename = asStr(rawBlock.filename);
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  if (rawBlock.review === true) block.review = true;
  if (rawBlock.reviewKind !== undefined) block.reviewKind = asStr(rawBlock.reviewKind);
  if (rawBlock.commit !== undefined) block.commit = asStr(rawBlock.commit);
  const view = asStr(rawBlock.view).trim().toLowerCase();
  if (view === 'split' || view === 'unified') block.view = view;
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}
