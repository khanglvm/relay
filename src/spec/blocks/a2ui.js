// The a2ui block. Express text compiles later, in assertSpecReady.
import { assertSafeJson, guardExpress, validateSurface } from '../../a2ui/compile.js';
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT } from '../constants.js';

// Normalizes one a2ui block. `id` is the already-assigned block id.
export function normalizeA2uiBlock(rawBlock, id, cwd, where, hasHeight) {
  // A live A2UI v1.0 widget: Express text (compiled in assertSpecReady) or
  // ready JSON components, checked against Relay's catalog either way.
  const hasExpress = rawBlock.express !== undefined && rawBlock.express !== null;
  const hasComponents = rawBlock.components !== undefined && rawBlock.components !== null;
  if (hasExpress === hasComponents) throw new CliError(`${where}: a2ui block needs exactly one of "express" (A2UI Express text) or "components" (JSON list).`);
  const block = { id, type: 'a2ui' };
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  if (hasExpress) {
    if (rawBlock.dataModel !== undefined) throw new CliError(`${where}: with "express", set data with \`$/path = value\` lines, not "dataModel".`);
    block.express = guardExpress(rawBlock.express, where);
    return block;
  }
  assertSafeJson(rawBlock.components, where);
  const surface = validateSurface({ components: rawBlock.components, dataModel: rawBlock.dataModel }, where);
  return Object.assign(block, surface);
}
