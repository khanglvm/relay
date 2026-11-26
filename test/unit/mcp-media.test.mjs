// Local video and pdf blocks on MCP boards: the iframe gets a host URL, and the host streams the file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { viewSpec } from '../../src/mcp/media.js';
import { serveBoardMedia } from '../../src/mcp/index.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rly-media-')));
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rly-outside-')));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(OUTSIDE, { recursive: true, force: true }); });

const clip = path.join(ROOT, 'clip.mp4');
fs.writeFileSync(clip, Buffer.from('0123456789'));
const urlFor = (boardId, blockId) => `https://hub.test/media/${boardId}/${blockId}`;

const spec = {
  blocks: [{ id: 'v', type: 'video', file: clip, mime: 'video/mp4', title: 'clip.mp4' }, { id: 'm', type: 'markdown', md: 'hi' }, { id: 'y', type: 'video', provider: 'youtube', videoId: 'abcdefghijk' }],
  questions: [{ id: 'q', type: 'single', blocks: [{ id: 'q-p', type: 'pdf', file: clip, mime: 'application/pdf' }], options: [{ value: 'a', label: 'A', blocks: [{ id: 'q-o1-v', type: 'video', file: clip, mime: 'video/mp4' }] }, { value: 'b', label: 'B' }] }],
};

test('viewSpec points every local media block at the host URL and drops the server path', () => {
  const view = viewSpec(spec, 'b-1', urlFor);
  assert.deepEqual(view.blocks[0], { id: 'v', type: 'video', mime: 'video/mp4', title: 'clip.mp4', src: urlFor('b-1', 'v') });
  assert.equal(view.blocks[1], spec.blocks[1]);
  assert.equal(view.blocks[2], spec.blocks[2]);
  assert.equal(view.questions[0].blocks[0].src, urlFor('b-1', 'q-p'));
  assert.equal(view.questions[0].options[0].blocks[0].src, urlFor('b-1', 'q-o1-v'));
  assert.deepEqual(view.questions[0].options[1], { value: 'b', label: 'B' });
  assert.ok(!JSON.stringify(view).includes(ROOT), 'no server path reaches the iframe');
  assert.equal(spec.blocks[0].file, clip, 'the stored spec is left as it was');
});

test('viewSpec without a host URL still hides the server path', () => {
  const view = viewSpec(spec, 'b-1');
  assert.equal(view.blocks[0].src, undefined);
  assert.ok(!JSON.stringify(view).includes(ROOT));
});

function serve(records) {
  const store = { get: (id) => records[id] ?? null };
  const server = http.createServer((req, res) => {
    const [, boardId, blockId] = req.url.split('/');
    serveBoardMedia(req, res, { boardId, blockId, store });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const fetchFrom = (server, url, init) => fetch(`http://127.0.0.1:${server.address().port}${url}`, init);

test('serveBoardMedia streams a stored block with Range and refuses everything else alike', async (t) => {
  const outsideFile = path.join(OUTSIDE, 'secret.mp4');
  fs.writeFileSync(outsideFile, 'secret');
  const record = (file) => ({ cwd: ROOT, fileRoots: [ROOT], spec: { blocks: [{ id: 'v', type: 'video', file, mime: 'video/mp4' }, { id: 'm', type: 'markdown', md: 'x' }], questions: [] } });
  const server = await serve({ 'b-ok': record(clip), 'b-out': record(outsideFile), 'b-gone': record(path.join(ROOT, 'gone.mp4')) });
  t.after(() => server.close());

  const full = await fetchFrom(server, '/b-ok/v');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(await full.text(), '0123456789');

  const part = await fetchFrom(server, '/b-ok/v', { headers: { range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await part.text(), '234');

  const head = await fetchFrom(server, '/b-ok/v', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');

  for (const url of ['/b-none/v', '/b-ok/nope', '/b-ok/m', '/b-out/v', '/b-gone/v']) {
    const res = await fetchFrom(server, url);
    assert.equal(res.status, 404, url);
    assert.deepEqual(await res.json(), { error: 'no such media' }, url);
  }
});
