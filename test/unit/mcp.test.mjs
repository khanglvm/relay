// The MCP server, driven by the official SDK client over stdio and over HTTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'rly.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-mcp-'));
const ENV = { ...process.env, RLY_HOME: HOME, HOME };
const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };

const open = [];
after(async () => {
  await Promise.allSettled(open.map((fn) => fn()));
  fs.rmSync(HOME, { recursive: true, force: true });
});

async function stdioClient({ ui = false } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: ENV });
  const client = new Client({ name: 'test', version: '1' }, ui ? { capabilities: UI_CAPS } : {});
  await client.connect(transport);
  open.push(() => client.close());
  return client;
}

async function httpClient({ ui = false, token = 'secret' } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [BIN, 'mcp', '--http', '--port', String(port), '--token', token], { env: ENV });
  open.push(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => String(d).includes('listening') && resolve());
    child.on('error', reject);
    child.on('exit', () => reject(new Error('rly mcp --http exited')));
  });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'test', version: '1' }, ui ? { capabilities: UI_CAPS } : {});
  await client.connect(transport);
  open.push(() => client.close());
  return { client, url, port };
}

const jsonOf = (result) => JSON.parse(result.content[0].text);
const SPEC = { title: 'Ship it?', questions: [{ id: 'go', type: 'yesno', label: 'Ship on Friday?' }, { id: 'why', type: 'text', label: 'Why?' }] };

for (const [name, connect] of [
  ['stdio', stdioClient],
  ['http', async (o) => (await httpClient(o)).client],
]) {
  test(`${name}: the model tools are listed and stay small`, async () => {
    const client = await connect({ ui: false });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const model of ['relay_board', 'relay_help', 'relay_result', 'relay_ask', 'relay_show']) assert.ok(names.includes(model), model);
    // Over stdio the server knows the client at initialize and hides the iframe tools from one that cannot render a board.
    // Over HTTP each request stands alone, so those tools are always listed.
    if (name === 'stdio') assert.equal(names.length, 5);
    const modelOnly = tools.filter((t) => !t._meta?.ui?.visibility?.every((v) => v === 'app'));
    const bytes = JSON.stringify(modelOnly).length;
    assert.ok(bytes < 4000, `model tool list is ${bytes} bytes`);
    const board = tools.find((t) => t.name === 'relay_board');
    assert.ok(board.description.length < 1700, 'relay_board description stays slim');
    assert.equal(board._meta.ui.resourceUri, 'ui://relay/board');
  });

  test(`${name}: a board-rendering client also sees the app-only tools`, async () => {
    const client = await connect({ ui: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const app of ['relay_view', 'relay_draft', 'relay_submit', 'relay_asset', 'a2ui_action']) assert.ok(names.includes(app), app);
    assert.deepEqual(tools.find((t) => t.name === 'relay_submit')._meta.ui.visibility, ['app']);
  });

  test(`${name}: relay_board answers with a summary under 2 KB, not the spec`, async () => {
    const client = await connect({ ui: false });
    const r = await client.callTool({ name: 'relay_board', arguments: { ...SPEC, blocks: [{ type: 'markdown', md: 'x'.repeat(30000) }] } });
    assert.ok(!r.isError);
    assert.ok(JSON.stringify(r).length < 2048, `result is ${JSON.stringify(r).length} bytes`);
    assert.equal(r.structuredContent.mode, 'ask');
    assert.deepEqual(r.structuredContent.questions.map((q) => q.id), ['go', 'why']);
    assert.match(r.structuredContent.boardId, /^b-/);
    assert.ok(r._meta.relay.token);
    assert.ok(!JSON.stringify(r).includes('xxxx'));
  });

  test(`${name}: a board without questions is display-only`, async () => {
    const client = await connect({ ui: false });
    const r = await client.callTool({ name: 'relay_board', arguments: { title: 'FYI', blocks: [{ type: 'markdown', md: 'Plan' }] } });
    assert.equal(r.structuredContent.mode, 'show');
    const out = jsonOf(await client.callTool({ name: 'relay_result', arguments: { boardId: r.structuredContent.boardId } }));
    assert.equal(out.status, 'display-only');
  });

  test(`${name}: submit then relay_result round-trips`, async () => {
    const client = await connect({ ui: true });
    const made = await client.callTool({ name: 'relay_board', arguments: SPEC });
    const { boardId } = made.structuredContent;
    const token = made._meta.relay.token;

    const waiting = jsonOf(await client.callTool({ name: 'relay_result', arguments: { boardId } }));
    assert.equal(waiting.status, 'open');

    const view = await client.callTool({ name: 'relay_view', arguments: { boardId, token } });
    assert.equal(view.structuredContent.spec.questions.length, 2);

    await client.callTool({ name: 'relay_draft', arguments: { boardId, token, draft: { answers: { go: 'yes' } } } });
    const drafted = jsonOf(await client.callTool({ name: 'relay_result', arguments: { boardId } }));
    assert.equal(drafted.status, 'open');
    assert.equal(drafted.draft.answers.go, 'yes');

    const long = client.callTool({ name: 'relay_result', arguments: { boardId, wait_seconds: 20 } });
    const sub = await client.callTool({ name: 'relay_submit', arguments: { boardId, token, payload: { answers: { go: 'yes', why: 'ready' }, comment: 'ok' } } });
    assert.ok(!sub.isError);
    const done = jsonOf(await long);
    assert.equal(done.status, 'submitted');
    assert.deepEqual(done.answers, { go: 'yes', why: 'ready' });
    assert.equal(done.comment, 'ok');

    const again = await client.callTool({ name: 'relay_submit', arguments: { boardId, token, payload: { answers: { go: 'no' } } } });
    assert.ok(again.isError, 'a second submit is refused');
    assert.deepEqual(jsonOf(await client.callTool({ name: 'relay_result', arguments: { boardId } })).answers.go, 'yes');
  });

  test(`${name}: an app tool refuses a wrong token`, async () => {
    const client = await connect({ ui: true });
    const made = await client.callTool({ name: 'relay_board', arguments: SPEC });
    const other = await client.callTool({ name: 'relay_board', arguments: SPEC });
    const { boardId } = made.structuredContent;
    for (const token of ['nope', other._meta.relay.token]) {
      const r = await client.callTool({ name: 'relay_submit', arguments: { boardId, token, payload: { answers: { go: 'yes' } } } });
      assert.ok(r.isError && /token/.test(r.content[0].text));
    }
    assert.equal(jsonOf(await client.callTool({ name: 'relay_result', arguments: { boardId } })).status, 'open');
  });
}

test('an invalid spec comes back as a tool error the model can read', async () => {
  const client = await stdioClient();
  const r = await client.callTool({ name: 'relay_board', arguments: { title: 'x', questions: [{ id: 'a', type: 'yesno', label: 'Pick' }], responseRequired: false } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /display-only/);
});

test('the old relay_ask and relay_show names still work', async () => {
  const client = await stdioClient();
  const ask = await client.callTool({ name: 'relay_ask', arguments: SPEC });
  assert.equal(ask.structuredContent.mode, 'ask');
  const show = await client.callTool({ name: 'relay_show', arguments: { blocks: [{ type: 'markdown', md: 'FYI' }] } });
  assert.equal(show.structuredContent.mode, 'show');
});

test('relay_help serves a guide topic, a schema and the topic list', async () => {
  const client = await stdioClient();
  const topic = await client.callTool({ name: 'relay_help', arguments: { topic: 'blocks' } });
  assert.match(topic.content[0].text, /chart/);
  const schema = jsonOf(await client.callTool({ name: 'relay_help', arguments: { schema: 'chart' } }));
  assert.equal(schema.type, 'chart');
  const list = await client.callTool({ name: 'relay_help', arguments: {} });
  assert.match(list.content[0].text, /rly agent <topic>/);
});

test('the board page and the vendor files read as resources', async () => {
  const client = await stdioClient({ ui: true });
  const page = await client.readResource({ uri: 'ui://relay/board' });
  assert.equal(page.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(page.contents[0].text, /RelayBlocks/);
  const chart = await client.readResource({ uri: 'ui://relay/vendor/chart.umd.js' });
  assert.ok(chart.contents[0].text.length > 100000);
});

test('relay_asset hands over a vendor file in chunks that join back to the original', async () => {
  const client = await stdioClient({ ui: true });
  const parts = [];
  let count = 1;
  for (let i = 0; i < count; i++) {
    const r = await client.callTool({ name: 'relay_asset', arguments: { name: 'chart.umd.js', index: i } });
    count = r.structuredContent.count;
    parts.push(Buffer.from(r.structuredContent.data, 'base64'));
    assert.ok(parts.at(-1).length <= 768 * 1024);
  }
  assert.ok(Buffer.concat(parts).equals(fs.readFileSync(path.join(ROOT, 'vendor', 'chart.umd.js'))));
  const bad = await client.callTool({ name: 'relay_asset', arguments: { name: '../package.json', index: 0 } });
  assert.ok(bad.isError);
});

test('a host that refuses resources/read still loads the chart library through relay_asset', async () => {
  const client = await stdioClient({ ui: true });
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-ui', 'board', 'vendors.js'), 'utf8');
  const loaded = [];
  const context = vm.createContext({
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder,
    Uint8Array,
    document: {
      createElement: () => ({}),
      head: { appendChild: (script) => { loaded.push('script'); vm.runInContext(script.textContent, context); } },
    },
    request: async (method) => {
      assert.equal(method, 'resources/read', 'the host only sees the read that it refuses');
      throw new Error('host refuses resources/read');
    },
    callServerTool: async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent,
  });
  context.window = context;
  vm.runInContext(`${source}\nglobalThis.ready = preloadVendors({ blocks: [{ type: 'chart' }], questions: [] });`, context);
  await context.ready;
  assert.equal(typeof context.Chart, 'function', 'Chart is defined after the fallback load');
  assert.equal(loaded.length, 1);
});

test('registerRelay adds the tools to a server you built, with your own store', async () => {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const { registerRelay } = await import('../../src/mcp/index.js');
  const { Client: C } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const boards = new Map();
  const store = {
    create: (spec) => { const record = { id: 'b-custom1', spec }; boards.set(record.id, record); return record; },
    get: (id) => boards.get(id) ?? null,
    update: (id, patch) => Object.assign(boards.get(id), patch),
  };
  const server = new McpServer({ name: 'host', version: '1' });
  registerRelay(server, { store, tokenKey: 'k', linkUrl: (id) => `https://example.test/b/${id}` });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new C({ name: 't', version: '1' });
  await client.connect(b);
  const r = await client.callTool({ name: 'relay_board', arguments: SPEC });
  assert.equal(r.structuredContent.boardId, 'b-custom1');
  assert.equal(r.structuredContent.url, 'https://example.test/b/b-custom1');
  assert.equal(boards.get('b-custom1').spec.title, 'Ship it?');
  await client.close();
});

test('the http endpoint demands the bearer token', async () => {
  const { url } = await httpClient({ token: 'right' });
  const none = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 401);
  const wrong = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' });
  assert.equal(wrong.status, 401);
  const foreign = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer right', origin: 'https://evil.test' }, body: '{}' });
  assert.equal(foreign.status, 403);
});
