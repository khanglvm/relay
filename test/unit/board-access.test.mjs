// Who may act as a live board's owner, and what a request can and cannot change about its file roots.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isBroadRoot } from '../../src/file-access.js';
import { isDirectLocalRequest, isLoopbackAddress } from '../../src/server/http.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'rly.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rly-access-')));
const RLY_HOME = path.join(TMP, 'relay-home');
const ENV = { ...process.env, RLY_HOME, HOME: path.join(TMP, 'home'), RLY_OPEN_CMD: 'true' };
const work = path.join(TMP, 'work');
const SECRET = path.join(TMP, 'outside', 'secret.pdf');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.dirname(SECRET));
fs.mkdirSync(ENV.HOME);
fs.writeFileSync(SECRET, '%PDF-1.4 TOP-SECRET');
fs.writeFileSync(path.join(work, 'notes.md'), 'notes');

const stops = [];
after(async () => {
  await Promise.allSettled(stops.map((fn) => fn()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function rly(args) {
  const child = spawn(process.execPath, [BIN, ...args], { env: ENV, cwd: work });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

async function startBoard() {
  const spec = path.join(work, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ title: 'T', blocks: [{ type: 'markdown', md: `See ${path.join(work, 'notes.md')}` }], questions: [{ id: 'q', type: 'text', label: 'ok?' }] }));
  const started = JSON.parse((await rly(['ask', '--file', spec, '--detach', '--no-open'])).out);
  stops.push(() => rly(['stop', started.boardId]));
  const running = JSON.parse(fs.readFileSync(path.join(RLY_HOME, 'running', `${started.boardId}.json`), 'utf8'));
  const stored = () => JSON.parse(fs.readFileSync(path.join(RLY_HOME, 'boards', `${started.boardId}.json`), 'utf8'));
  return { id: started.boardId, url: started.url, token: running.token, stored };
}

// A non-loopback address of this machine, so a request reaches the board the way a LAN or tailnet caller would.
const LAN = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const overLan = (url) => { const u = new URL(url); u.hostname = LAN; return u.href; };

function getWithHost(url, route, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, url);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

const post = (url, route, body, headers = {}) => fetch(new URL(route, url), {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('the owner is a loopback socket with a loopback Host; a LAN caller that writes Host: localhost is not', () => {
  const req = (remoteAddress, host = 'localhost:4000', headers = {}) => ({ socket: { remoteAddress }, headers: { host, ...headers } });
  assert.equal(isDirectLocalRequest(req('127.0.0.1')), true);
  assert.equal(isDirectLocalRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(isDirectLocalRequest(req('::1', '127.0.0.1:4000')), true);
  assert.equal(isDirectLocalRequest(req('192.168.1.20')), false);
  assert.equal(isDirectLocalRequest(req('::ffff:100.64.0.7')), false);
  assert.equal(isDirectLocalRequest(req('127.0.0.1', 'board.example:443')), false);
  assert.equal(isDirectLocalRequest(req('127.0.0.1', 'localhost:4000', { 'x-forwarded-for': '1.2.3.4' })), false);
  assert.equal(isLoopbackAddress('127.10.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.1.evil'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('/ and the home directory are too wide to be an implicit root; a project folder is not', () => {
  assert.equal(isBroadRoot('/'), true);
  assert.equal(isBroadRoot(os.homedir()), true);
  assert.equal(isBroadRoot(work), false);
});

test('/api/update cannot add file roots, and a posted pdf outside them is not streamed', async () => {
  const board = await startBoard();
  const before = board.stored();
  const spec = { ...before.spec, blocks: [...before.spec.blocks, { id: 'bx', type: 'pdf', file: SECRET, mime: 'application/pdf' }] };
  const auth = { 'x-relay-token': board.token };

  const widened = await post(board.url, '/api/update', { spec, fileRoots: ['/'] }, auth);
  assert.equal(widened.status, 400);
  assert.deepEqual(board.stored().fileRoots, before.fileRoots);

  assert.equal((await post(board.url, '/api/update', { spec }, auth)).status, 200);
  const pdf = await fetch(new URL('/pdf/b/bx', board.url));
  assert.equal(pdf.status, 404);
  assert.doesNotMatch(await pdf.text(), /TOP-SECRET/);
  assert.deepEqual(board.stored().fileRoots, before.fileRoots);
});

test('rly update refuses --root', async () => {
  const board = await startBoard();
  const r = await rly(['update', board.id, '--title', 'New', '--root', '/']);
  assert.equal(r.code, 4);
  assert.match(r.err, /cannot add file roots/);
});

test('a LAN caller that writes Host: localhost does not get the owner\'s share controls', { skip: !LAN && 'no non-loopback address' }, async () => {
  const board = await startBoard();
  const port = new URL(board.url).port;
  assert.equal(await getWithHost(board.url, '/api/share', `localhost:${port}`), 200);
  assert.equal(await getWithHost(overLan(board.url), '/api/share', `localhost:${port}`), 403);
});

test('a collaborator can preview a board file but cannot open it in an app on this machine', { skip: !LAN && 'no non-loopback address' }, async () => {
  const board = await startBoard();
  assert.equal((await post(board.url, '/api/share', { role: 'collab' })).status, 200);
  const share = { 'x-relay-share-token': board.stored().share.collab.token };
  const notes = { path: path.join(work, 'notes.md') };
  assert.equal((await post(overLan(board.url), '/api/file-preview', notes, share)).status, 200);
  assert.equal((await post(overLan(board.url), '/api/open', notes, share)).status, 403);
  assert.equal((await post(board.url, '/api/open', notes)).status, 200);
});
