// Draft restore: what the board iframe does with the draft the server saved, and what the server keeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-draft-'));
const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const SPEC = { title: 'Ship it?', questions: [{ id: 'go', type: 'yesno', label: 'Ship on Friday?' }] };

const open = [];
after(async () => {
  await Promise.allSettled(open.map((fn) => fn()));
  fs.rmSync(HOME, { recursive: true, force: true });
});

async function stdioClient() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'rly.js'), 'mcp'], env: { ...process.env, RLY_HOME: HOME, HOME } });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: UI_CAPS });
  await client.connect(transport);
  open.push(() => client.close());
  return client;
}

test('the iframe restores a saved draft on a reload, keeping Other text and dropping removed questions', () => {
  const read = (name) => fs.readFileSync(path.join(ROOT, 'src', 'mcp-ui', 'board', name), 'utf8');
  const context = vm.createContext({
    window: { RelayPick: { seed: (q, v) => v, value: (q, v) => v } },
    document: { getElementById: () => null },
  });
  const questions = [
    { id: 'go', type: 'yesno' },
    { id: 'pick', type: 'single', other: true, options: [{ value: 'a' }, { value: 'b' }] },
    { id: 'many', type: 'multi', other: true, options: [{ value: 'x' }, { value: 'y' }] },
    { id: 'order', type: 'rank', options: [{ value: 'one' }, { value: 'two' }] },
    { id: 'why', type: 'textarea' },
  ];
  const draft = {
    answers: { go: 'no', pick: 'something else', many: ['x', 'typed'], order: ['two'], why: 'half', removed: 'gone' },
    comment: 'wip',
    notes: { go: 'note' },
    annotations: [{ id: 'a1' }],
    blockEdits: { m: 'graph TD' },
  };
  const out = vm.runInContext(`${read('state.js')}\n${read('draft.js')}
    QS = ${JSON.stringify(questions)};
    restoreDraft(${JSON.stringify(draft)});
    restoreDraft(null);
    JSON.stringify({ state, payload: payload() });`, context);
  const { state, payload } = JSON.parse(out);
  assert.deepEqual(payload.answers, { go: 'no', pick: 'something else', many: ['x', 'typed'], order: ['two', 'one'], why: 'half' });
  assert.deepEqual(state.other.pick, { on: true, text: 'something else' });
  assert.equal(payload.comment, 'wip');
  assert.deepEqual(payload.notes, { go: 'note' });
  assert.deepEqual(payload.blockEdits, { m: 'graph TD' });
  assert.equal(payload.annotations.length, 1);
  assert.ok(!('removed' in payload.answers));
});

test('a draft the iframe saved comes back from relay_view with its block edits', async () => {
  const client = await stdioClient();
  const made = await client.callTool({ name: 'relay_board', arguments: SPEC });
  const { boardId } = made.structuredContent;
  const token = made._meta.relay.token;
  await client.callTool({ name: 'relay_draft', arguments: { boardId, token, draft: { answers: { go: 'yes' }, comment: 'wip', blockEdits: { m: 'graph TD' } } } });
  const view = (await client.callTool({ name: 'relay_view', arguments: { boardId, token } })).structuredContent;
  assert.equal(view.draft.answers.go, 'yes');
  assert.equal(view.draft.comment, 'wip');
  assert.deepEqual(view.draft.blockEdits, { m: 'graph TD' });
});

test('the inline renderer keeps an isolated option as supplied and returns its choice', async () => {
  const client = await stdioClient();
  const html = '<style>body { color: navy; }</style><button>Preview</button>';
  const made = await client.callTool({ name: 'relay_board', arguments: {
    title: 'Live options',
    questions: [{ id: 'layout', type: 'single', label: 'Which layout?', options: [
      { value: 'first', label: 'First', blocks: [{ type: 'html', html, isolated: true }] },
      { value: 'second', label: 'Second', blocks: [{ type: 'html', html }] },
    ] }],
  } });
  const { boardId } = made.structuredContent;
  const token = made._meta.relay.token;
  const { spec } = (await client.callTool({ name: 'relay_view', arguments: { boardId, token } })).structuredContent;
  const [isolated, themed] = spec.questions[0].options.map((option) => option.blocks[0]);
  const vendors = fs.readFileSync(path.join(ROOT, 'src', 'mcp-ui', 'board', 'vendors.js'), 'utf8');
  const context = vm.createContext({ Blob, URL, spec, effectiveTheme: () => 'dark' });
  const urls = vm.runInContext(`${vendors}
    indexHtmlBlocks(spec);
    [htmlBlobSrc(${JSON.stringify(isolated.id)}), htmlBlobSrc(${JSON.stringify(themed.id)})];`, context);
  try {
    const [isolatedDocument, themedDocument] = await Promise.all(urls.map(async (url) => (await fetch(url)).text()));
    assert.equal(isolatedDocument, html);
    assert.match(themedDocument, /color-scheme:dark/);
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
  const submit = await client.callTool({ name: 'relay_submit', arguments: { boardId, token, payload: { answers: { layout: 'first' } } } });
  assert.ok(!submit.isError);
  const result = await client.callTool({ name: 'relay_result', arguments: { boardId } });
  assert.deepEqual(JSON.parse(result.content[0].text).answers, { layout: 'first' });
});
