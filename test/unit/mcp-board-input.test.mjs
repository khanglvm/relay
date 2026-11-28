import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createMcpBoard } from '../../src/mcp/boards.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rly-board-input-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const dir = path.join(root, 'board');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'notes.md'), 'Reference notes');
const specFile = path.join(dir, 'relay-spec.json');
const picker = { id: 'refs', type: 'pick', label: 'Pick a reference', items: ['First', 'Second'] };
fs.writeFileSync(specFile, JSON.stringify({ title: 'Generated picker', blocks: [{ type: 'markdown', mdFile: 'notes.md' }], questions: [picker] }));
const store = { create: (spec, options) => ({ id: 'b-test', spec, options }) };
const fileRoots = [path.relative(process.cwd(), root)];
const followup = { id: 'notes', type: 'textarea', label: 'What should we change?' };

test('an agent can open a generated spec and append content in one MCP call', async () => {
  const { record, spec, mode } = await createMcpBoard(store, {
    specFile, title: 'Design review', blocks: [{ type: 'markdown', md: 'Context' }], questions: [followup],
  }, { fileRoots });
  assert.equal(mode, 'ask');
  assert.equal(spec.title, 'Design review');
  assert.deepEqual(spec.blocks.map((block) => block.md), ['Reference notes', 'Context']);
  assert.deepEqual(spec.questions.map((question) => question.id), ['refs', 'notes']);
  assert.equal(spec.questions[0].items.length, 2);
  assert.deepEqual(record.options, { fileRoots: [root], cwd: dir });
});

test('file-backed boards keep file roots, size limits, and question validation', async () => {
  await assert.rejects(createMcpBoard(store, { specFile }), /outside allowed roots/);
  await assert.rejects(createMcpBoard(store, { specFile, questions: [picker] }, { fileRoots }), /duplicate question id "refs"/);
  await assert.rejects(createMcpBoard(store, { specFile: 'https://example.test/spec.json' }, { fileRoots }), /must be an absolute path/);
  const oversized = path.join(dir, 'oversized.json');
  fs.writeFileSync(oversized, '{}');
  fs.truncateSync(oversized, 9 * 1024 * 1024);
  await assert.rejects(createMcpBoard(store, { specFile: oversized }, { fileRoots }), /exceeds the .* byte limit/);
});

test('adding a question opens a saved display-only board for feedback', async () => {
  const displaySpec = path.join(dir, 'display.json');
  fs.writeFileSync(displaySpec, JSON.stringify({ responseRequired: false, blocks: [{ type: 'markdown', md: 'Read this' }] }));
  const display = await createMcpBoard(store, { specFile: displaySpec }, { fileRoots });
  const composed = await createMcpBoard(store, { specFile: displaySpec, questions: [followup] }, { fileRoots });
  assert.equal(display.mode, 'show');
  assert.equal(composed.mode, 'ask');
  await assert.rejects(
    createMcpBoard(store, { specFile: displaySpec, questions: [followup], responseRequired: false }, { fileRoots }),
    /display-only board/,
  );
});
