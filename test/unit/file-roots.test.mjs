// Local files a spec names: only paths inside the configured roots are read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createFileAccess, openReadable, resolveReadable } from '../../src/file-access.js';
import { normalizeSpec } from '../../src/spec/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'rly.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rly-roots-')));
const HOME = path.join(TMP, 'home');
const ENV = { ...process.env, RLY_HOME: path.join(TMP, 'relay-home'), HOME };
const open = [];
after(async () => {
  await Promise.allSettled(open.map((fn) => fn()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

// work/ is the allowed root; outside/ holds the "secret"; work/link points at outside/.
const work = path.join(TMP, 'work');
const outside = path.join(TMP, 'outside');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
fs.mkdirSync(outside);
const SECRET = path.join(outside, 'secret.txt');
fs.writeFileSync(SECRET, 'TOP-SECRET');
fs.writeFileSync(path.join(HOME, 'homefile.txt'), 'in home');
fs.writeFileSync(path.join(work, 'ok.txt'), 'fine');
fs.writeFileSync(path.join(work, 'sub', 'ok.ts'), 'export const a = 1;');
fs.symlinkSync(outside, path.join(work, 'link'));
fs.symlinkSync(SECRET, path.join(work, 'secret-link.txt'));
fs.symlinkSync(work, path.join(TMP, 'work-alias'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(work, 'dot.png'), PNG);

const codeBlock = (codeFile) => ({ blocks: [{ type: 'code', codeFile }] });
const read = (spec, options = { cwd: work, fileRoots: [work] }) => normalizeSpec(spec, options);

test('a file inside a root is read, by relative and absolute path', () => {
  assert.equal(read(codeBlock('ok.txt')).blocks[0].code, 'fine');
  assert.equal(read(codeBlock('sub/../ok.txt')).blocks[0].code, 'fine');
  assert.equal(read(codeBlock(path.join(work, 'sub', 'ok.ts'))).blocks[0].code, 'export const a = 1;');
});

test('../ out of the root is refused with a message that says how to fix it', () => {
  assert.throws(() => read(codeBlock('../outside/secret.txt')), /path outside allowed roots.*--root.*fileRoots/s);
  assert.throws(() => read(codeBlock('sub/../../outside/secret.txt')), /outside allowed roots/);
});

test('an absolute path outside the roots is refused', () => {
  assert.throws(() => read(codeBlock(SECRET)), /outside allowed roots/);
});

test('a symlink inside a root cannot reach outside it', () => {
  assert.throws(() => read(codeBlock('link/secret.txt')), /outside allowed roots/);
  assert.throws(() => read(codeBlock('secret-link.txt')), /outside allowed roots/);
});

test('a root that is a symlink still works, and so does a path through it', () => {
  const alias = path.join(TMP, 'work-alias');
  assert.equal(read(codeBlock('ok.txt'), { cwd: alias, fileRoots: [alias] }).blocks[0].code, 'fine');
  assert.equal(read(codeBlock(path.join(alias, 'ok.txt')), { cwd: work, fileRoots: [work] }).blocks[0].code, 'fine');
});

test('a device path and a directory are refused', () => {
  assert.throws(() => read(codeBlock('/dev/null')), /outside allowed roots/);
  // Even when the operator allows /dev, a device is not a regular file.
  assert.throws(() => read(codeBlock('/dev/null'), { cwd: work, fileRoots: ['/dev'] }), /not a regular file/);
  assert.throws(() => read(codeBlock('sub')), /not a regular file/);
});

test('every refusal reads the same, whether the path is missing, a directory, a symlink out or outside', () => {
  const message = (given) => {
    try { read(codeBlock(given)); } catch (err) { return err.message; }
    return assert.fail(`${given} was read`);
  };
  const generic = (given) => message(given).replaceAll(JSON.stringify(given), '"PATH"');
  const refusals = ['nope.txt', 'sub', 'link/secret.txt', 'secret-link.txt', '../outside/nope.txt', SECRET, path.join(outside, 'nope.txt')];
  assert.equal(new Set(refusals.map(generic)).size, 1, 'one message for every kind of refusal');
  assert.match(generic('nope.txt'), /cannot read "PATH".*no such file, not a regular file, or path outside allowed roots.*--root.*fileRoots/);
});

test('a refusal echoes the path as written and never a resolved target or folder layout', () => {
  for (const given of ['secret-link.txt', 'link/secret.txt', 'sub/../nope.txt']) {
    const text = (() => { try { read(codeBlock(given)); } catch (err) { return err.message; } return ''; })();
    assert.ok(text.includes(JSON.stringify(given)), given);
    assert.ok(!text.includes(TMP) && !text.includes('resolved'), `${given}: ${text}`);
  }
});

test('~ expands to the home directory and is checked like any other path', () => {
  const saved = process.env.HOME;
  process.env.HOME = HOME;
  try {
    assert.throws(() => read(codeBlock('~/homefile.txt')), /outside allowed roots/);
    assert.equal(read(codeBlock('~/homefile.txt'), { cwd: work, fileRoots: ['~'] }).blocks[0].code, 'in home');
  } finally {
    process.env.HOME = saved;
  }
});

test('Windows-style paths and NUL bytes are not read', () => {
  assert.throws(() => read(codeBlock('C:\\Windows\\win.ini')), /cannot read|outside allowed roots/);
  assert.throws(() => read(codeBlock('\\\\server\\share\\x.txt')), /cannot read|outside allowed roots/);
  assert.throws(() => read(codeBlock('ok.txt\0.png')), /cannot read/);
});

test('no roots reads nothing; the default root is the working directory', () => {
  assert.throws(() => read(codeBlock('ok.txt'), { cwd: work, fileRoots: [] }), /outside allowed roots/);
  assert.equal(read(codeBlock('ok.txt'), { cwd: work }).blocks[0].code, 'fine');
  assert.throws(() => read(codeBlock('../outside/secret.txt'), { cwd: work }), /outside allowed roots/);
});

test('a root that does not exist grants nothing', () => {
  assert.throws(() => read(codeBlock(SECRET), { cwd: work, fileRoots: [path.join(TMP, 'missing')] }), /outside allowed roots/);
});

test('every field that reads a file goes through the roots', () => {
  const secretPng = path.join(outside, 'x.png');
  fs.writeFileSync(secretPng, PNG);
  fs.writeFileSync(path.join(outside, 'x.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(outside, 'x.mp4'), 'v');
  fs.writeFileSync(path.join(outside, 'x.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(outside, 'x.conflict'), '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n');
  const attempts = {
    htmlFile: { htmlFile: SECRET },
    'block htmlFile': { blocks: [{ type: 'html', htmlFile: SECRET }] },
    mdFile: { blocks: [{ type: 'markdown', mdFile: SECRET }] },
    codeFile: codeBlock(SECRET),
    diffFile: { blocks: [{ type: 'diff', diffFile: SECRET }] },
    rowsFile: { blocks: [{ type: 'table', rowsFile: path.join(outside, 'x.csv') }] },
    image: { blocks: [{ type: 'image', src: secretPng }] },
    compare: { blocks: [{ type: 'compare', before: secretPng, after: path.join(work, 'dot.png') }] },
    'pick tile image': { questions: [{ id: 'p', type: 'pick', label: 'Pick', items: [{ id: 'a', title: 'A', image: secretPng }] }] },
    pdf: { blocks: [{ type: 'pdf', src: path.join(outside, 'x.pdf') }] },
    video: { blocks: [{ type: 'video', src: path.join(outside, 'x.mp4') }] },
    'git-conflict': { blocks: [{ type: 'git-conflict', file: path.join(outside, 'x.conflict') }] },
    'question option blocks': { questions: [{ id: 'q', type: 'single', label: 'Q', options: [{ value: 'a', label: 'A', blocks: [{ type: 'code', codeFile: SECRET }] }] }] },
  };
  for (const [name, spec] of Object.entries(attempts)) {
    assert.throws(() => read(spec), /outside allowed roots/, name);
  }
  const inside = {
    image: { blocks: [{ type: 'image', src: 'dot.png' }] },
    tile: { questions: [{ id: 'p', type: 'pick', label: 'Pick', items: [{ id: 'a', title: 'A', image: 'dot.png' }] }] },
  };
  assert.match(read(inside.image).blocks[0].src, /^data:image\/png;base64,/);
  assert.match(read(inside.tile).questions[0].items[0].image, /^data:image\/png;base64,/);
});

test('resolveReadable returns the real path of a file under a symlinked root', () => {
  const alias = path.join(TMP, 'work-alias');
  const access = createFileAccess({ cwd: alias, roots: [alias] });
  assert.equal(resolveReadable(access, 'ok.txt', 'board', 'codeFile').file, path.join(work, 'ok.txt'));
});

async function httpClient(extraArgs, env = ENV) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [BIN, 'mcp', '--http', '--port', String(port), '--token', 't', ...extraArgs], { env, cwd: work });
  open.push(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => String(d).includes('listening') && resolve());
    child.on('error', reject);
    child.on('exit', () => reject(new Error('rly mcp --http exited')));
  });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: 'Bearer t' } } });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  open.push(() => client.close());
  return client;
}

const boardArgs = (file) => ({ title: 'T', blocks: [{ type: 'code', codeFile: file }] });

test('rly mcp --http refuses local files by default, even under its working directory', async () => {
  const client = await httpClient([]);
  for (const file of [SECRET, '/etc/hosts', path.join(work, 'ok.txt'), 'ok.txt']) {
    const r = await client.callTool({ name: 'relay_board', arguments: boardArgs(file) });
    assert.equal(r.isError, true, file);
    assert.match(r.content[0].text, /outside allowed roots/, file);
  }
});

test('rly mcp --http reads a file only inside a --root or $RLY_FILE_ROOTS', async () => {
  const withFlag = await httpClient(['--root', work]);
  assert.equal((await withFlag.callTool({ name: 'relay_board', arguments: boardArgs(path.join(work, 'ok.txt')) })).isError, undefined);
  const refused = await withFlag.callTool({ name: 'relay_board', arguments: boardArgs(SECRET) });
  assert.equal(refused.isError, true);
  const withEnv = await httpClient([], { ...ENV, RLY_FILE_ROOTS: [work, outside].join(path.delimiter) });
  assert.equal((await withEnv.callTool({ name: 'relay_board', arguments: boardArgs(SECRET) })).isError, undefined);
});

test('registerRelay allows files only under the fileRoots it is given', async () => {
  const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { registerRelay } = await import('../../src/mcp/index.js');
  const boards = new Map();
  const store = {
    create: (spec, options) => { const record = { id: `b-${boards.size}`, spec, options }; boards.set(record.id, record); return record; },
    get: (id) => boards.get(id) ?? null,
    update: (id, patch) => Object.assign(boards.get(id), patch),
  };
  const call = async (options) => {
    const server = new McpServer({ name: 'host', version: '1' });
    registerRelay(server, { store, tokenKey: 'k', ...options });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const result = await client.callTool({ name: 'relay_board', arguments: boardArgs(path.join(work, 'ok.txt')) });
    await client.close();
    return result;
  };
  const refused = await call({});
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /outside allowed roots/);
  const allowed = await call({ fileRoots: [work] });
  assert.equal(allowed.isError, undefined);
  assert.deepEqual(boards.get(allowed.structuredContent.boardId).options.fileRoots, [work]);
});

async function rly(args, { cwd, env = ENV } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { env, cwd });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.ok(out, `rly ${args[0]} printed nothing: ${err}`);
  return JSON.parse(out);
}

test('rly ask reads the spec file\'s folder (moodboard layout) and the live server opens only files inside the roots', async () => {
  const board = path.join(TMP, 'boards', 'b1');
  fs.mkdirSync(path.join(board, 'thumbs'), { recursive: true });
  fs.writeFileSync(path.join(board, 'thumbs', 'one.png'), PNG);
  fs.writeFileSync(path.join(board, 'notes.md'), 'notes');
  const mdWithLinks = `See ${path.join(board, 'notes.md')} and ${SECRET}`;
  fs.writeFileSync(path.join(board, 'spec.json'), JSON.stringify({
    title: 'Moodboard',
    blocks: [{ type: 'markdown', md: mdWithLinks }],
    questions: [{ id: 'p', type: 'pick', label: 'Pick', items: [{ id: 'one', title: 'One', image: path.join(board, 'thumbs', 'one.png') }] }],
  }));
  const elsewhere = path.join(TMP, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const started = await rly(['ask', '--file', path.join(board, 'spec.json'), '--detach', '--no-open'], { cwd: elsewhere });
  open.push(() => rly(['stop', started.boardId], { cwd: elsewhere }));
  assert.equal(started.status, 'open');
  const stored = JSON.parse(fs.readFileSync(path.join(ENV.RLY_HOME, 'boards', `${started.boardId}.json`), 'utf8'));
  assert.match(stored.spec.questions[0].items[0].image, /^data:image\/png;base64,/);
  assert.ok(stored.fileRoots.includes(board));
  const preview = (file) => fetch(new URL('/api/file-preview', started.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) });
  assert.equal((await preview(path.join(board, 'notes.md'))).status, 200);
  const refused = await preview(SECRET);
  assert.equal(refused.status, 403);
  assert.doesNotMatch(await refused.text(), /TOP-SECRET/);
});

test('rly ask refuses a spec file path outside the spec folder and the working directory', async () => {
  const board = path.join(TMP, 'boards', 'b2');
  fs.mkdirSync(board, { recursive: true });
  fs.writeFileSync(path.join(board, 'spec.json'), JSON.stringify({ blocks: [{ type: 'code', codeFile: SECRET }] }));
  const r = spawn(process.execPath, [BIN, 'ask', '--file', path.join(board, 'spec.json'), '--detach', '--no-open'], { env: ENV, cwd: work });
  let err = '';
  r.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((resolve) => r.on('close', resolve));
  assert.notEqual(code, 0);
  assert.match(err, /outside allowed roots/);
});

// The file a check approved must be the file that is read: a swap between the check and the open is refused.
const swapTest = process.platform === 'win32' ? test.skip : test;

function swapBeforeOpen(swap) {
  const realOpen = fs.openSync;
  return mock.method(fs, 'openSync', (...args) => {
    swap();
    return realOpen(...args);
  });
}

swapTest('a file swapped for a symlink to an outside file between the check and the open is not read', () => {
  const target = path.join(work, 'race-file.txt');
  fs.writeFileSync(target, 'inside');
  const hook = swapBeforeOpen(() => {
    fs.rmSync(target);
    fs.symlinkSync(SECRET, target);
  });
  try {
    assert.throws(() => read(codeBlock('race-file.txt')), /cannot read "race-file.txt"/);
    assert.equal(hook.mock.callCount(), 1);
  } finally {
    hook.mock.restore();
    fs.rmSync(target, { force: true });
  }
});

swapTest('a folder swapped for a symlink to an outside folder between the check and the open is not read', () => {
  const dir = path.join(work, 'race-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'inside');
  fs.mkdirSync(path.join(outside, 'race-dir'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'race-dir', 'f.txt'), 'OUTSIDE');
  const hook = swapBeforeOpen(() => {
    fs.renameSync(dir, `${dir}.moved`);
    fs.symlinkSync(path.join(outside, 'race-dir'), dir);
  });
  try {
    assert.throws(() => read(codeBlock('race-dir/f.txt')), /cannot read "race-dir\/f.txt"/);
  } finally {
    hook.mock.restore();
    fs.rmSync(dir, { force: true });
    fs.rmSync(`${dir}.moved`, { recursive: true, force: true });
  }
});

swapTest('a file replaced by another file inside the roots is read as the file the path names now', () => {
  const target = path.join(work, 'race-same.txt');
  fs.writeFileSync(target, 'before');
  const hook = swapBeforeOpen(() => {
    fs.rmSync(target);
    fs.writeFileSync(target, 'after');
  });
  try {
    assert.equal(read(codeBlock('race-same.txt')).blocks[0].code, 'after');
  } finally {
    hook.mock.restore();
    fs.rmSync(target, { force: true });
  }
});

test('openReadable hands back one descriptor for a file and none for a directory', () => {
  const access = createFileAccess({ cwd: work, roots: [work] });
  const file = openReadable(access, 'ok.txt');
  assert.ok(file.ok && typeof file.fd === 'number');
  assert.equal(fs.readFileSync(file.fd, 'utf8'), 'fine');
  fs.closeSync(file.fd);
  const dir = openReadable(access, 'sub', { allowDirectory: true });
  assert.ok(dir.ok && dir.fd === null);
  assert.equal(openReadable(access, 'sub').ok, false);
  assert.equal(openReadable(access, SECRET).reason, 'outside');
});
