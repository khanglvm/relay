// The A2UI board catalog: every example compiles to messages the official processor accepts,
// fromA2ui matches what the web board stores, and a host that declares the catalog gets A2UI from relay_view.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Catalog, MessageProcessor } from '@a2ui/web_core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'rly.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-a2ui-'));
process.env.RLY_HOME = HOME;
process.env.HOME = HOME;
const ENV = { ...process.env, RLY_HOME: HOME, HOME };

const { normalizeSpec } = await import('../../src/spec/index.js');
const { toA2ui } = await import('../../src/a2ui/to-a2ui.js');
const { fromA2ui } = await import('../../src/a2ui/from-a2ui.js');
const { A2UI_MIME, A2UI_MIMES, BOARD_CATALOG_ID } = await import('../../src/a2ui/board-constants.js');
const { declaresBoardCatalog, wantsA2ui } = await import('../../src/a2ui/negotiate.js');
const { fileStore } = await import('../../src/mcp/store.js');
const { submitBoard } = await import('../../src/mcp/boards.js');

const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/a2ui/board-catalog.json'), 'utf8'));
const open = [];
after(async () => {
  await Promise.allSettled(open.map((fn) => fn()));
  fs.rmSync(HOME, { recursive: true, force: true });
});

const processor = () => new MessageProcessor([Catalog.fromJson(CATALOG)]);

const EVERY_QUESTION = {
  title: 'Every question',
  intro: 'One of each.',
  blocks: [{ type: 'markdown', md: '# Hello' }, { type: 'chart', kind: 'bar', labels: ['a', 'b'], series: [{ label: 's', data: [1, 2] }] }],
  questions: [
    { id: 'one', type: 'single', label: 'Single', options: ['a', { value: 'b', label: 'B', blocks: [{ type: 'markdown', md: 'about b' }] }] },
    { id: 'many', type: 'multi', label: 'Multi', options: ['a', 'b', 'c'], other: true },
    { id: 'yn', type: 'yesno', label: 'Yes or no' },
    { id: 'rate', type: 'scale', label: 'Scale', min: 1, max: 5 },
    { id: 'hue', type: 'color', label: 'Colour', presets: ['#fff'] },
    { id: 'order', type: 'rank', label: 'Rank', options: ['x', 'y', 'z'] },
    { id: 'chk', type: 'checklist', label: 'Checklist', options: ['x', 'y'] },
    { id: 'split', type: 'allocate', label: 'Allocate', options: ['x', 'y'], total: 10 },
    { id: 'txt', type: 'text', label: 'Text', default: 'seed' },
    { id: 'long', type: 'textarea', label: 'Long text', blocks: [{ type: 'code', code: 'x = 1', lang: 'js' }] },
    { id: 'tiles', type: 'pick', label: 'Pick', max: 2, items: [{ id: 'a', title: 'A', image: 'https://e.com/a.png', url: 'https://e.com/a' }, { id: 'b', title: 'B', video: 'https://youtu.be/abc' }, 'c'] },
  ],
};

const exampleSpecs = () => {
  const dirs = [path.join(ROOT, 'skills/relay/examples'), path.join(ROOT, 'examples')];
  const specs = dirs.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)))
    .map((file) => ({ name: path.relative(ROOT, file), spec: normalizeSpec(JSON.parse(fs.readFileSync(file, 'utf8')), { cwd: path.dirname(file) }) }));
  return [...specs, { name: 'every question type', spec: normalizeSpec(EVERY_QUESTION) }];
};

test('every example compiles to messages the official MessageProcessor accepts', () => {
  const specs = exampleSpecs();
  assert.ok(specs.length >= 7);
  for (const { name, spec } of specs) {
    const messages = toA2ui(spec, { surfaceId: 'board' });
    assert.deepEqual(messages.map((m) => Object.keys(m)[1]), ['createSurface', 'updateComponents', 'updateDataModel'], name);
    assert.equal(messages[0].createSurface.catalogId, BOARD_CATALOG_ID);
    assert.doesNotThrow(() => processor().processMessages(messages), name);
  }
});

test('the processor rejects a component whose properties break the catalog, so the check has teeth', () => {
  const messages = toA2ui(normalizeSpec(EVERY_QUESTION), { surfaceId: 'board' });
  messages[1].updateComponents.components.find((c) => c.id === 'root').title = 5;
  assert.throws(() => processor().processMessages(messages));
});

test('the surface carries text fallbacks, data paths and the submit action', () => {
  const messages = toA2ui(normalizeSpec(EVERY_QUESTION), { surfaceId: 'board' });
  const components = messages[1].updateComponents.components;
  const byId = Object.fromEntries(components.map((c) => [c.id, c]));
  assert.equal(byId.root.component, 'Board');
  assert.ok(components.every((c) => typeof c.text === 'string' || c.id === 'root' || c.component === 'Question' || c.component === 'Comment' || c.component === 'Submit'));
  assert.equal(byId.q_one.value['@path'], '/answers/one');
  assert.equal(byId.q_tiles.questionType, 'pick');
  assert.equal(byId.submit.action.event.name, 'relay.submit');
  assert.ok(byId.q_one.children.length, 'an option block hangs on its question');
  assert.deepEqual(messages[2].updateDataModel.value.answers, { txt: 'seed' });
});

test('a display-only board has no submit button and does not ask for the data model', () => {
  const messages = toA2ui(normalizeSpec({ blocks: [{ type: 'markdown', md: 'FYI' }], responseRequired: false }), { surfaceId: 'board' });
  assert.equal(messages[0].createSurface.sendDataModel, false);
  assert.ok(!messages[1].updateComponents.components.some((c) => c.component === 'Submit'));
});

test('a question id that could reach the prototype is refused', () => {
  const spec = normalizeSpec({ questions: [{ id: 'constructor', type: 'text', label: 'x' }] });
  assert.throws(() => toA2ui(spec), /cannot be sent as A2UI/);
});

test('the saved draft seeds the data model', () => {
  const messages = toA2ui(normalizeSpec(EVERY_QUESTION), { draft: { answers: { yn: 'yes' }, notes: { yn: 'hm' }, comment: 'wip' } });
  const data = messages[2].updateDataModel.value;
  assert.equal(data.answers.yn, 'yes');
  assert.equal(data.notes.yn, 'hm');
  assert.equal(data.comment, 'wip');
});

test('negotiation: only a declaration that lists the board catalog switches to A2UI', () => {
  const good = { '1.0': { supportedCatalogIds: [BOARD_CATALOG_ID] } };
  assert.ok(declaresBoardCatalog(good));
  assert.ok(!declaresBoardCatalog({ '1.0': { supportedCatalogIds: ['https://e.com/other'] } }));
  assert.ok(!declaresBoardCatalog({ '0.9': { supportedCatalogIds: [BOARD_CATALOG_ID] } }));
  assert.ok(!declaresBoardCatalog(undefined));
  assert.ok(wantsA2ui({ capabilities: { a2ui: good } }));
  assert.ok(wantsA2ui({ capabilities: { extensions: { a2ui: good } } }));
  assert.ok(wantsA2ui({ meta: { a2ui: good } }));
  assert.ok(!wantsA2ui({ capabilities: { a2ui: good }, meta: { a2ui: { '1.0': { supportedCatalogIds: [] } } } }), 'the call decides over the connection');
  assert.ok(!wantsA2ui({}));
  assert.ok(A2UI_MIMES.includes(A2UI_MIME) && A2UI_MIMES.length === 2);
  assert.ok(declaresBoardCatalog({ ...good, mimeTypes: ['application/json+a2ui'] }), 'the other MIME spelling is accepted');
  assert.ok(!declaresBoardCatalog({ ...good, mimeTypes: ['text/html'] }));
});

// What a person types in, as the surface's data model would hold it, with the mess a renderer may leave.
const SCRIPTED_MODEL = {
  answers: {
    one: 'b', many: ['a', 'c'], yn: 'no', rate: 4, hue: ' #ff0000 ', order: ['z', 'x', 'y'], chk: { x: 'pass' },
    split: { x: 6, y: 4 }, txt: '  hello  ', long: '   ', tiles: { picks: [{ id: 'b', note: ' bold ' }, { id: 'ghost' }, 'a', 'c'], overall: ' fine ' },
  },
  notes: { one: ' because ', yn: '   ' },
  comment: ' ship it ',
};
// What the web board posts for the same answers: its getValue and payload already trim and drop empties.
const WEB_PAYLOAD = {
  answers: {
    one: 'b', many: ['a', 'c'], yn: 'no', rate: 4, hue: '#ff0000', order: ['z', 'x', 'y'], chk: { x: 'pass' },
    split: { x: 6, y: 4 }, txt: 'hello', tiles: { picks: [{ id: 'b', note: 'bold' }, { id: 'a' }], overall: 'fine' },
  },
  notes: { one: 'because' },
  comment: 'ship it',
};

function webBoard(spec) {
  const specFile = path.join(HOME, 'web-spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'ask', '--file', specFile, '--detach', '--no-open', '--timeout', '60'], { env: ENV });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out)));
  });
}

const resultOf = (id) => {
  const child = spawn(process.execPath, [BIN, 'result', id], { env: ENV });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', () => resolve(JSON.parse(out))));
};

test('fromA2ui matches the result the web board stores for the same answers', async () => {
  const board = await webBoard(EVERY_QUESTION);
  open.push(() => fetch(new URL('/api/cancel', board.url), { method: 'POST' }).catch(() => {}));
  const res = await fetch(new URL('/api/submit', board.url), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(board.url).origin }, body: JSON.stringify(WEB_PAYLOAD),
  });
  assert.ok(res.ok, `web submit answered ${res.status}`);
  const web = await resultOf(board.boardId);

  const spec = normalizeSpec(EVERY_QUESTION);
  const payload = fromA2ui(SCRIPTED_MODEL, spec);
  assert.deepEqual(payload.answers, WEB_PAYLOAD.answers);
  const store = fileStore();
  const record = await store.create(spec);
  assert.ok((await submitBoard(store, record, payload)).ok);
  const native = (await store.get(record.id)).result;
  for (const field of ['status', 'answers', 'skipped', 'comment', 'notes']) assert.deepEqual(native[field], web[field], field);
});

test('fromA2ui turns block comments into annotations and ignores unknown blocks and keys', () => {
  const spec = normalizeSpec(EVERY_QUESTION);
  const blockId = spec.blocks[0].id;
  const out = fromA2ui({ answers: { nope: 'x', __proto__: 'y' }, annotations: { [blockId]: ' needs a source ', ghost: 'x' }, blockEdits: { m: 'graph TD;A-->B' } }, spec, { now: 'T' });
  assert.deepEqual(out.answers, {});
  assert.deepEqual(out.annotations, [{ id: `a2ui-${blockId}`, questionId: null, blockId, target: { kind: 'block' }, text: 'needs a source', createdAt: 'T' }]);
  assert.deepEqual(out.blockEdits, { m: 'graph TD;A-->B' });
  assert.deepEqual(fromA2ui(undefined, spec).answers, {});
});

async function stdioClient(capabilities) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: ENV });
  const client = new Client({ name: 'test', version: '1' }, { capabilities });
  await client.connect(transport);
  open.push(() => client.close());
  return client;
}

const DECLARATION = { '1.0': { supportedCatalogIds: [BOARD_CATALOG_ID] } };
// The MCP SDK keeps only `extensions` from a client's capabilities, so a connected host declares it there.
const DECLARES = { extensions: { a2ui: DECLARATION } };
const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const PICK_SPEC = { title: 'Pick', questions: [{ id: 'dir', type: 'pick', label: 'Which?', max: 2, items: ['a', 'b', 'c', 'd'] }] };

test('relay_view sends A2UI to a host that declared the catalog, and the iframe spec to everyone else', async () => {
  const iframe = await stdioClient(UI_CAPS);
  const made = await iframe.callTool({ name: 'relay_board', arguments: PICK_SPEC });
  assert.deepEqual(made._meta['relay/a2ui'], { catalogIds: [BOARD_CATALOG_ID] });
  const { boardId } = made.structuredContent;
  const args = { boardId, token: made._meta.relay.token };
  const plain = await iframe.callTool({ name: 'relay_view', arguments: args });
  assert.equal(plain.structuredContent.spec.questions[0].type, 'pick');
  const perCall = await iframe.callTool({ name: 'relay_view', arguments: args, _meta: { a2ui: DECLARATION } });
  assert.equal(perCall.content[0].resource.mimeType, A2UI_MIME, 'a per-call _meta.a2ui switches one call');

  const native = await stdioClient(DECLARES);
  const nMade = await native.callTool({ name: 'relay_board', arguments: PICK_SPEC });
  const view = await native.callTool({ name: 'relay_view', arguments: { boardId: nMade.structuredContent.boardId, token: nMade._meta.relay.token } });
  const resource = view.content[0].resource;
  assert.equal(resource.mimeType, A2UI_MIME);
  assert.equal(view.structuredContent, undefined);
  const messages = JSON.parse(resource.text);
  assert.doesNotThrow(() => processor().processMessages(messages));
});

test('a pick submit round-trips through the iframe tools and relay_result', async () => {
  const client = await stdioClient(UI_CAPS);
  const made = await client.callTool({ name: 'relay_board', arguments: PICK_SPEC });
  const { boardId } = made.structuredContent;
  const token = made._meta.relay.token;
  const payload = { answers: { dir: { picks: [{ id: 'c', note: 'calm' }, { id: 'a' }, { id: 'ghost' }, { id: 'd' }], overall: 'both warm' } } };
  const sub = await client.callTool({ name: 'relay_submit', arguments: { boardId, token, payload } });
  assert.ok(!sub.isError);
  const done = JSON.parse((await client.callTool({ name: 'relay_result', arguments: { boardId } })).content[0].text);
  assert.deepEqual(done.answers.dir, { picks: [{ id: 'c', note: 'calm' }, { id: 'a' }], overall: 'both warm' }, 'ids are cleaned and capped at max');
});

test('relay.submit from an A2UI host lands as the same result, once', async () => {
  const client = await stdioClient(DECLARES);
  const made = await client.callTool({ name: 'relay_board', arguments: PICK_SPEC });
  const { boardId } = made.structuredContent;
  const token = made._meta.relay.token;
  const action = { name: 'relay.submit', surfaceId: `relay-${boardId}`, sourceComponentId: 'submit', timestamp: new Date().toISOString(), context: {} };
  const dataModel = { answers: { dir: { picks: [{ id: 'b', note: 'quiet' }, { id: 'a' }] } }, comment: 'thanks' };
  const sent = await client.callTool({ name: 'a2ui_action', arguments: { boardId, token, action, dataModel } });
  assert.ok(!sent.isError, JSON.stringify(sent.content));
  const done = JSON.parse((await client.callTool({ name: 'relay_result', arguments: { boardId } })).content[0].text);
  assert.equal(done.status, 'submitted');
  assert.deepEqual(done.answers.dir, { picks: [{ id: 'b', note: 'quiet' }, { id: 'a' }] });
  assert.equal(done.comment, 'thanks');
  const again = await client.callTool({ name: 'a2ui_action', arguments: { boardId, token, action, dataModel } });
  assert.ok(again.isError, 'a second submit is refused');
  const bare = await client.callTool({ name: 'a2ui_action', arguments: { boardId, token, action } });
  assert.ok(bare.isError);
});
