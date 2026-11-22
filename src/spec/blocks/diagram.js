// The mermaid, graphviz and plantuml blocks.
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT } from '../constants.js';

// Normalizes one mermaid block. `id` is the already-assigned block id.
export function normalizeMermaidBlock(rawBlock, id, cwd, where, hasHeight) {
  const code = asStr(rawBlock.code);
  if (!code.trim()) throw new CliError(`${where}: mermaid block needs a non-empty "code" string.`);
  const block = { id, type: 'mermaid', code };
  if (rawBlock.editable === true) block.editable = true;
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}

// Normalizes one graphviz block. `id` is the already-assigned block id.
export function normalizeGraphvizBlock(rawBlock, id, cwd, where, hasHeight) {
  const dot = asStr(rawBlock.dot);
  if (!dot.trim()) throw new CliError(`${where}: graphviz block needs a non-empty "dot" string.`);
  const block = { id, type: 'graphviz', dot };
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}

// Normalizes one plantuml block. `id` is the already-assigned block id.
export function normalizePlantumlBlock(rawBlock, id, cwd, where, hasHeight) {
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
