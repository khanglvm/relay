// The example specs and the two assembled pages must stay byte-identical to the
// stored capture. After an intended change, refresh it with `node scripts/golden.mjs --write`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { captureSpecs, capturePages, GOLDEN_DIR } from '../../scripts/golden.mjs';
import { ANNOTATE_SCRIPT_PARTS, APP_SCRIPT_PARTS, assemble, BLOCKS_SCRIPT_PARTS, BOARD_SCRIPT_PARTS, SRC_DIR } from '../../src/ui/manifest.js';

const stored = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf8'));

test('normalizeSpec output matches the stored capture for every example', async () => {
  assert.deepStrictEqual(await captureSpecs(), stored('specs.json'));
});

test('the assembled web and MCP pages match the stored capture', async () => {
  assert.deepStrictEqual(await capturePages(), stored('pages.json'));
});

test('every assembled browser script parses', () => {
  const read = (file) => fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  const sets = { blocks: BLOCKS_SCRIPT_PARTS, annotate: ANNOTATE_SCRIPT_PARTS, app: APP_SCRIPT_PARTS, board: BOARD_SCRIPT_PARTS };
  for (const [name, parts] of Object.entries(sets)) {
    assert.doesNotThrow(() => new vm.Script(assemble(parts, read), { filename: `${name}.js` }), name);
  }
});
