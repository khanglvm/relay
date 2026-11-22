// The markdown block.
import { CliError } from '../../util.js';
import { clampInt, readTextSource } from '../sources.js';
import { BLOCK_HEIGHT } from '../constants.js';

// Normalizes one markdown block. `id` is the already-assigned block id.
export function normalizeMarkdownBlock(rawBlock, id, files, where, hasHeight) {
  const md = readTextSource(rawBlock, 'md', 'mdFile', files, where);
  if (!md.trim()) throw new CliError(`${where}: markdown block needs a non-empty "md" string or a readable "mdFile".`);
  const block = { id, type: 'markdown', md };
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}
