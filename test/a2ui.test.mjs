// A2UI blocks: Express compiles against Relay's catalog, unsafe or oversized input is
// refused, the browser state module is safe, docs/A2UI.md is current, and a button
// click travels from the board to `rly result`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { A2UI_LIMITS, compileExpress, resolveA2uiBlock, validateSurface } from '../src/a2ui/compile.js';
import { assertSpecReady, normalizeSpec } from '../src/spec.js';
import { DOC_FILE, renderA2uiDoc } from '../scripts/gen-a2ui-doc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = '$/jobs = [{title:"Build", tone:"ok"}]\nroot = Card("CI", [List($/jobs), Button("Retry", Event("retry", {job: "build"}))])';

test('Express compiles to a flat component list with a Card root and a data model', async () => {
  const { components, dataModel } = await compileExpress(GOOD);
  assert.equal(components.find((c) => c.id === 'root').component, 'Card');
  assert.deepEqual(components.map((c) => c.component).sort(), ['Button', 'Card', 'List']);
  assert.equal(dataModel.jobs[0].tone, 'ok');
});

test('Express refuses paths that reach the prototype chain', async () => {
  for (const bad of ['$/__proto__/x = 1', '$/a/constructor/prototype/x = 1', '$/prototype = 1']) {
    await assert.rejects(compileExpress(`${bad}\nroot = Card("x", [])`), /cannot use __proto__/, bad);
  }
  assert.equal({}.x, undefined);
});

test('Express refuses unknown components, bad enums and oversized text', async () => {
  await assert.rejects(resolveA2uiBlock({ type: 'a2ui', express: 'root = Card("x", [Marquee("hi")])' }), /Marquee|unknown|component/i);
  await assert.rejects(resolveA2uiBlock({ type: 'a2ui', express: 'root = Card("x", [Pill("hi", "purple")])' }), /tone|purple|one of/i);
  await assert.rejects(compileExpress(`root = Card("${'x'.repeat(A2UI_LIMITS.expressChars)}", [])`), /too long|larger|limit|characters/i);
});

test('a surface needs a Card root, no orphans and no more than the component cap', () => {
  const card = { id: 'root', component: 'Card', title: 't', children: [] };
  assert.doesNotThrow(() => validateSurface({ components: [card] }));
  assert.throws(() => validateSurface({ components: [{ ...card, component: 'Stack', direction: 'row' }] }), /root/i);
  assert.throws(() => validateSurface({ components: [card, { id: 'lost', component: 'Divider' }] }), /orphan|not reachable|unused/i);
  const many = Array.from({ length: A2UI_LIMITS.components + 1 }, (_, i) => ({ id: `d${i}`, component: 'Divider' }));
  assert.throws(() => validateSurface({ components: [{ ...card, children: many.map((c) => c.id) }, ...many] }), /at most|too many|components/i);
});

test('the spec accepts exactly one of express or components and compiles express in place', async () => {
  const spec = normalizeSpec({ title: 't', blocks: [{ id: 'w', type: 'a2ui', express: GOOD }] });
  await assertSpecReady(spec);
  const block = spec.blocks[0];
  assert.equal(block.express, undefined);
  assert.ok(block.components.length >= 3);
  assert.throws(() => normalizeSpec({ title: 't', blocks: [{ type: 'a2ui' }] }), /exactly one/);
  assert.throws(() => normalizeSpec({ title: 't', blocks: [{ type: 'a2ui', express: GOOD, components: [] }] }), /exactly one/);
});

function loadStateModule() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/ui/a2ui-state.js'), 'utf8'), sandbox);
  return sandbox.window.RelayA2uiState;
}

test('browser state: set, get, bindings and event context', () => {
  const state = loadStateModule();
  const seen = [];
  const store = state.createStore({ env: 'staging' }, null, (s) => seen.push(s));
  store.set('/note/text', 'hi');
  store.fire('approve', { env: { '@path': '/env' }, note: { '@path': '/note/text' }, fixed: 7 });
  const snap = store.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap.data)), { env: 'staging', note: { text: 'hi' } });
  assert.deepEqual(JSON.parse(JSON.stringify(snap.events[0].context)), { env: 'staging', note: 'hi', fixed: 7 });
  assert.equal(seen.length, 2);
});

test('browser state: unsafe paths are refused and nothing is polluted', () => {
  const state = loadStateModule();
  const data = {};
  for (const p of ['/__proto__/x', '/a/constructor/prototype/x', '/prototype']) assert.equal(state.set(data, p, 1), false, p);
  assert.equal(state.get(data, '/__proto__'), undefined);
  assert.equal({}.x, undefined);
});

test('browser state: a restored draft wins and the event log is capped', () => {
  const store = loadStateModule().createStore({ a: 1 }, { data: { a: 2 }, events: [] });
  assert.equal(store.get('/a'), 2);
  for (let i = 0; i < 60; i += 1) store.fire('tick', {});
  assert.equal(store.eventCount(), 50);
});

test('docs/A2UI.md is current: run `node scripts/gen-a2ui-doc.mjs --write` after a catalog, example or guide change', async () => {
  assert.equal(fs.readFileSync(DOC_FILE, 'utf8'), await renderA2uiDoc());
});

function rly(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, RLY_HOME: home, RLY_OPEN_CMD: 'true' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/rly.js'), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('a button click and input value come back through rly result; hostile state is dropped', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-a2ui-'));
  try {
    const specFile = path.join(home, 'spec.json');
    fs.writeFileSync(specFile, JSON.stringify({ title: 'a2ui', blocks: [{ id: 'w', type: 'a2ui', express: GOOD }], questions: [{ id: 'ok', type: 'yesno', label: 'Fine?' }] }));
    const opened = rly(home, ['ask', '--file', specFile, '--detach', '--no-open']);
    assert.equal(opened.code, 0, opened.err);
    const { boardId, url } = JSON.parse(opened.out);
    const page = await (await fetch(url)).text();
    assert.ok(page.includes('RelayA2ui'), 'the page carries the A2UI renderer');

    const good = { type: 'a2ui', data: { note: 'via test' }, events: [{ name: 'retry', context: { job: 'build' }, at: '2026-11-22T10:00:00Z' }] };
    const hostile = { type: 'a2ui', data: JSON.parse('{"__proto__":{"x":1}}'), events: [] };
    const res = await fetch(new URL('/api/submit', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { ok: 'yes' }, comment: '', blockEdits: { b1: good, other: hostile, bad: { type: 'a2ui', events: [{ name: 'Not Valid!' }] } } }),
    });
    assert.ok(res.ok);

    const result = JSON.parse(rly(home, ['result', boardId]).out);
    assert.equal(result.status, 'submitted');
    assert.equal(result.answers.ok, 'yes');
    assert.deepEqual(result.blockEdits.b1.events.map((e) => [e.name, e.context.job]), [['retry', 'build']]);
    assert.equal(result.blockEdits.b1.data.note, 'via test');
    assert.equal(result.blockEdits.other, undefined, 'a state with a __proto__ key is dropped');
    assert.deepEqual(result.blockEdits.bad.events, [], 'an event with an invalid name is dropped');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
