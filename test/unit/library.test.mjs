// The library entry: validateSpec and normalizeSpec on every shipped example,
// validateSpec's error shape, createBoard storing a board, compileA2ui.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-lib-'));
process.env.RLY_HOME = HOME;
const { compileA2ui, createBoard, normalizeSpec, validateSpec } = await import('../../src/index.js');

const exampleFiles = [path.join(ROOT, 'examples', 'demo-board.json')];
const exampleDir = path.join(ROOT, 'skills', 'relay', 'examples');
for (const name of fs.readdirSync(exampleDir)) if (name.endsWith('.json')) exampleFiles.push(path.join(exampleDir, name));

test('every shipped example validates', () => {
  for (const file of exampleFiles) {
    const result = validateSpec(JSON.parse(fs.readFileSync(file, 'utf8')), { cwd: path.dirname(file) });
    assert.deepEqual(result, { ok: true, errors: [] }, file);
  }
});

test('validateSpec reports a bad spec instead of throwing', () => {
  for (const bad of [null, [], 'text', { title: 'no content' }, { questions: [{ type: 'nope', label: 'x' }] }]) {
    const result = validateSpec(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.errors.length > 0 && typeof result.errors[0] === 'string');
  }
});

test('a spec with version 1 and $schema reads the same as one without', () => {
  const plain = { questions: [{ id: 'a', type: 'yesno', label: 'Ship it?' }] };
  const versioned = { version: 1, $schema: 'https://example.com/spec.v1.json', ...plain };
  assert.deepEqual(normalizeSpec(versioned), normalizeSpec(plain));
});

test('createBoard stores a normalized board under RLY_HOME', () => {
  const record = createBoard({ title: 'Lib', questions: [{ id: 'a', type: 'yesno', label: 'Ship it?' }] });
  assert.equal(record.title, 'Lib');
  assert.ok(fs.existsSync(path.join(HOME, 'boards', `${record.id}.json`)));
  assert.throws(() => createBoard({}), /./);
});

test('compileA2ui compiles Express and accepts a ready surface', async () => {
  const surface = await compileA2ui('root = Card("CI", [Text("ok")])');
  assert.equal(surface.components.find((c) => c.id === 'root').component, 'Card');
  assert.deepEqual(await compileA2ui(surface), surface);
  await assert.rejects(compileA2ui('root = Card("x", [Marquee("hi")])'));
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
