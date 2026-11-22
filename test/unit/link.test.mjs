// Link settings: which setting wins, what a devlink answer must look like, and how
// resolveLink behaves with devlink present, absent or failing. No process is started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findDevlink, isLoopbackHost, linkSetting, parseLinkValue, pickDevlinkUrl, pickLinkUrl, resolveLink, serializeLink } from '../../src/link.js';

const devlinkJson = (url) => JSON.stringify({ records: [{ url }] });
const fakeExec = (stdout) => { const calls = []; const fn = async (bin, args) => { calls.push([bin, ...args]); return { stdout }; }; fn.calls = calls; return fn; };

test('loopback hosts are recognised', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]', '::1']) assert.ok(isLoopbackHost(host), host);
  for (const host of ['internal.example.dev', '100.64.0.5', 'boards.example.com']) assert.ok(!isLoopbackHost(host), host);
});

test('parseLinkValue accepts the named modes and https templates', () => {
  assert.deepEqual(parseLinkValue('off'), { mode: 'off' });
  assert.deepEqual(parseLinkValue('local'), { mode: 'off' });
  assert.deepEqual(parseLinkValue('AUTO'), { mode: 'auto' });
  assert.deepEqual(parseLinkValue('devlink'), { mode: 'devlink' });
  assert.deepEqual(parseLinkValue('https://boards.example.com:{port}/'), { mode: 'url', template: 'https://boards.example.com:{port}' });
});

test('parseLinkValue refuses loopback URLs and unknown words', () => {
  assert.throws(() => parseLinkValue('http://boards.example.com:{port}'), /use https/);
  assert.throws(() => parseLinkValue('https://localhost:{port}'), /only works on this machine/);
  assert.throws(() => parseLinkValue('https://127.0.0.1:{port}'), /only works on this machine/);
  assert.throws(() => parseLinkValue('vpn'), /use off, auto, devlink/);
  assert.throws(() => parseLinkValue('https://'), /not a valid URL/);
});

test('linkSetting precedence, highest first', () => {
  const env = { RLY_PUBLIC_URL: 'https://a.example.com:{port}', RLY_LINK: 'auto' };
  const config = { link: 'devlink' };
  assert.deepEqual(linkSetting({ args: { noDevlink: true, devlink: true }, env, config }), { mode: 'off' });
  assert.deepEqual(linkSetting({ args: { devlink: true }, env, config }), { mode: 'devlink' });
  assert.deepEqual(linkSetting({ args: { publicUrl: 'https://b.example.com:{port}' }, env, config }).template, 'https://b.example.com:{port}');
  assert.equal(linkSetting({ env, config }).template, 'https://a.example.com:{port}');
  assert.deepEqual(linkSetting({ env: { RLY_LINK: 'auto' }, config }), { mode: 'auto' });
  assert.deepEqual(linkSetting({ env: {}, config }), { mode: 'devlink' });
  assert.deepEqual(linkSetting({ env: {}, config: {} }), { mode: 'off' });
});

test('serializeLink round-trips through parseLinkValue', () => {
  for (const setting of [{ mode: 'off' }, { mode: 'auto' }, { mode: 'devlink' }, { mode: 'url', template: 'https://x.example.com:{port}' }]) {
    assert.deepEqual(parseLinkValue(serializeLink(setting)), setting);
  }
});

test('findDevlink prefers RLY_DEVLINK_BIN, then PATH, then ~/.local/bin', () => {
  assert.equal(findDevlink({ env: { RLY_DEVLINK_BIN: '/opt/devlink' }, exists: () => false }), '/opt/devlink');
  assert.equal(findDevlink({ env: { PATH: '/a:/b' }, exists: (f) => f === '/b/devlink' }), '/b/devlink');
  assert.equal(findDevlink({ env: { PATH: '/a' }, exists: () => false }), null);
});

test('pickDevlinkUrl returns the origin of a private https url', () => {
  assert.equal(pickDevlinkUrl(devlinkJson('https://internal.example.com:61083/')), 'https://internal.example.com:61083');
});

test('pickDevlinkUrl refuses loopback, plain http, no URL and non-JSON', () => {
  assert.throws(() => pickDevlinkUrl(devlinkJson('https://localhost:5000')), /not a private https URL/);
  assert.throws(() => pickDevlinkUrl(devlinkJson('http://internal.example.dev:5000')), /not a private https URL/);
  assert.throws(() => pickDevlinkUrl(JSON.stringify({ records: [] })), /no URL/);
  assert.throws(() => pickDevlinkUrl('not json'), /not JSON/);
  assert.throws(() => pickDevlinkUrl(devlinkJson('not a url')), /not a URL/);
});

test('resolveLink: off and auto-without-devlink keep the board local', async () => {
  assert.equal(await resolveLink({ mode: 'off' }, 4000), null);
  assert.equal(await resolveLink({ mode: 'auto' }, 4000, { env: { PATH: '' }, exists: () => false }), null);
});

test('resolveLink: devlink mode without the binary is an error', async () => {
  await assert.rejects(resolveLink({ mode: 'devlink' }, 4000, { env: { PATH: '' }, exists: () => false }), /needs the devlink command/);
});

test('resolveLink: devlink publishes the port and forgets it on release', async () => {
  const exec = fakeExec(devlinkJson('https://internal.example.dev:4000/'));
  const link = await resolveLink({ mode: 'devlink' }, 4000, { env: { RLY_DEVLINK_BIN: '/bin/devlink' }, exec });
  assert.equal(link.origin, 'https://internal.example.dev:4000');
  assert.deepEqual(exec.calls[0], ['/bin/devlink', '--json', 'internal', '4000']);
  link.release();
  assert.deepEqual(exec.calls[1], ['/bin/devlink', 'forget', '4000']);
});

test('command links: parse, serialize, precedence', () => {
  assert.deepEqual(parseLinkValue('command:pub {port}'), { mode: 'command', publish: 'pub {port}' });
  assert.throws(() => parseLinkValue('command:'), /needs a command/);
  assert.equal(serializeLink({ mode: 'command', publish: 'pub {port}' }), 'command:pub {port}');
  assert.deepEqual(linkSetting({ args: { linkCommand: 'pub' }, env: { RLY_PUBLIC_URL: 'https://a.example.com:{port}' }, config: {} }), { mode: 'command', publish: 'pub' });
  assert.deepEqual(linkSetting({ args: { devlink: true, linkCommand: 'pub' }, env: {}, config: {} }), { mode: 'devlink' });
});

test('resolveLink: a link command publishes the port and runs the release command', async () => {
  const exec = fakeExec('https://pub.example.com:4000/\n');
  const link = await resolveLink({ mode: 'command', publish: 'pub --port {port}' }, 4000, { env: { RLY_LINK_RELEASE_COMMAND: 'unpub' }, exec });
  assert.equal(link.origin, 'https://pub.example.com:4000');
  assert.deepEqual(exec.calls[0], ['pub', '--port', '4000']);
  link.release();
  assert.deepEqual(exec.calls[1], ['unpub', '4000']);
});

test('pickLinkUrl takes plain text or JSON and refuses loopback', () => {
  assert.equal(pickLinkUrl('{"url":"https://a.example.com:1/x"}'), 'https://a.example.com:1');
  assert.throws(() => pickLinkUrl('https://localhost:1'), /not a private https URL/);
});

test('resolveLink: a failing devlink names the port and the reason', async () => {
  const exec = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'line one\nnetwork is down' }); };
  await assert.rejects(resolveLink({ mode: 'devlink' }, 4000, { env: { RLY_DEVLINK_BIN: '/bin/devlink' }, exec }), /port 4000: network is down/);
});

test('resolveLink: a URL template fills in the port', async () => {
  const link = await resolveLink({ mode: 'url', template: 'https://boards.example.com:{port}' }, 4321);
  assert.equal(link.origin, 'https://boards.example.com:4321');
});

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'rly.js');

test('--public-url: the board prints the public origin with a collab token and locks tokenless requests', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-link-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, RLY_HOME: home };
  const rly = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  try {
    const spec = path.join(home, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({ title: 'link', blocks: [{ type: 'markdown', md: 'hi' }] }));
    const opened = rly(['ask', '--file', spec, '--detach', '--no-open', '--public-url', 'https://boards.example.com:{port}']);
    assert.equal(opened.status, 0, opened.stderr);
    const { boardId, url, port } = JSON.parse(opened.stdout);
    const shared = new URL(url);
    assert.equal(shared.origin, `https://boards.example.com:${port}`);
    assert.equal(shared.searchParams.get('share'), 'collab');

    // The proxy forwards the public Host; a request without the token is refused.
    const get = (query) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/status${query}`, headers: { host: `boards.example.com:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(await get(`?share=collab&token=${shared.searchParams.get('token')}`), 200);
    assert.notEqual(await get(''), 200);
    rly(['stop', boardId]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Opens a board in a throwaway RLY_HOME and returns {port, token, rly, share(headers)}; share GETs /api/share via 127.0.0.1.
async function withBoard(extraArgs, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-link-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, RLY_HOME: home };
  const rly = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  try {
    const spec = path.join(home, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({ title: 'link', blocks: [{ type: 'markdown', md: 'hi' }] }));
    const opened = rly(['ask', '--file', spec, '--detach', '--no-open', ...extraArgs]);
    assert.equal(opened.status, 0, opened.stderr);
    const { boardId, port } = JSON.parse(opened.stdout);
    const { token } = JSON.parse(fs.readFileSync(path.join(home, 'running', `${boardId}.json`), 'utf8'));
    const share = (headers) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/share', headers: { host: `localhost:${port}`, ...headers } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    try { await fn({ boardId, port, token, rly, share }); } finally { rly(['stop', boardId]); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a request through a local proxy is not the owner, even with a loopback Host', async () => {
  await withBoard(['--no-devlink'], async ({ port, share }) => {
    assert.equal(await share({}), 200);
    // The link gateway rewrites Host to localhost:PORT and adds forwarding headers.
    assert.equal(await share({ 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': `localhost:${port}` }), 403);
    assert.equal(await share({ forwarded: 'for=100.64.0.9' }), 403);
    assert.equal(await share({ 'x-real-ip': '100.64.0.9' }), 403);
  });
});

test('with a public link, the owner needs the control token, so a header-less proxy is locked out', async () => {
  await withBoard(['--public-url', 'https://boards.example.com:{port}'], async ({ boardId, token, rly, share }) => {
    assert.equal(await share({}), 403);
    assert.equal(await share({ 'x-relay-token': 'wrong' }), 403);
    assert.equal(await share({ 'x-relay-token': token }), 200);
    const listed = rly(['share', boardId]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).status, 'shares');
  });
});
