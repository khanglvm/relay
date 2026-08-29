// Zero-dependency smoke tests: spawn the real CLI, hit the real server,
// fake-submit like the browser would, and assert on stdout JSON + exit codes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'rly.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-test-'));
const TEST_SHARE_HOST = '192.0.2.10';
// A no-launch opener for POST /api/open: instead of the OS handler, log the
// path it was asked to open so the test can assert it without launching apps.
const OPEN_LOG = path.join(HOME, 'opened.log');
const OPENER = path.join(HOME, 'opener.sh');
fs.writeFileSync(OPENER, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(OPEN_LOG)}\n`);
fs.chmodSync(OPENER, 0o755);
// RLY_HOME is the live var; QUEST_BOARD_HOME is set too in case any code path
// still reads the pre-rename name. RLY_OPEN_CMD redirects the file opener.
// HOME points at the temp dir too, so anything resolved from os.homedir()
// (skill dirs, the `rly mcp install` host-config paths) stays inside the
// sandbox and never touches the real user's ~/.codex / ~/.claude.
const ENV = { ...process.env, HOME, USERPROFILE: HOME, RLY_HOME: HOME, QUEST_BOARD_HOME: HOME, RLY_OPEN_CMD: OPENER, RLY_SHARE_HOST: TEST_SHARE_HOST };

let passed = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (input) child.stdin.end(input);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Spawn a blocking command, resolve once stderr announces the board URL.
function spawnBlocking(args, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: ENV, cwd });
    let stdout = '';
    let stderr = '';
    let announced = false;
    const exited = new Promise((r) => child.on('close', (code) => r({ code, get stdout() { return stdout; }, get stderr() { return stderr; } })));
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!announced) {
        const m = stderr.match(/\[relay\] (b-[a-z0-9]+) open: (\S+)/);
        if (m) {
          announced = true;
          resolve({ child, id: m[1], url: m[2], exited });
        }
      }
    });
    child.on('close', () => {
      if (!announced) reject(new Error(`exited before announcing a board. stderr: ${stderr}`));
    });
    setTimeout(() => announced || reject(new Error('no board announcement after 10s')), 10_000).unref();
  });
}

async function post(url, pathname, body) {
  const res = await fetch(new URL(pathname, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

function requestViaHost(localUrl, pathname, { method = 'GET', host = TEST_SHARE_HOST, token = '', reviewSession = '', cookie = '', body = null, origin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(localUrl);
    const payload = body === null ? null : JSON.stringify(body);
    const headers = { host: `${host}:${u.port}` };
    if (payload !== null) headers['content-type'] = 'application/json';
    if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);
    if (token) headers['x-relay-share-token'] = token;
    if (reviewSession) headers['x-relay-review-session'] = reviewSession;
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(u.port),
      method,
      path: pathname,
      headers,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: raw, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const SPEC = {
  title: 'Smoke test board',
  intro: 'hello',
  questions: [
    { id: 'ship', type: 'yesno', label: 'Ship it?', required: true },
    { id: 'parts', type: 'multi', label: 'Parts?', options: ['api', 'ui', 'docs'], other: true, note: true },
    { id: 'name', type: 'text', label: 'Name?' },
    { id: 'conf', type: 'scale', label: 'Confidence?', min: 1, max: 5 },
    {
      id: 'layout', type: 'single', label: 'Layout?',
      options: [{ value: 'a', label: 'A' }, 'B'],
      html: '<b>mockup</b>', htmlHeight: 150,
    },
  ],
};
const specPath = path.join(HOME, 'spec.json');
fs.writeFileSync(specPath, JSON.stringify(SPEC));

// ---------- 1. blocking ask + page + submit ----------
console.log('1. blocking ask → submit');
{
  const { child, id, url, exited } = await spawnBlocking(['ask', '--file', specPath, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  ok(board.spec.title === 'Smoke test board', 'GET /api/board returns the spec');
  const page = await (await fetch(url)).text();
  ok(page.includes('Smoke test board'), 'page contains the title');
  ok(page.includes('"hasHtml":true'), 'page embeds hasHtml flag');
  ok(!page.includes('<b>mockup</b>'), 'custom HTML body is NOT inline in the page');
  const qHtml = await (await fetch(new URL('/html/q/layout?theme=dark', url))).text();
  ok(qHtml.includes('<b>mockup</b>'), 'per-question html served at /html/q/<id>');
  ok(qHtml.includes('color-scheme:dark'), 'html fragment auto-wrapped with theme-matching document');

  // real-time draft autosave
  await post(url, '/api/draft', { answers: { ship: 'yes' }, comment: 'wip' });
  const peek = await run(['result', id]);
  const peeked = JSON.parse(peek.stdout);
  ok(peeked.status === 'open' && peeked.draft?.answers?.ship === 'yes', 'rly result exposes live draft while open');
  const reloaded = await (await fetch(url)).text();
  ok(reloaded.includes('"prefill":{"answers":{"ship":"yes"'), 'mid-fill page reload prefills from the live draft');

  const res = await post(url, '/api/submit', {
    answers: { ship: 'yes', parts: ['api', 'custom-other'], conf: 4, layout: 'a' },
    comment: 'looks good',
    notes: { parts: 'api first, ui can wait' },
  });
  ok(res.ok, 'POST /api/submit accepted');
  const { code, stdout } = await exited;
  const result = JSON.parse(stdout);
  ok(code === 0, 'blocking ask exits 0 after submit');
  ok(result.status === 'submitted', 'result.status === submitted');
  ok(result.answers.ship === 'yes' && result.answers.conf === 4, 'answers round-trip');
  ok(result.answers.parts.includes('custom-other'), '"other" free-text value round-trips');
  ok(result.skipped.includes('name'), 'unanswered question listed in skipped');
  ok(result.comment === 'looks good', 'comment round-trips');
  ok(result.notes?.parts === 'api first, ui can wait', 'per-question note round-trips in result.notes');
  void child;
}

// ---------- 2. detach + wait ----------
console.log('2. detach + wait');
let detachedId;
{
  const r = await run(['ask', '--file', specPath, '--detach', '--no-open', '--timeout', '60']);
  ok(r.code === 0, 'detach returns immediately with code 0');
  const info = JSON.parse(r.stdout);
  ok(info.status === 'open' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.url), 'detach prints boardId + url');
  detachedId = info.boardId;

  const waitP = run(['wait', detachedId, '--timeout', '30']);
  await sleep(500);
  await post(info.url, '/api/submit', { answers: { ship: 'no' }, comment: '' });
  const w = await waitP;
  ok(w.code === 0, 'wait exits 0 on submit');
  const wr = JSON.parse(w.stdout);
  ok(wr.status === 'submitted' && wr.answers.ship === 'no', 'wait prints the result');
  ok(wr.notes && typeof wr.notes === 'object' && !Array.isArray(wr.notes), 'notes is always present (empty {} object) so consumers never miss the channel');
}

// ---------- 3. reopen with saved answers (prefill) ----------
console.log('3. reopen prefill');
{
  const r = await run(['reopen', detachedId, '--detach', '--no-open', '--timeout', '60']);
  ok(r.code === 0, 'reopen --detach starts');
  const info = JSON.parse(r.stdout);
  const page = await (await fetch(info.url)).text();
  ok(page.includes('"prefill":{"answers":{"ship":"no"'), 'reopened page is prefilled with saved answers');
  const stop = await run(['stop', info.boardId]);
  const stopped = JSON.parse(stop.stdout);
  ok(stopped.stopped[0].status === 'cancelled', 'stop → cancelled result');
}

// ---------- 4. cancel preserves draft ----------
console.log('4. stop preserves draft');
{
  const { id, url } = await spawnBlocking(['ask', '-q', 'Quick?::yesno', '--no-open', '--timeout', '60']);
  await post(url, '/api/draft', { answers: { q1: 'yes' }, comment: 'almost' });
  await run(['stop', id]);
  const r = await run(['result', id]);
  const res = JSON.parse(r.stdout);
  ok(r.code === 3 && res.status === 'cancelled', 'result of stopped board is cancelled (exit 3)');
  ok(res.draft?.answers?.q1 === 'yes', 'autosaved draft survives cancellation');
}

// ---------- 5. show (html-only) → acknowledge ----------
console.log('5. show → acknowledge');
{
  const vizPath = path.join(HOME, 'viz.html');
  fs.writeFileSync(vizPath, '<h1>proto</h1>');
  const { url, exited } = await spawnBlocking(['show', '--html-file', vizPath, '--title', 'Proto', '--no-open', '--timeout', '60']);
  const body = await (await fetch(new URL('/html/board', url))).text();
  ok(body.includes('<h1>proto</h1>'), 'board html served');
  await post(url, '/api/submit', { answers: {}, comment: '' });
  const { code, stdout } = await exited;
  ok(code === 0 && JSON.parse(stdout).status === 'acknowledged', 'html-only board acknowledges');
}

// ---------- 6. history / spec / reuse --dump / rm ----------
console.log('6. history & housekeeping');
{
  const h = await run(['history', '--json']);
  const list = JSON.parse(h.stdout);
  ok(Array.isArray(list) && list.length >= 4, `history lists boards (${list.length})`);
  const s = await run(['spec', detachedId]);
  ok(JSON.parse(s.stdout).title === 'Smoke test board', 'spec prints the saved spec');
  const d = await run(['reuse', detachedId, '--dump']);
  ok(JSON.parse(d.stdout).questions.length === SPEC.questions.length, 'reuse --dump prints spec');
  const rm = await run(['rm', detachedId]);
  ok(JSON.parse(rm.stdout).removed === detachedId, 'rm removes a board');
  const gone = await run(['result', detachedId]);
  ok(gone.code === 5, 'result of removed board → exit 5');
}

// ---------- 7. validation & misc ----------
console.log('7. validation & misc');
{
  const bad = await run(['ask', '--file', '-'], { input: '{"questions":[{"type":"nope","label":"x"}]}' });
  ok(bad.code === 4 && /unknown type/.test(bad.stderr), 'bad type → usage error (exit 4)');
  const badMermaid = await run(['ask', '--file', '-'], {
    input: JSON.stringify({ title: 'bad diagram', blocks: [{ type: 'mermaid', code: 'graph TD; A-->' }] }),
  });
  ok(badMermaid.code === 4 && /invalid mermaid syntax/.test(badMermaid.stderr), 'invalid mermaid syntax → usage error before opening a board');
  ok(/board\.blocks\[0\]/.test(badMermaid.stderr), 'invalid mermaid error points at the authored block location');
  const empty = await run(['ask']);
  ok(empty.code === 4, 'ask with no spec → usage error');
  const schema = await run(['schema']);
  ok(JSON.parse(schema.stdout).title === 'relay board spec', 'schema prints JSON Schema');
  const ver = await run(['--version']);
  ok(/^\d+\.\d+\.\d+/.test(ver.stdout.trim()), '--version prints semver');
  const help = await run(['help']);
  ok(/rly agent/.test(help.stdout) && /skill install/.test(help.stdout), 'help mentions agent guide + skill');
  const agent = await run(['agent']);
  ok(/sizing contract/i.test(agent.stdout), 'agent guide prints');
  const timeoutRun = await run(['ask', '-q', 'x?::yesno', '--no-open', '--timeout', '1']);
  ok(timeoutRun.code === 2 && JSON.parse(timeoutRun.stdout).status === 'timeout', 'timeout → exit 2');
}

// ---------- 8. blocks: every type normalizes; ids; legacy html; bad type ----------
console.log('8. blocks normalization');
{
  const BLOCKS_SPEC = {
    title: 'Blocks board',
    // Legacy board-level html → becomes the first board block (b1).
    html: '<p>legacy board</p>',
    blocks: [
      { type: 'markdown', md: '## Hello\n\nSelect *me*.' },
      { type: 'mermaid', code: 'graph TD; A-->B' },
      {
        type: 'chart',
        kind: 'bar',
        labels: ['x', 'y'],
        series: [{ label: 'S1', data: [1, 2], color: '#c2674b' }],
        title: 'Counts',
      },
      { type: 'table', columns: ['A', { key: 'b', label: 'B', align: 'right' }], rows: [[1, 2]], sortable: true },
      { type: 'code', lang: 'js', code: 'const a = 1;' },
      { type: 'html', html: '<b>board block html</b>' },
    ],
    questions: [
      {
        id: 'pick',
        type: 'single',
        label: 'Pick one',
        options: ['a', 'b'],
        // Legacy per-question html → first question block (pick-b1).
        html: '<p>legacy q</p>',
        blocks: [
          { type: 'markdown', md: 'q markdown' },
          { type: 'chart', config: { type: 'pie', data: { labels: ['p'], datasets: [{ data: [1] }] } } },
        ],
      },
    ],
  };
  const blocksSpecPath = path.join(HOME, 'blocks-spec.json');
  fs.writeFileSync(blocksSpecPath, JSON.stringify(BLOCKS_SPEC));

  const { id, url, exited } = await spawnBlocking(['ask', '--file', blocksSpecPath, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  const bb = board.spec.blocks;
  // Legacy html prepended → b1; then the 6 declared blocks → b2..b7.
  ok(bb.length === 7, `board has 7 blocks (1 legacy + 6 declared), got ${bb.length}`);
  ok(bb[0].type === 'html' && bb[0].id === 'b1' && bb[0].html.includes('legacy board'), 'legacy board html normalized into block b1');
  ok(bb.map((b) => b.id).join(',') === 'b1,b2,b3,b4,b5,b6,b7', 'board block ids are b1..b7 in order');
  const byType = Object.fromEntries(bb.slice(1).map((b) => [b.type, b]));
  ok(byType.markdown && byType.mermaid && byType.chart && byType.table && byType.code && byType.html, 'every declared board block type normalized');
  ok(byType.chart.kind === 'bar' && byType.chart.series[0].data.length === 2 && byType.chart.height === 320, 'chart shorthand normalized with default height 320');
  ok(byType.table.columns[1].key === 'b' && byType.table.columns[1].align === 'right' && byType.table.sortable === true, 'table columns/sortable normalized');

  const qb = board.spec.questions[0].blocks;
  ok(qb.length === 3, `question has 3 blocks (1 legacy + 2 declared), got ${qb.length}`);
  ok(qb.map((b) => b.id).join(',') === 'pick-b1,pick-b2,pick-b3', 'question block ids are <qid>-b1..b3');
  ok(qb[0].type === 'html' && qb[0].html.includes('legacy q'), 'legacy per-question html normalized into pick-b1');
  ok(qb[2].type === 'chart' && qb[2].config.type === 'pie', 'full Chart.js config block round-trips');

  // The page strips html block bodies but keeps metadata.
  const page = await (await fetch(url)).text();
  ok(page.includes('"hasHtml":true'), 'html block ships hasHtml flag, body stripped');
  ok(!page.includes('board block html'), 'html block body is NOT inline in the page');

  await post(url, '/api/submit', { answers: { pick: 'a' } });
  await exited;
  void id;

  // Invalid block type → usage error (exit 4) with a "blocks[" location in the message.
  const badBlock = await run(['ask', '--file', '-'], {
    input: JSON.stringify({ title: 'x', blocks: [{ type: 'nope' }] }),
  });
  ok(badBlock.code === 4, 'invalid block type → exit 4');
  ok(/blocks\[/.test(badBlock.stderr), 'invalid block error message references blocks[<i>]');
}

// ---------- 9. /vendor/<file> serving ----------
console.log('9. /vendor serving');
{
  const VENDOR_DIR = path.join(ROOT, 'vendor');
  const chartPresent = fs.existsSync(path.join(VENDOR_DIR, 'chart.umd.js'));
  // A spec that needs the chart vendor so boot.vendor.chart can be exercised.
  const { url, exited } = await spawnBlocking([
    'ask', '-q', 'ok?::yesno', '--no-open', '--timeout', '60',
  ]);
  if (chartPresent) {
    const res = await fetch(new URL('/vendor/chart.umd.js', url));
    const body = await res.text();
    const ct = res.headers.get('content-type') || '';
    const trimmed = body.trim();
    ok(res.status === 200, 'GET /vendor/chart.umd.js → 200');
    ok(/javascript/.test(ct), 'vendor file served with a JS content-type');
    // JS-looking: non-empty and not the JSON error object the 404 path returns.
    ok(trimmed.length > 0 && !(trimmed.startsWith('{') && /"error"/.test(trimmed)), 'vendor file body looks like JS (not a JSON error / empty)');
  } else {
    // Vendor assets are produced by the (concurrent) vendor agent; until they
    // land the route must degrade to 404, not error.
    const res = await fetch(new URL('/vendor/chart.umd.js', url));
    ok(res.status === 404, 'GET /vendor/chart.umd.js → 404 while vendor not yet vendored (route degrades cleanly)');
    console.log('    (note: vendor/chart.umd.js not present yet — 200 assertion deferred to vendor agent)');
  }
  const miss = await fetch(new URL('/vendor/nope.js', url));
  ok(miss.status === 404, 'GET /vendor/nope.js → 404');
  // Path traversal must not escape the vendor dir.
  const esc = await fetch(new URL('/vendor/' + encodeURIComponent('../package.json'), url));
  ok(esc.status === 404, 'GET /vendor/../package.json (traversal) → 404');
  await post(url, '/api/submit', { answers: { q1: 'yes' } });
  await exited;
}

// ---------- 10. /kit.js ----------
console.log('10. /kit.js');
{
  const { url, exited } = await spawnBlocking(['ask', '-q', 'ok?::yesno', '--no-open', '--timeout', '60']);
  const res = await fetch(new URL('/kit.js', url));
  const body = await res.text();
  ok(res.status === 200, 'GET /kit.js → 200');
  ok(/javascript/.test(res.headers.get('content-type') || ''), '/kit.js served with a JS content-type');
  ok(body.includes('relayKit'), '/kit.js body contains relayKit');
  await post(url, '/api/submit', { answers: { q1: 'yes' } });
  await exited;
}

// ---------- 11. /html/b/<id> serves theme-wrapped html block ----------
console.log('11. /html/b/<id>');
{
  const HTML_BLOCK_SPEC = {
    title: 'Html block board',
    blocks: [{ type: 'html', html: '<b>block body marker</b>' }],
    questions: [{ id: 'go', type: 'yesno', label: 'Go?' }],
  };
  const p = path.join(HOME, 'htmlblock-spec.json');
  fs.writeFileSync(p, JSON.stringify(HTML_BLOCK_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const body = await (await fetch(new URL('/html/b/b1?theme=dark', url))).text();
  ok(body.includes('<b>block body marker</b>'), '/html/b/<id> serves the html block body');
  ok(body.includes('<!doctype html') && body.includes('color-scheme:dark'), 'fragment auto-wrapped with theme-matching document');
  ok(body.includes('relayKit.annotate.auto') && body.includes("'/kit.js'"), 'annotate bootstrap injected so every element is hover-commentable');
  const legacy = await (await fetch(new URL('/html/board', url))).text();
  ok(legacy.includes('<b>block body marker</b>'), 'legacy /html/board aliases the first board html block');
  const missing = await fetch(new URL('/html/b/does-not-exist', url));
  ok(missing.status === 404, '/html/b/<unknown> → 404');
  await post(url, '/api/submit', { answers: { go: 'yes' } });
  await exited;
}

// ---------- 11b. annotate bootstrap injected into a FULL html document ----------
console.log('11b. annotate bootstrap into full document');
{
  const FULL = '<html><head><title>Full</title></head><body><h1>full doc marker</h1></body></html>';
  const FULL_SPEC = {
    title: 'Full doc board',
    blocks: [{ type: 'html', html: FULL }],
    questions: [{ id: 'go', type: 'yesno', label: 'Go?' }],
  };
  const p = path.join(HOME, 'fulldoc-spec.json');
  fs.writeFileSync(p, JSON.stringify(FULL_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const body = await (await fetch(new URL('/html/b/b1', url))).text();
  ok(body.includes('<h1>full doc marker</h1>'), 'full document served verbatim');
  ok(!body.startsWith('<!doctype html><html><head><meta'), 'full document NOT re-wrapped in the fragment shell');
  const bootAt = body.indexOf('relayKit.annotate.auto');
  ok(bootAt !== -1 && bootAt < body.toLowerCase().indexOf('</body>'), 'annotate bootstrap injected before </body> of a full document');
  await post(url, '/api/submit', { answers: { go: 'yes' } });
  await exited;
}

// ---------- 12. annotations round-trip (every target kind) + boot prefill ----------
console.log('12. annotations round-trip');
let annBoardId;
{
  const ANNOTATIONS = [
    {
      id: 'a1', questionId: null, blockId: 'b1',
      target: { kind: 'chart-element', datasetIndex: 0, index: 1, label: 'Q2', value: 42 },
      text: 'spike here', createdAt: new Date().toISOString(),
    },
    {
      id: 'a2', questionId: null, blockId: 'b2',
      target: { kind: 'mermaid-node', nodeId: 'A', text: 'Start' },
      text: 'rename node', createdAt: new Date().toISOString(),
    },
    {
      id: 'a3', questionId: null, blockId: 'b3',
      target: { kind: 'table-cell', row: 0, col: 'B', value: '2' },
      text: 'wrong total', createdAt: new Date().toISOString(),
    },
    {
      id: 'a4', questionId: null, blockId: 'b4',
      target: { kind: 'text', quote: 'Select me', prefix: 'Hello ', suffix: ' please' },
      text: 'reword', createdAt: new Date().toISOString(),
    },
    {
      id: 'a5', questionId: 'pick', blockId: 'pick-b1',
      target: { kind: 'html-element', ref: 'div>button:nth-of-type(2)', label: 'CTA button', detail: '#buy' },
      text: 'make it bigger', createdAt: new Date().toISOString(),
    },
  ];
  const { id, url, exited } = await spawnBlocking(['ask', '-q', '!Pick?::single::a,b', '--no-open', '--timeout', '60']);
  annBoardId = id;
  const res = await post(url, '/api/submit', {
    answers: { q1: 'a' },
    comment: 'with annotations',
    annotations: ANNOTATIONS,
  });
  ok(res.ok, 'submit with annotations accepted');
  const { stdout } = await exited;
  const result = JSON.parse(stdout);
  ok(Array.isArray(result.annotations) && result.annotations.length === 5, 'all 5 annotations round-trip in result');
  const kinds = result.annotations.map((a) => a.target.kind).sort();
  ok(JSON.stringify(kinds) === JSON.stringify(['chart-element', 'html-element', 'mermaid-node', 'table-cell', 'text']), 'every target kind round-trips');
  const chartAnn = result.annotations.find((a) => a.id === 'a1');
  ok(chartAnn.target.value === 42 && chartAnn.target.datasetIndex === 0 && chartAnn.blockId === 'b1', 'chart-element annotation target fields intact');
  const textAnn = result.annotations.find((a) => a.id === 'a4');
  ok(textAnn.target.quote === 'Select me' && textAnn.target.prefix === 'Hello ' && textAnn.target.suffix === ' please', 'text annotation quote/prefix/suffix intact');
  const htmlAnn = result.annotations.find((a) => a.id === 'a5');
  ok(htmlAnn.questionId === 'pick' && htmlAnn.target.detail === '#buy', 'html-element annotation question scope + detail intact');
  ok(htmlAnn.target.ref === 'div>button:nth-of-type(2)', 'html-element annotation stable element ref round-trips');
  // Truncation-proof result: full payload is written to a sidecar file and the
  // path is surfaced (first field) so a shell that caps stdout can't drop data.
  ok(typeof result.resultFile === 'string' && result.resultFile.endsWith(`${id}.result.json`), 'result advertises a resultFile sidecar path');
  ok(Object.keys(result)[0] === 'resultFile', 'resultFile is the FIRST field (survives head-truncation)');
  const fileResult = JSON.parse(fs.readFileSync(result.resultFile, 'utf8'));
  ok(Array.isArray(fileResult.annotations) && fileResult.annotations.length === 5, 'resultFile holds the complete, untruncated annotations');
  ok(fileResult.boardId === id && fileResult.comment === 'with annotations', 'resultFile is the full result payload');
}

// ---------- 13. draft annotations prefill on reload ----------
console.log('13. annotations draft prefill');
{
  const { url, exited } = await spawnBlocking(['ask', '-q', 'Pick?::single::a,b', '--no-open', '--timeout', '60']);
  const draftAnn = [
    {
      id: 'd1', questionId: null, blockId: 'b1',
      target: { kind: 'text', quote: 'draft quote', prefix: '', suffix: '' },
      text: 'draft note text', createdAt: new Date().toISOString(),
    },
  ];
  await post(url, '/api/draft', { answers: { q1: 'a' }, annotations: draftAnn });
  const reloaded = await (await fetch(url)).text();
  ok(reloaded.includes('"annotations":[') && reloaded.includes('draft note text'), 'page boot prefill includes draft annotations on reload');
  ok(reloaded.includes('"prefill":{"answers":{"q1":"a"'), 'boot prefill carries draft answers alongside annotations');
  await post(url, '/api/submit', { answers: { q1: 'a' } });
  await exited;
}

// ---------- 14. annotations validation: cap 500, drop non-string text ----------
console.log('14. annotations validation');
{
  const { id, url, exited } = await spawnBlocking(['ask', '-q', 'Pick?::single::a,b', '--no-open', '--timeout', '60']);
  const mkAnn = (i) => ({
    id: `c${i}`, questionId: null, blockId: 'b1',
    target: { kind: 'text', quote: `q${i}`, prefix: '', suffix: '' },
    text: `comment ${i}`, createdAt: new Date().toISOString(),
  });
  const overCap = Array.from({ length: 501 }, (_, i) => mkAnn(i));
  const submitRes = await post(url, '/api/submit', { answers: { q1: 'a' }, annotations: overCap });
  ok(submitRes.ok, 'submit with 501 annotations accepted');
  const { stdout } = await exited;
  const result = JSON.parse(stdout);
  ok(result.annotations.length === 500, `501 annotations capped to 500 (got ${result.annotations.length})`);
  void id;

  // An entry without a string `text` is dropped (others kept).
  const { url: url2, exited: exited2 } = await spawnBlocking(['ask', '-q', 'Pick?::single::a,b', '--no-open', '--timeout', '60']);
  const mixed = [
    mkAnn(1),
    { id: 'bad', questionId: null, blockId: 'b1', target: { kind: 'text', quote: 'x', prefix: '', suffix: '' }, text: 123 },
    { id: 'bad2', questionId: null, blockId: 'b1', target: { kind: 'text', quote: 'x', prefix: '', suffix: '' } /* no text */ },
    mkAnn(2),
  ];
  await post(url2, '/api/submit', { answers: { q1: 'a' }, annotations: mixed });
  const result2 = JSON.parse((await exited2).stdout);
  ok(result2.annotations.length === 2, `non-string/missing-text entries dropped (kept ${result2.annotations.length} of 4)`);
  ok(result2.annotations.every((a) => typeof a.text === 'string'), 'every surviving annotation has string text');
}

// ---------- 15. rename checks (rly bin / version / help) ----------
console.log('15. rename checks');
{
  ok(fs.existsSync(BIN), 'bin/rly.js exists');
  const ver = await run(['--version']);
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  ok(ver.stdout.trim() === pkgVersion, `--version prints package.json version (${pkgVersion})`);
  const help = await run(['help']);
  ok(/\brly\b/.test(help.stdout), 'help mentions rly');
  ok(/blocks/i.test(help.stdout), 'help mentions blocks');
  void annBoardId;
}

// ---------- 16. diagram blocks: graphviz + plantuml normalize; required-field & bad-server errors ----------
console.log('16. diagram blocks normalization');
{
  const DIAGRAM_SPEC = {
    title: 'Diagram board',
    blocks: [
      { type: 'graphviz', dot: 'digraph { a -> b }', height: 300 },
      { type: 'plantuml', code: '@startuml\nA -> B\n@enduml' },
      { type: 'plantuml', code: '@startuml\nC -> D\n@enduml', server: 'https://plantuml.example.com/plantuml' },
    ],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const diagPath = path.join(HOME, 'diagram-spec.json');
  fs.writeFileSync(diagPath, JSON.stringify(DIAGRAM_SPEC));

  const { url, exited } = await spawnBlocking(['ask', '--file', diagPath, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  const bb = board.spec.blocks;
  ok(bb.length === 3 && bb.map((b) => b.id).join(',') === 'b1,b2,b3', 'diagram board block ids are b1..b3');
  const gv = bb[0];
  ok(gv.type === 'graphviz' && gv.dot === 'digraph { a -> b }' && gv.height === 300, 'graphviz block normalizes (dot + height intact)');
  const pu1 = bb[1];
  ok(pu1.type === 'plantuml' && pu1.code.includes('@startuml') && pu1.server === undefined, 'plantuml block without server normalizes (server omitted)');
  const pu2 = bb[2];
  ok(pu2.type === 'plantuml' && pu2.server === 'https://plantuml.example.com/plantuml', 'plantuml block keeps a valid http(s) server URL');
  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;

  // graphviz missing/empty dot → exit 4, error references blocks[<i>].
  const badGv = await run(['ask', '--file', '-'], {
    input: JSON.stringify({ title: 'x', blocks: [{ type: 'graphviz', dot: '   ' }] }),
  });
  ok(badGv.code === 4, 'graphviz block with empty dot → exit 4');
  ok(/blocks\[/.test(badGv.stderr) && /dot/.test(badGv.stderr), 'graphviz error references blocks[<i>] and "dot"');

  // plantuml missing code → exit 4, error references blocks[<i>].
  const badPu = await run(['ask', '--file', '-'], {
    input: JSON.stringify({ title: 'x', blocks: [{ type: 'plantuml', code: '' }] }),
  });
  ok(badPu.code === 4, 'plantuml block with empty code → exit 4');
  ok(/blocks\[/.test(badPu.stderr) && /code/.test(badPu.stderr), 'plantuml error references blocks[<i>] and "code"');

  // plantuml with a non-http(s) server → exit 4, error references blocks[<i>].
  const badServer = await run(['ask', '--file', '-'], {
    input: JSON.stringify({ title: 'x', blocks: [{ type: 'plantuml', code: '@startuml\nA->B\n@enduml', server: 'ftp://nope' }] }),
  });
  ok(badServer.code === 4, 'plantuml block with non-http(s) server → exit 4');
  ok(/blocks\[/.test(badServer.stderr) && /server/.test(badServer.stderr), 'plantuml bad-server error references blocks[<i>] and "server"');
}

// ---------- 17. /vendor/viz-standalone.js serving + boot.vendor.viz for a graphviz board ----------
console.log('17. viz vendor + boot.vendor.viz');
{
  const VENDOR_DIR = path.join(ROOT, 'vendor');
  const vizPresent = fs.existsSync(path.join(VENDOR_DIR, 'viz-standalone.js'));
  const VIZ_SPEC = {
    title: 'Viz board',
    blocks: [{ type: 'graphviz', dot: 'digraph { x -> y }' }],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'viz-spec.json');
  fs.writeFileSync(p, JSON.stringify(VIZ_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);

  const page = await (await fetch(url)).text();
  if (vizPresent) {
    const res = await fetch(new URL('/vendor/viz-standalone.js', url));
    const body = await res.text();
    const ct = res.headers.get('content-type') || '';
    const trimmed = body.trim();
    ok(res.status === 200, 'GET /vendor/viz-standalone.js → 200');
    ok(/javascript/.test(ct), 'viz vendor file served with a JS content-type');
    ok(trimmed.length > 0 && !(trimmed.startsWith('{') && /"error"/.test(trimmed)), 'viz vendor body looks like JS (not a JSON error / empty)');
    ok(page.includes('"viz":true'), 'boot.vendor.viz true for a graphviz board (vendor present)');
  } else {
    const res = await fetch(new URL('/vendor/viz-standalone.js', url));
    ok(res.status === 404, 'GET /vendor/viz-standalone.js → 404 while not yet vendored (route degrades cleanly)');
    ok(page.includes('"viz":false'), 'boot.vendor.viz false when the asset is absent');
    console.log('    (note: vendor/viz-standalone.js not present yet — 200 assertion deferred to vendor agent)');
  }
  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;
}

// ---------- 18. threaded annotation replies round-trip through submit ----------
console.log('18. annotation replies round-trip');
{
  const { url, exited } = await spawnBlocking(['ask', '-q', 'Pick?::single::a,b', '--no-open', '--timeout', '60']);
  const now = new Date().toISOString();
  const replies51 = Array.from({ length: 51 }, (_, i) => ({ author: 'agent', text: `r${i}`, createdAt: now }));
  const ANNS = [
    {
      id: 'a1', questionId: null, blockId: 'b1', author: 'agent',
      target: { kind: 'text', quote: 'q', prefix: '', suffix: '' },
      text: 'agent-authored comment', createdAt: now,
      replies: [
        { author: 'user', text: 'a user reply', createdAt: now },
        { author: 'agent', text: 'an agent reply', createdAt: now },
        // invalid entries that must be dropped:
        { author: 'user', text: 12345, createdAt: now },          // non-string text
        { author: 'user', createdAt: now },                        // missing text
        'not an object',                                           // not an object
        { author: 'user', text: 'x'.repeat(5001), createdAt: now },// text over 5000
      ],
    },
    {
      id: 'a2', questionId: null, blockId: 'b1',
      target: { kind: 'text', quote: 'q2', prefix: '', suffix: '' },
      text: 'capped thread', createdAt: now,
      replies: replies51,
    },
  ];
  const res = await post(url, '/api/submit', { answers: { q1: 'a' }, annotations: ANNS });
  ok(res.ok, 'submit with threaded replies accepted');
  const result = JSON.parse((await exited).stdout);
  ok(result.annotations.length === 2, 'both annotations round-trip with replies');

  const a1 = result.annotations.find((a) => a.id === 'a1');
  ok(a1.author === 'agent', 'annotation author "agent" round-trips');
  ok(Array.isArray(a1.replies) && a1.replies.length === 2, `invalid reply entries dropped (kept ${a1.replies?.length} of 6)`);
  ok(a1.replies[0].author === 'user' && a1.replies[0].text === 'a user reply', 'first surviving reply intact (author + text)');
  ok(a1.replies[1].author === 'agent' && a1.replies[1].text === 'an agent reply', 'agent reply intact');
  ok(a1.replies.every((r) => typeof r.text === 'string' && r.text.length <= 5000), 'every surviving reply has a valid string text');

  const a2 = result.annotations.find((a) => a.id === 'a2');
  ok(a2.replies.length === 50, `51 replies capped to 50 (got ${a2.replies.length})`);
  ok(a2.replies.every((r) => r.author === 'agent'), 'capped replies keep their author');
}

// ---------- 19. /api/update + /api/status rev + boot.rev ----------
console.log('19. live update');
let updateId;
{
  const RUNNING_DIR = path.join(HOME, 'running');
  const { id, url, exited } = await spawnBlocking(['ask', '-q', 'Keep?::yesno', '--title', 'Before', '--no-open', '--timeout', '60']);
  updateId = id;

  // boot.rev + /api/status start at 1.
  const page0 = await (await fetch(url)).text();
  ok(page0.includes('"rev":1'), 'boot JSON carries rev:1 on first load');
  const status0 = await (await fetch(new URL('/api/status', url))).json();
  ok(status0.status === 'open' && status0.rev === 1, 'GET /api/status returns {status:"open", rev:1}');

  // Read the token from the running file (token lives ONLY there, never the page).
  ok(!page0.includes(`"token"`), 'token is NOT embedded in the page boot JSON');
  const running = JSON.parse(fs.readFileSync(path.join(RUNNING_DIR, `${id}.json`), 'utf8'));
  ok(typeof running.token === 'string' && /^[0-9a-f]{32}$/.test(running.token), 'running file carries a 32-hex mutation token');

  // POST /api/update WITHOUT the token → 403, no rev bump.
  const newSpec = {
    title: 'After update',
    intro: 'now with more questions',
    blocks: [],
    questions: [
      { id: 'keep', type: 'yesno', label: 'Keep?' },
      { id: 'extra', type: 'text', label: 'Anything to add?' },
    ],
    allowPartial: true, note: true, autoClose: true, submitLabel: 'Submit',
  };
  const noTok = await post(url, '/api/update', { spec: newSpec });
  ok(noTok.status === 403, 'POST /api/update without token → 403');
  const afterNoTok = await (await fetch(new URL('/api/status', url))).json();
  ok(afterNoTok.rev === 1, 'rejected update did not bump rev');

  // POST /api/update WITH the token → rev bumps, spec changes.
  const withTok = await fetch(new URL('/api/update', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-token': running.token },
    body: JSON.stringify({ spec: newSpec }),
  });
  ok(withTok.status === 200, 'POST /api/update with token → 200');
  const upBody = await withTok.json();
  ok(upBody.ok === true && upBody.rev === 2, 'update response {ok:true, rev:2}');
  const status1 = await (await fetch(new URL('/api/status', url))).json();
  ok(status1.rev === 2, '/api/status reflects bumped rev after update');
  const board1 = await (await fetch(new URL('/api/board', url))).json();
  ok(board1.spec.title === 'After update' && board1.spec.questions.length === 2, 'served spec reflects the update (new title + extra question)');
  const page1 = await (await fetch(url)).text();
  ok(page1.includes('"rev":2') && page1.includes('After update'), 'page reload serves the updated spec + bumped rev');

  // Reject a malformed spec (no questions[]/blocks[]) even with the token.
  const badUp = await fetch(new URL('/api/update', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-token': running.token },
    body: JSON.stringify({ spec: { title: 'broken' } }),
  });
  ok(badUp.status === 400, 'malformed spec (missing questions[]/blocks[]) → 400');
  const status2 = await (await fetch(new URL('/api/status', url))).json();
  ok(status2.rev === 2, 'rejected malformed update did not bump rev');

  // Reject render-invalid content before publishing it to the visible board.
  const badMermaidUp = await fetch(new URL('/api/update', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-token': running.token },
    body: JSON.stringify({ spec: { ...newSpec, blocks: [{ id: 'b1', type: 'mermaid', code: 'graph TD; A-->' }] } }),
  });
  const badMermaidBody = await badMermaidUp.json();
  ok(badMermaidUp.status === 400 && /invalid mermaid syntax/.test(badMermaidBody.error || ''), 'invalid mermaid update → 400 before board rev changes');
  const status3 = await (await fetch(new URL('/api/status', url))).json();
  ok(status3.rev === 2, 'rejected invalid-mermaid update did not bump rev');

  await post(url, '/api/submit', { answers: { keep: 'yes' } });
  await exited;
}

// ---------- 20. rly update CLI ----------
console.log('20. rly update CLI');
{
  // A running board to update via the CLI (detached so the test process stays free).
  const r = await run(['ask', '-q', 'Go?::yesno', '--title', 'CLI before', '--detach', '--no-open', '--timeout', '60']);
  ok(r.code === 0, 'detached board for CLI update started');
  const info = JSON.parse(r.stdout);
  const cliId = info.boardId;

  const upd = await run(['update', cliId, '--intro', 'updated via CLI']);
  ok(upd.code === 0, 'rly update --intro exits 0');
  const updJson = JSON.parse(upd.stdout);
  ok(updJson.status === 'updated' && updJson.boardId === cliId, 'rly update prints {status:"updated", boardId}');
  ok(typeof updJson.rev === 'number' && updJson.rev >= 2 && /^http:/.test(updJson.url), 'rly update result carries bumped rev + url');
  const board = await (await fetch(new URL('/api/board', info.url))).json();
  ok(board.spec.intro === 'updated via CLI', 'CLI --intro patch reflected in the served spec');

  // Not-running id → exit 5.
  const notRunning = await run(['update', 'b-doesnotexist', '--intro', 'x']);
  ok(notRunning.code === 5, 'rly update on a non-existent/not-running board → exit 5');

  await post(info.url, '/api/submit', { answers: { q1: 'yes' } });
  await run(['stop', cliId]);
}

// ---------- 21. reopen --replies appends agent replies into prefill ----------
console.log('21. reopen --replies');
{
  // Run + submit a board with a user annotation so a result (with annotations)
  // exists to reopen as a conversation.
  const { id, url, exited } = await spawnBlocking(['ask', '-q', 'Pick?::single::a,b', '--no-open', '--timeout', '60']);
  const now = new Date().toISOString();
  await post(url, '/api/submit', {
    answers: { q1: 'a' },
    annotations: [
      {
        id: 'u1', questionId: null, blockId: 'b1', author: 'user',
        target: { kind: 'text', quote: 'element', prefix: '', suffix: '' },
        text: 'please rename this', createdAt: now,
      },
    ],
  });
  const submitted = JSON.parse((await exited).stdout);
  ok(Array.isArray(submitted.annotations) && submitted.annotations.some((a) => a.id === 'u1'), 'user annotation persisted in the submitted result');

  // Bad annotationId → exit 4, listing the valid ids. (Run BEFORE the good case
  // so the result's annotations still include u1 — a plain re-submit would wipe
  // them.) reopen with a non-running board falls through to runOrDetach, so
  // --detach to avoid blocking, then stop it.
  const badReplies = path.join(HOME, 'bad-replies.json');
  fs.writeFileSync(badReplies, JSON.stringify([{ annotationId: 'nope', text: 'orphan reply' }]));
  const badRe = await run(['reopen', id, '--replies', badReplies, '--detach', '--no-open', '--timeout', '30']);
  ok(badRe.code === 4, 'reopen --replies with an unknown annotationId → exit 4');
  ok(/unknown annotationId/.test(badRe.stderr) && /u1/.test(badRe.stderr), 'unknown-id error lists the valid annotation ids (u1)');

  // Good --replies file → agent reply seeded into the draft annotation, visible
  // in the reopened page's boot prefill.
  const repliesPath = path.join(HOME, 'replies.json');
  fs.writeFileSync(repliesPath, JSON.stringify([{ annotationId: 'u1', text: 'renamed it, thanks!' }]));
  const re = await spawnBlocking(['reopen', id, '--replies', repliesPath, '--no-open', '--timeout', '60']);
  const page = await (await fetch(re.url)).text();
  ok(page.includes('"annotations":[') && page.includes('renamed it, thanks!'), 'reopen --replies seeds the agent reply into boot prefill');
  ok(page.includes('"author":"agent"'), 'seeded reply is authored "agent" in prefill');
  ok(page.includes('please rename this'), 'original user comment preserved alongside the agent reply');
  await post(re.url, '/api/submit', { answers: { q1: 'a' } });
  await re.exited;
}

// ---------- 16. v0.4: presence / blockEdits / push-wake / while-active ----------
console.log('16. presence, blockEdits, push-wake, while-active');
{
  const onResultFile = path.join(HOME, 'onresult.json');
  const v4spec = path.join(HOME, 'v4.json');
  fs.writeFileSync(v4spec, JSON.stringify({
    title: 'v4',
    blocks: [{ type: 'mermaid', code: 'graph TD; A-->B', editable: true }],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  }));
  const r = await run(['ask', '--file', v4spec, '--detach', '--no-open', '--timeout', '60', '--on-result', `cat > ${onResultFile}`]);
  const info = JSON.parse(r.stdout);
  const { boardId, url } = info;

  // while-active on a NEVER-pinged board must still time out promptly.
  // (Run this FIRST: any /api/ping below would count as recent activity.)
  const idleWait = await run(['wait', boardId, '--timeout', '3', '--while-active', '--idle-grace', '60']);
  ok(idleWait.code === 2 && JSON.parse(idleWait.stdout).status === 'wait-timeout', 'while-active on an idle board still times out (exit 2)');

  // presence lifecycle
  const p0 = await (await fetch(new URL('/api/presence', url))).json();
  ok(p0.open === true && p0.seen === false, 'presence before any ping → seen:false');
  await post(url, '/api/ping', { visible: true, focused: true, idleMs: 1000 });
  const p1 = await (await fetch(new URL('/api/presence', url))).json();
  ok(p1.seen === true && p1.visible === true && p1.secondsSinceActivity <= 3, 'presence after ping → seen:true with sane activity');
  const peek = JSON.parse((await run(['result', boardId])).stdout);
  ok(peek.status === 'open' && peek.presence?.seen === true, 'rly result includes presence on an open board');

  // editable mermaid normalize + blockEdits draft round-trip
  const board = await (await fetch(new URL('/api/board', url))).json();
  ok(board.spec.blocks[0].editable === true, 'editable flag survives normalization');
  await post(url, '/api/draft', { answers: {}, blockEdits: { b1: 'graph TD; X-->Y' } });
  const reloaded = await (await fetch(url)).text();
  ok(reloaded.includes('"blockEdits":{"b1":"graph TD; X--&gt;Y"}') || reloaded.includes('"blockEdits":{"b1":"graph TD; X-->Y"}'), 'draft blockEdits prefill on reload');

  // while-active: activity extends the wait past its timeout
  const waitP = run(['wait', boardId, '--timeout', '3', '--while-active', '--idle-grace', '60']);
  await sleep(1000);
  await post(url, '/api/ping', { visible: true, focused: true, idleMs: 200 });
  await sleep(2500);
  await post(url, '/api/ping', { visible: true, focused: true, idleMs: 200 });
  await sleep(1500);
  await post(url, '/api/submit', { answers: { ok: 'yes' }, blockEdits: { b1: 'graph TD; X-->Y' } });
  const w = await waitP;
  const wr = JSON.parse(w.stdout);
  ok(w.code === 0 && wr.status === 'submitted', 'while-active extends past timeout while the user is active');
  ok(wr.blockEdits?.b1 === 'graph TD; X-->Y', 'edited mermaid source returned in result.blockEdits');

  // push-wake: --on-result received the result JSON on stdin
  await sleep(1500);
  const piped = JSON.parse(fs.readFileSync(onResultFile, 'utf8'));
  ok(piped.status === 'submitted' && piped.boardId === boardId, '--on-result command received the result JSON on stdin');
}

// ---------- 17. skill frontmatter portability guard ----------
// Codex (and other strict-YAML agents) silently DROP a skill whose
// description is an unquoted scalar containing ": " or exceeds the
// agent-skills spec cap of 1024 chars. Claude Code is lenient, so only this
// guard catches it before publish.
console.log('17. skill frontmatter portability');
{
  const skillMd = fs.readFileSync(path.join(ROOT, 'skills', 'relay', 'SKILL.md'), 'utf8');
  const m = skillMd.match(/^description: (.*)$/m);
  ok(Boolean(m), 'SKILL.md has a description line');
  const line = m[1].trim();
  ok(line.startsWith('"') && line.endsWith('"'), 'description is double-quoted (strict-YAML safe)');
  const inner = line.slice(1, -1);
  ok(!inner.includes('"'), 'description has no unescaped inner double quotes');
  ok(inner.length <= 1024, `description within the 1024-char agent-skills cap (${inner.length})`);

  // `rly skill rules` prints the always-read instruction block for CLAUDE.md /
  // AGENTS.md (the enforcement layer above the ignorable skill hint).
  const rules = await run(['skill', 'rules']);
  ok(rules.code === 0 && rules.stdout.startsWith('## relay'), 'rly skill rules prints a markdown rules block');
  ok(/rly ask --file spec\.json --detach/.test(rules.stdout) && /options\[\]\.blocks/.test(rules.stdout), 'rules cover the detach pattern and visual options');

  // `rly install` — multi-agent instruction injection. Read-only paths only
  // (list + print + error); real writes target the user's home/cwd, so those
  // are exercised out-of-band, not against the shared test environment.
  const list = await run(['install']);
  ok(list.code === 0, 'rly install (no args) exits 0');
  const matrix = JSON.parse(list.stdout);
  const ids = matrix.agents.map((a) => a.agent);
  ok(['claude', 'cursor', 'copilot', 'kiro', 'windsurf', 'cline', 'gemini', 'codex'].every((x) => ids.includes(x)), 'install matrix lists the major agents');
  const printed = await run(['install', '--target', 'cursor', '--print']);
  ok(printed.code === 0 && /\.cursor\/rules\/relay\.mdc/.test(printed.stdout) && /alwaysApply: true/.test(printed.stdout), 'install --print emits Cursor .mdc with frontmatter + path');
  const sharedPrint = await run(['install', '--target', 'gemini', '--print']);
  ok(/relay:begin/.test(sharedPrint.stdout) && /relay:end/.test(sharedPrint.stdout), 'install --print wraps shared-file agents in relay markers');
  const bogus = await run(['install', '--target', 'nope']);
  ok(bogus.code === 4, 'install --target <unknown> exits 4');
}

// ---------- 18. option-level blocks + image block ----------
console.log('18. option blocks & image block');
{
  // 1x1 red-pixel PNG, written to disk to exercise the local-file embed path.
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngPath = path.join(HOME, 'opt.png');
  fs.writeFileSync(pngPath, Buffer.from(pngB64, 'base64'));
  const OPT_SPEC = {
    title: 'Visual options',
    blocks: [{ type: 'image', src: 'https://example.com/remote.png', alt: 'remote' }],
    questions: [
      {
        id: 'pick', type: 'single', label: 'Pick a variant',
        options: [
          { value: 'a', label: 'A', blocks: [
            { type: 'image', src: pngPath, alt: 'variant A', height: 140 },
            { type: 'html', html: '<b>opt html</b>', height: 140 },
          ] },
          { value: 'b', label: 'B', blocks: [
            { type: 'chart', kind: 'bar', labels: ['x'], series: [{ label: 's', data: [1] }], height: 140 },
          ] },
          'c',
        ],
      },
    ],
  };
  const optSpecPath = path.join(HOME, 'opt-spec.json');
  fs.writeFileSync(optSpecPath, JSON.stringify(OPT_SPEC));

  const { url, exited } = await spawnBlocking(['ask', '--file', optSpecPath, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  const opts = board.spec.questions[0].options;
  ok(opts[0].blocks.map((b) => b.id).join(',') === 'pick-o1-b1,pick-o1-b2', 'option block ids are <qid>-o<n>-b<m>');
  ok(opts[0].blocks[0].type === 'image' && opts[0].blocks[0].src.startsWith('data:image/png;base64,'), 'local image file embedded as data URI');
  ok(opts[1].blocks[0].type === 'chart' && opts[1].blocks[0].height === 140, 'option chart block normalized');
  ok(opts[2].value === 'c' && !('blocks' in opts[2]), 'plain string option stays block-free');
  ok(board.spec.blocks[0].src === 'https://example.com/remote.png', 'remote image src passes through unembedded');

  // Page payload: bodies stripped, metadata + vendor flags kept.
  const page = await (await fetch(url)).text();
  ok(!page.includes('opt html'), 'option html body is NOT inline in the page');
  ok(!page.includes(pngB64), 'embedded image bytes are NOT inline in the page');
  ok(page.includes('"hasData":true'), 'embedded image block ships hasData flag');
  if (fs.existsSync(path.join(ROOT, 'vendor', 'chart.umd.js'))) {
    ok(/"vendor":\{"chart":true/.test(page), 'option-level chart block triggers the chart vendor flag');
  }

  // Serving endpoints reach option scope.
  const oh = await (await fetch(new URL('/html/b/pick-o1-b2', url))).text();
  ok(oh.includes('<b>opt html</b>'), 'option html block served at /html/b/<id>');
  const ir = await fetch(new URL('/img/b/pick-o1-b1', url));
  ok(ir.status === 200 && (ir.headers.get('content-type') || '').includes('image/png'), '/img/b/<id> serves the embedded image with its mime');
  ok(Buffer.from(await ir.arrayBuffer()).equals(Buffer.from(pngB64, 'base64')), 'embedded image bytes round-trip exactly');
  ok((await fetch(new URL('/img/b/nope', url))).status === 404, '/img/b/<unknown> → 404');

  await post(url, '/api/submit', { answers: { pick: 'a' } });
  await exited;

  // Validation errors.
  const noSrc = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'image' }] }) });
  ok(noSrc.code === 4 && /image block needs a "src"/.test(noSrc.stderr), 'image without src → exit 4');
  const badExt = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'image', src: 'x.tiff' }] }) });
  ok(badExt.code === 4 && /unsupported image extension/.test(badExt.stderr), 'unsupported image extension → exit 4');
  const badOptBlock = await run(['ask', '--file', '-'], {
    input: JSON.stringify({ title: 'x', questions: [{ id: 'q', type: 'single', label: 'q', options: [{ value: 'a', blocks: [{ type: 'nope' }] }] }] }),
  });
  ok(badOptBlock.code === 4 && /options\[0\]\.blocks\[0\]/.test(badOptBlock.stderr), 'invalid option block error references options[<j>].blocks[<i>]');
}

// ---------- 22. single-question note defaults on; opt-out + round-trip ----------
console.log('22. single-question note default');
{
  const NOTE_SPEC = {
    title: 'Note defaults',
    questions: [
      { id: 'radio', type: 'single', label: 'Pick', options: ['a', 'b'] },           // note defaults true
      { id: 'radioOff', type: 'single', label: 'Pick2', options: ['a', 'b'], note: false }, // explicit off
      { id: 'multi', type: 'multi', label: 'Many', options: ['x', 'y'] },             // stays false
      { id: 'free', type: 'text', label: 'Free', note: true },                        // explicit on
    ],
  };
  const p = path.join(HOME, 'note-spec.json');
  fs.writeFileSync(p, JSON.stringify(NOTE_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  const byId = Object.fromEntries(board.spec.questions.map((q) => [q.id, q]));
  ok(byId.radio.note === true, 'single (radio) question defaults to note:true');
  ok(byId.radioOff.note === false, 'single question honors explicit note:false');
  ok(byId.multi.note === false, 'non-single question (multi) stays note:false by default');
  ok(byId.free.note === true, 'explicit note:true still works on other types');

  // The radio's note round-trips through submit into result.notes[qid].
  const res = await post(url, '/api/submit', {
    answers: { radio: 'a' },
    notes: { radio: 'picked a because it ships sooner' },
  });
  ok(res.ok, 'submit with a single-question note accepted');
  const result = JSON.parse((await exited).stdout);
  ok(result.notes?.radio === 'picked a because it ships sooner', 'single-question note round-trips in result.notes');
}

// ---------- 23. POST /api/open: allowlist + same-origin guard + happy path ----------
console.log('23. file-link open endpoint');
{
  const realFile = path.join(HOME, 'open-me.txt');
  fs.writeFileSync(realFile, 'hello');
  const missingFile = path.join(HOME, 'gone.txt'); // referenced but does NOT exist
  const OPEN_SPEC = {
    title: 'Open board',
    // both paths are referenced in markdown → both are allowlisted
    intro: `See [the file](${realFile}) and \`${missingFile}\`.`,
    blocks: [{ type: 'markdown', md: `Open ${realFile}` }],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'open-spec.json');
  fs.writeFileSync(p, JSON.stringify(OPEN_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);

  // missing path → 400
  const noPath = await post(url, '/api/open', {});
  ok(noPath.status === 400, 'POST /api/open with no path → 400');

  // a path NOT referenced on the board → 403 (allowlist)
  const notRef = await post(url, '/api/open', { path: '/etc/hostname' });
  ok(notRef.status === 403, 'POST /api/open with an unreferenced path → 403 (allowlist)');

  // a referenced path that does not exist → 404
  const missing = await post(url, '/api/open', { path: missingFile });
  ok(missing.status === 404, 'POST /api/open with a referenced-but-missing file → 404');

  // a cross-site Origin → 403 even for a referenced path
  const foreign = await fetch(new URL('/api/open', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ path: realFile }),
  });
  ok(foreign.status === 403, 'POST /api/open from a foreign Origin → 403');

  // referenced + exists + same-origin → 200, and the opener saw the path
  const okRes = await post(url, '/api/open', { path: realFile });
  const okBody = await okRes.json();
  ok(okRes.status === 200 && okBody.ok === true && okBody.name === 'open-me.txt', 'POST /api/open opens a referenced, existing file → 200');
  // the opener is a detached grandchild — poll briefly for its log line
  let log = '';
  for (let i = 0; i < 30 && !log.includes(realFile); i++) {
    await sleep(100);
    log = fs.existsSync(OPEN_LOG) ? fs.readFileSync(OPEN_LOG, 'utf8') : '';
  }
  ok(log.includes(realFile), 'the OS opener was invoked with the resolved file path');

  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;
}

// ---------- 23b. same-Wi-Fi share activation + permissions ----------
console.log('23b. share activation permissions');
{
  const shareSpec = path.join(HOME, 'share-permissions.json');
  fs.writeFileSync(shareSpec, JSON.stringify({
    title: 'Share permissions',
    blocks: [{ type: 'html', html: '<button id="shared-html-control">Shared HTML</button>' }],
    questions: [{ id: 'q1', type: 'yesno', label: 'Ship?' }],
  }));
  const { id, url, exited } = await spawnBlocking(['ask', '--file', shareSpec, '--no-open', '--timeout', '60']);
  const ownerPage = await (await fetch(url)).text();
  ok(ownerPage.includes('share-btn icon-btn') && ownerPage.includes('Share board'), 'owner page bundles the topbar icon share control');
  ok(ownerPage.includes('banner-stack') && ownerPage.includes('banner-item'), 'board page bundles stacked topbar notices');
  ok(!ownerPage.includes('window.confirm'), 'share activation works without a browser confirmation dialog');
  const remoteLocked = await requestViaHost(url, '/api/board');
  ok(remoteLocked.status === 403, 'remote board API without an activated share token → 403');
  const lockedPage = await requestViaHost(url, '/');
  ok(lockedPage.status === 200 && /Share link not active/.test(lockedPage.body), 'remote page without an activated share token shows the locked page');
  const emptyShares = await run(['share', id]);
  const emptyBody = JSON.parse(emptyShares.stdout);
  ok(emptyShares.code === 0 && emptyBody.roles.review.active === false && emptyBody.roles.collab.active === false && emptyBody.roles.read.active === false, 'rly share <id> lists inactive collab/review/read roles');

  // Seed an owner draft. Reviewer input must never overwrite it.
  await post(url, '/api/draft', {
    answers: { q1: 'no' },
    annotations: [{ id: 'a1', blockId: null, questionId: null, target: { kind: 'html-element', label: 'Title' }, text: 'owner note' }],
  });

  const reviewShare = await run(['share', id, '--role', 'review']);
  const reviewBody = JSON.parse(reviewShare.stdout);
  ok(reviewShare.code === 0 && reviewBody.url.includes(`http://${TEST_SHARE_HOST}:`), 'agent can activate a reviewer share link on the LAN host');
  const reviewUrl = new URL(reviewBody.url);
  const reviewToken = reviewUrl.searchParams.get('token');
  const reviewPage = await requestViaHost(url, reviewUrl.pathname + reviewUrl.search, { token: reviewToken });
  const reviewCookie = String(reviewPage.headers['set-cookie']?.[0] || '').split(';')[0];
  ok(reviewPage.status === 200 && reviewPage.body.includes('"role":"review"') && reviewPage.body.includes('"canSubmit":true') && reviewPage.body.includes('"canEditBlocks":false') && reviewPage.body.includes('"canFinalize":false'), 'review link boots with answer/comment/side-submit permission but cannot edit blocks or finalize');
  ok(reviewCookie.startsWith('relay_review_session='), 'review link receives an isolated per-browser review session');
  const reviewHtml = await requestViaHost(url, '/html/b/b1?token=' + encodeURIComponent(reviewToken));
  ok(reviewHtml.status === 200 && reviewHtml.body.includes('relayKit.annotate.auto()'), 'reviewer custom-HTML iframe keeps comment affordances');
  const reviewDraft = await requestViaHost(url, '/api/draft', {
    method: 'POST',
    token: reviewToken,
    cookie: reviewCookie,
    body: {
      answers: { q1: 'yes' },
      annotations: [{ id: 'a2', blockId: null, questionId: null, target: { kind: 'html-element', label: 'Title' }, text: 'review note' }],
      blockEdits: { b1: '<button>reviewer rewrite</button>' },
    },
  });
  ok(reviewDraft.status === 200 && reviewDraft.json?.draftRev === 1, 'reviewer answers/comments autosave into an isolated side-review draft');
  const draft = await (await fetch(new URL('/api/draft', url))).json();
  ok(draft.draft.answers.q1 === 'no' && draft.draft.annotations[0].text === 'owner note', 'reviewer draft does not overwrite the owner answer/comments');
  const reviewerDraftRead = await requestViaHost(url, '/api/draft', { token: reviewToken, cookie: reviewCookie });
  ok(reviewerDraftRead.json?.draft?.answers?.q1 === 'yes' && reviewerDraftRead.json?.draft?.annotations?.[0]?.text === 'review note', 'reviewer reload reads only its own side-review draft');
  ok(Object.keys(reviewerDraftRead.json?.draft?.blockEdits || {}).length === 0, 'reviewer side drafts discard block edits outside the answer/comment role');
  const reviewBoardRead = await requestViaHost(url, '/api/board', { token: reviewToken, cookie: reviewCookie });
  ok(reviewBoardRead.json?.draft?.answers?.q1 === 'yes', 'reviewer board API never exposes the owner draft as its editable state');
  await requestViaHost(url, '/api/ping', {
    method: 'POST', token: reviewToken, cookie: reviewCookie,
    body: { visible: true, focused: true, idleMs: 0 },
  });
  const reviewerPresence = await (await fetch(new URL('/api/presence', url))).json();
  ok(reviewerPresence.seen === false, 'reviewer activity does not count as final-answer presence');

  const reviewSubmit = await requestViaHost(url, '/api/submit', {
    method: 'POST',
    token: reviewToken,
    cookie: reviewCookie,
    body: { answers: { q1: 'yes' }, comment: 'side answer', annotations: reviewerDraftRead.json.draft.annotations, blockEdits: { b1: 'ignored' } },
  });
  ok(reviewSubmit.status === 200 && reviewSubmit.json?.sideReview === true && reviewSubmit.json?.final === false, 'reviewer submit is accepted explicitly as non-final side review');
  const stillOpen = await (await fetch(new URL('/api/status', url))).json();
  ok(stillOpen.status === 'open', 'side-review submit leaves the owner board open');
  const sideWait = await run(['wait', id, '--timeout', '1']);
  ok(sideWait.code === 2 && JSON.parse(sideWait.stdout).status === 'wait-timeout', 'side-review submit does not complete rly wait or proactively notify the agent');
  const peek = await run(['result', id]);
  const peekBody = JSON.parse(peek.stdout);
  ok(peekBody.status === 'open' && peekBody.sideReviews.referenceOnly === true && peekBody.sideReviews.submissions[0].answers.q1 === 'yes', 'rly result exposes reference-only side reviews on demand while still open');
  ok(Object.keys(peekBody.sideReviews.submissions[0].blockEdits || {}).length === 0, 'submitted side reviews discard block edits outside the answer/comment role');
  ok(peekBody.draft.answers.q1 === 'no', 'rly result keeps owner draft separate from side reviews');

  // A new browser/session gets its own review draft instead of clobbering the
  // first reviewer's submitted response.
  const secondSession = 'rv-test-second-session';
  const secondDraft = await requestViaHost(url, '/api/draft', {
    method: 'POST', token: reviewToken, reviewSession: secondSession,
    body: { answers: { q1: 'no' }, comment: 'second reviewer' },
  });
  ok(secondDraft.status === 200 && secondDraft.json?.draftRev === 1, 'multiple reviewer sessions keep independent side-review drafts');

  const readShare = await run(['share', id, '--role', 'read']);
  const readBody = JSON.parse(readShare.stdout);
  const readUrl = new URL(readBody.url);
  const readToken = readUrl.searchParams.get('token');
  const readPage = await requestViaHost(url, readUrl.pathname + readUrl.search, { token: readToken });
  ok(readPage.status === 200 && readPage.body.includes('"role":"read"') && readPage.body.includes('"canComment":false') && readPage.body.includes('"canEditBlocks":false'), 'read-only link boots with all feedback/edit permissions disabled');
  const readHtml = await requestViaHost(url, '/html/b/b1?token=' + encodeURIComponent(readToken));
  ok(readHtml.status === 200 && !readHtml.body.includes('relayKit.annotate.auto()'), 'read-only custom-HTML iframe has no comment affordances');
  const readDraft = await requestViaHost(url, '/api/draft', { method: 'POST', token: readToken, body: { answers: { q1: 'yes' } } });
  const readSubmit = await requestViaHost(url, '/api/submit', { method: 'POST', token: readToken, body: { answers: { q1: 'yes' } } });
  const readOpen = await requestViaHost(url, '/api/open', { method: 'POST', token: readToken, body: { path: '/tmp/nope' }, origin: `http://${TEST_SHARE_HOST}:${new URL(url).port}` });
  ok(readDraft.status === 403 && readSubmit.status === 403 && readOpen.status === 403, 'read-only share cannot autosave, submit, or open local files');

  const revokedReview = await run(['share', id, '--role', 'review', '--revoke']);
  ok(revokedReview.code === 0 && JSON.parse(revokedReview.stdout).status === 'revoked', 'agent can revoke a reviewer share link');
  const oldReview = await requestViaHost(url, '/api/draft', { method: 'POST', token: reviewToken, body: { annotations: [] } });
  ok(oldReview.status === 403, 'revoked reviewer token stops working');

  const collabShare = await run(['share', id, '--role', 'collab']);
  const collabBody = JSON.parse(collabShare.stdout);
  const collabUrl = new URL(collabBody.url);
  const collabToken = collabUrl.searchParams.get('token');
  const collabPage = await requestViaHost(url, collabUrl.pathname + collabUrl.search, { token: collabToken });
  ok(collabPage.status === 200 && collabPage.body.includes('"role":"collab"') && collabPage.body.includes('"canSubmit":true') && collabPage.body.includes('"canFinalize":true'), 'collaborator link retains owner-authorized final submit permission');

  await post(url, '/api/submit', { answers: { q1: 'no' }, comment: 'owner final' });
  const done = await exited;
  const result = JSON.parse(done.stdout);
  ok(result.status === 'submitted' && result.answers.q1 === 'no', 'owner final submit returns through the normal result path');
  ok(result.sideReviews.referenceOnly === true && result.sideReviews.submissions[0].answers.q1 === 'yes', 'owner final result includes side reviews clearly marked as reference-only');
  void id;
}

// ---------- 23c. durable boards keep their port + share links ----------
console.log('23c. durable board lifecycle');
{
  const r = await run(['ask', '-q', 'Durable?::yesno', '--detach', '--no-open', '--timeout', '1']);
  const info = JSON.parse(r.stdout);
  ok(r.code === 0 && info.status === 'open', 'durable test board starts detached');
  const reviewShare = await run(['share', info.boardId, '--role', 'review']);
  const reviewBody = JSON.parse(reviewShare.stdout);
  const reviewUrl = new URL(reviewBody.url);
  const reviewToken = reviewUrl.searchParams.get('token');
  const readShare = await run(['share', info.boardId, '--role', 'read']);
  const readBody = JSON.parse(readShare.stdout);
  const readUrl = new URL(readBody.url);
  const readToken = readUrl.searchParams.get('token');

  await sleep(1400);
  const statusAfterTimeout = await (await fetch(new URL('/api/status', info.url))).json();
  ok(statusAfterTimeout.softTimedOut === true, 'detached timeout is soft');
  const oldShareAfterTimeout = await requestViaHost(info.url, reviewUrl.pathname + reviewUrl.search, { token: reviewToken });
  ok(oldShareAfterTimeout.status === 200 && oldShareAfterTimeout.body.includes('"role":"review"'), 'reviewer share link keeps working after soft timeout');
  await requestViaHost(info.url, '/api/submit', {
    method: 'POST', token: reviewToken, reviewSession: 'rv-durable-submission', body: { answers: { q1: 'yes' }, comment: 'prior run' },
  });
  await requestViaHost(info.url, '/api/draft', {
    method: 'POST', token: reviewToken, reviewSession: 'rv-durable-draft', body: { answers: { q1: 'no' } },
  });

  const stop = await run(['stop', info.boardId]);
  ok(stop.code === 0 && JSON.parse(stop.stdout).stopped[0].status === 'cancelled', 'durable test board stops cleanly');
  const reopened = await run(['reopen', info.boardId, '--detach', '--no-open', '--timeout', '60']);
  const reopenedInfo = JSON.parse(reopened.stdout);
  ok(reopened.code === 0 && reopenedInfo.port === info.port, 'reopen reuses the original port');
  const oldShareAfterReopen = await requestViaHost(reopenedInfo.url, reviewUrl.pathname + reviewUrl.search, { token: reviewToken });
  ok(oldShareAfterReopen.status === 200 && oldShareAfterReopen.body.includes('"role":"review"') && oldShareAfterReopen.body.includes('"canSubmit":true'), 'old reviewer URL/token survives re-serving the board');
  const oldReadAfterReopen = await requestViaHost(reopenedInfo.url, readUrl.pathname + readUrl.search, { token: readToken });
  ok(oldReadAfterReopen.status === 200 && oldReadAfterReopen.body.includes('"role":"read"') && oldReadAfterReopen.body.includes('"canSubmit":false'), 'read-only URL/token also survives same-port re-serving');
  const freshReviewRound = JSON.parse((await run(['result', info.boardId])).stdout).sideReviews;
  ok(freshReviewRound.submissions.length === 0 && Object.keys(freshReviewRound.drafts).length === 0, 'reopen archives prior side reviews and starts a fresh review round');

  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  ok(!serverSrc.includes('startIdleWatchdog') && !serverSrc.includes('IDLE_CLOSE_MS'), 'detached boards have no post-timeout idle close watchdog');
  await post(reopenedInfo.url, '/api/submit', { answers: { q1: 'yes' } });
}

// ---------- 24. code (codeFile + lang default) & diff blocks normalize ----------
console.log('24. code & diff blocks');
{
  const srcFile = path.join(HOME, 'sample.go');
  fs.writeFileSync(srcFile, 'package main\nfunc main() {}\n');
  const CD_SPEC = {
    title: 'Code & diff',
    blocks: [
      { type: 'code', codeFile: srcFile },                                  // lang defaults to "go"
      { type: 'code', code: 'const a = 1;', lang: 'js', filename: 'a.js' },
      { type: 'diff', filename: 'app.py', diff: '@@ -1,2 +1,2 @@\n-old = 1\n+new = 2\n ctx\n' },
      { type: 'diff', diff: '@@ -1 +1 @@\n-a\n+b\n', view: 'split' },
    ],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'cd-spec.json');
  fs.writeFileSync(p, JSON.stringify(CD_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  const bb = board.spec.blocks;
  ok(bb[0].type === 'code' && bb[0].code.includes('package main'), 'code block loads codeFile contents');
  ok(bb[0].lang === 'go', 'code block lang defaults from the codeFile extension (.go → go)');
  ok(bb[1].lang === 'js' && bb[1].filename === 'a.js', 'inline code keeps explicit lang + filename');
  ok(bb[2].type === 'diff' && bb[2].diff.includes('+new = 2') && bb[2].filename === 'app.py', 'diff block normalizes (diff text + filename)');
  ok(bb[2].view === undefined && bb[3].view === 'split', 'diff "view" defaults unset (unified) and honors "split"');
  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;

  // empty code/diff → usage errors
  const noCode = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'code' }] }) });
  ok(noCode.code === 4 && /code block needs/.test(noCode.stderr), 'code block without code/codeFile → exit 4');
  const noDiff = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'diff', diff: '   ' }] }) });
  ok(noDiff.code === 4 && /diff block needs/.test(noDiff.stderr), 'diff block with empty diff → exit 4');
}

// ---------- 24b. git-conflict block + git board command ----------
console.log('24b. git conflict blocks & git command');
{
  const conflictText = [
    'const value = 1;',
    '<<<<<<< HEAD',
    'const label = "ours";',
    '||||||| base',
    'const label = "base";',
    '=======',
    'const label = "theirs";',
    '>>>>>>> feature',
    'export { label };',
    '',
  ].join('\n');
  const conflictFile = path.join(HOME, 'conflicted.js');
  fs.writeFileSync(conflictFile, conflictText);
  const SPEC = {
    title: 'Git conflict',
    blocks: [
      { type: 'git-conflict', content: conflictText, filename: 'inline.js' },
      { type: 'git-conflict', path: conflictFile },
    ],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'gitconf-spec.json');
  fs.writeFileSync(p, JSON.stringify(SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const bb = (await (await fetch(new URL('/api/board', url))).json()).spec.blocks;
  ok(bb[0].type === 'git-conflict' && bb[0].conflicts.length === 1 && bb[0].conflicts[0].base.includes('"base"'), 'git-conflict inline content parses ours/base/theirs');
  ok(bb[1].type === 'git-conflict' && bb[1].file === conflictFile && bb[1].filename === 'conflicted.js', 'git-conflict local path resolves and carries file metadata');
  await post(url, '/api/submit', {
    answers: { ok: 'yes' },
    blockEdits: {
      b1: {
        type: 'git-conflict-resolution',
        filename: 'inline.js',
        resolved: true,
        resolutions: { c1: { choice: 'theirs', value: 'const label = "theirs";' } },
        content: 'const label = "theirs";\n',
      },
    },
  });
  const done = await exited;
  const result = JSON.parse(done.stdout);
  ok(result.blockEdits?.b1?.type === 'git-conflict-resolution' && result.blockEdits.b1.resolutions.c1.choice === 'theirs',
    'structured git-conflict blockEdits survive server sanitization');

  const bad = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'git-conflict', content: 'no markers here' }] }) });
  ok(bad.code === 4 && /no git conflict markers/.test(bad.stderr), 'git-conflict without markers → exit 4');

  const c = await spawnBlocking(['git', 'conflict', conflictFile, '--no-open', '--timeout', '60']);
  const cb = (await (await fetch(new URL('/api/board', c.url))).json()).spec.blocks;
  ok(cb[0].type === 'git-conflict' && cb[0].conflicts[0].theirsLabel === 'feature', 'rly git conflict <file> builds a resolver board');
  await post(c.url, '/api/submit', { blockEdits: {} });
  await c.exited;

  const reviewDiff = [
    'diff --git a/demo.js b/demo.js',
    '--- a/demo.js',
    '+++ b/demo.js',
    '@@ -1,2 +1,2 @@',
    ' const ready = true;',
    '-const label = "old";',
    '+const label = "new";',
    '',
  ].join('\n');
  const reviewSpec = {
    title: 'Diff review',
    blocks: [{ type: 'diff', diff: reviewDiff, review: true, reviewKind: 'cherry-pick', commit: 'abc123', view: 'split' }],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const reviewPath = path.join(HOME, 'diff-review-spec.json');
  fs.writeFileSync(reviewPath, JSON.stringify(reviewSpec));
  const review = await spawnBlocking(['ask', '--file', reviewPath, '--no-open', '--timeout', '60']);
  const rb = (await (await fetch(new URL('/api/board', review.url))).json()).spec.blocks[0];
  ok(rb.type === 'diff' && rb.review === true && rb.reviewKind === 'cherry-pick' && rb.commit === 'abc123',
    'diff review block preserves review metadata');
  await post(review.url, '/api/submit', {
    answers: { ok: 'yes' },
    blockEdits: {
      b1: {
        type: 'diff-review',
        reviewKind: 'cherry-pick',
        commit: 'abc123',
        resolved: true,
        hunks: { h1: { choice: 'apply', file: 'demo.js', header: '@@ -1,2 +1,2 @@' } },
      },
    },
  });
  const reviewDone = await review.exited;
  const reviewResult = JSON.parse(reviewDone.stdout);
  ok(reviewResult.blockEdits?.b1?.type === 'diff-review' && reviewResult.blockEdits.b1.hunks.h1.choice === 'apply',
    'structured diff-review blockEdits survive server sanitization');

  // Exercise git boards in a deterministic repository. GitHub Actions checks
  // out a single commit by default, so relying on Relay's own history made the
  // multi-commit rank assertion fail only in CI.
  const gitRepo = path.join(HOME, 'git-board-repo');
  fs.mkdirSync(gitRepo);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: gitRepo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Relay Test');
  git('config', 'user.email', 'relay-test@example.invalid');
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(gitRepo, 'demo.txt'), `revision ${i}\n`);
    git('add', 'demo.txt');
    git('commit', '--quiet', '-m', `Fixture commit ${i}`);
  }

  const g = await spawnBlocking(['git', 'pick', '--limit', '2', '--no-open', '--timeout', '60'], { cwd: gitRepo });
  const gs = (await (await fetch(new URL('/api/board', g.url))).json()).spec;
  ok(gs.questions.some((q) => q.id === 'commit_actions' && q.type === 'checklist'), 'rly git pick creates commit action checklist');
  ok(gs.questions.some((q) => q.id === 'commit_order' && q.type === 'rank'), 'rly git pick creates commit order rank control');
  await post(g.url, '/api/submit', { answers: {} });
  await g.exited;

  const cp = await spawnBlocking(['git', 'cherry-pick', '--code', '--limit', '1', '--no-open', '--timeout', '60'], { cwd: gitRepo });
  const cps = (await (await fetch(new URL('/api/board', cp.url))).json()).spec;
  ok(cps.blocks.some((b) => b.type === 'diff' && b.review === true && b.reviewKind === 'cherry-pick' && /diff --git/.test(b.diff || '')),
    'rly git cherry-pick --code creates split diff review blocks');
  ok(!cps.questions.some((q) => q.id === 'commit_order'), 'single-commit git board omits unnecessary rank control');
  await post(cp.url, '/api/submit', { answers: {}, blockEdits: {} });
  await cp.exited;
}

// ---------- 25. video blocks: youtube embed, local stream (Range), URL passthrough ----------
console.log('25. video blocks');
{
  const vid = path.join(HOME, 'clip.mp4');
  const bytes = Buffer.alloc(2048, 7); // not a real mp4, fine for streaming assertions
  fs.writeFileSync(vid, bytes);
  const V_SPEC = {
    title: 'Videos',
    blocks: [
      { type: 'video', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', title: 'yt' },
      { type: 'video', src: vid, title: 'local' },
      { type: 'video', src: 'https://cdn.example.com/movie.webm' },
    ],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'v-spec.json');
  fs.writeFileSync(p, JSON.stringify(V_SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  const bb = board.spec.blocks;
  ok(bb[0].provider === 'youtube' && bb[0].videoId === 'dQw4w9WgXcQ' && bb[0].start === 42, 'youtube URL → provider/videoId/start parsed');
  ok(bb[1].type === 'video' && bb[1].file === vid && bb[1].mime === 'video/mp4', 'local video stored with absolute file path + mime (server-side)');
  ok(bb[2].src === 'https://cdn.example.com/movie.webm' && bb[2].mime === 'video/webm', 'direct media URL passthrough + mime guessed from extension');

  // the page payload must NOT leak the local path; it ships hasFile + mime.
  const page = await (await fetch(url)).text();
  ok(page.includes('"hasFile":true'), 'local video block ships hasFile flag');
  ok(!page.includes(vid), 'local video absolute path is NOT in the page payload');

  // /video/b/<id> streams with Range support.
  const localId = bb[1].id;
  const full = await fetch(new URL('/video/b/' + localId, url));
  ok(full.status === 200 && (full.headers.get('content-type') || '').includes('video/mp4'), '/video/b/<id> serves the local video with its mime');
  ok(full.headers.get('accept-ranges') === 'bytes', '/video/b/<id> advertises Range support');
  const ranged = await fetch(new URL('/video/b/' + localId, url), { headers: { range: 'bytes=0-99' } });
  const rangedBuf = Buffer.from(await ranged.arrayBuffer());
  ok(ranged.status === 206 && /bytes 0-99\/2048/.test(ranged.headers.get('content-range') || ''), 'Range request → 206 with content-range');
  ok(rangedBuf.length === 100, 'Range request returns exactly the requested byte count');
  ok((await fetch(new URL('/video/b/nope', url))).status === 404, '/video/b/<unknown> → 404');

  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;

  // unsupported local video extension → usage error
  const badExt = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'video', src: 'movie.flv' }] }) });
  ok(badExt.code === 4 && /unsupported video extension/.test(badExt.stderr), 'unsupported local video extension → exit 4');
}

// ---------- 26. MCP App server (stdio JSON-RPC) ----------
// Drive `rly mcp` over stdio exactly as an MCP host would: a batch of
// newline-delimited JSON-RPC messages in, the responses collected by id.
console.log('26. mcp app server (stdio)');
function mcpRoundtrip(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { env: ENV });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      const byId = {};
      const notifications = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let m;
        try { m = JSON.parse(t); } catch { continue; }
        if (m.id !== undefined && m.id !== null) byId[m.id] = m;
        else notifications.push(m);
      }
      resolve({ byId, notifications, out, err });
    });
    child.on('error', reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end(); // closing stdin ends the server
  });
}
{
  const { byId, out } = await mcpRoundtrip([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ui://relay/board' } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'relay_ask', arguments: { title: 'Inline', questions: [{ id: 'go', type: 'yesno', label: 'Ship it?' }], blocks: [{ type: 'markdown', md: '## hi' }] } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'relay_ask', arguments: { questions: [{ type: 'nope', label: 'x' }] } } },
    { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'ui://relay/vendor/../package.json' } },
    { jsonrpc: '2.0', id: 9, method: 'no/such/method' },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'relay_show', arguments: { blocks: [{ type: 'palette', title: 'Trending', palettes: [{ name: 'Mocha', sub: 'warm', tag: 'Pantone', tagTone: 'warm', featured: true, colors: ['#C4956A', '#A67B52'] }] }] } } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'relay_ask', arguments: { questions: [{ id: 'brand', type: 'color', label: 'Brand color', presets: ['#c2674b', '#185FA5'], default: '#c2674b' }] } } },
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'relay_ask', arguments: { questions: [{ id: 'pick', type: 'single', label: 'Pick one', options: ['a', 'b'] }, { id: 'env', type: 'single', label: 'Env', options: ['dev', 'prod'], other: false }] } } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'relay_show', arguments: { blocks: [{ type: 'mermaid', code: 'graph TD; A-->' }] } } },
  ]);

  // stdout must be pure protocol — every non-blank line is valid JSON-RPC.
  ok(out.trim().split('\n').every((l) => { try { return JSON.parse(l).jsonrpc === '2.0'; } catch { return false; } }), 'every stdout line is a JSON-RPC message (no log noise on stdout)');

  const init = byId[1].result;
  ok(init.protocolVersion === '2025-06-18' && init.serverInfo.name === 'relay', 'initialize echoes protocol + serverInfo');
  ok(init.capabilities.extensions && init.capabilities.extensions['io.modelcontextprotocol/ui'], 'initialize advertises the io.modelcontextprotocol/ui extension');

  const toolNames = byId[2].result.tools.map((t) => t.name);
  ok(toolNames.includes('relay_ask') && toolNames.includes('relay_show'), 'tools/list exposes relay_ask + relay_show');
  const ask = byId[2].result.tools.find((t) => t.name === 'relay_ask');
  ok(ask._meta.ui.resourceUri === 'ui://relay/board', 'relay_ask links the ui resource via _meta.ui.resourceUri');
  ok(ask._meta['openai/outputTemplate'] === 'ui://relay/board', 'relay_ask also carries openai/outputTemplate for ChatGPT/Codex');
  ok(ask.inputSchema && ask.inputSchema.properties && ask.inputSchema.properties.questions, 'relay_ask input schema is the board spec');

  const resList = byId[3].result.resources;
  ok(resList[0].uri === 'ui://relay/board' && resList[0].mimeType === 'text/html;profile=mcp-app', 'resources/list declares the ui:// board with the mcp-app mime');

  ok(JSON.stringify(byId[4].result) === '{}', 'ping → {}');

  const board = byId[5].result.contents[0];
  ok(board.mimeType === 'text/html;profile=mcp-app' && board.text.length > 1000, 'resources/read returns the board HTML with the profile mime');
  ok(board.text.includes('ui/message') && board.text.includes('RelayBlocks'), 'board HTML inlines the MCP client + the shared block renderer');
  ok(board.text.includes('WHEEL_ZOOM_SENSITIVITY') && board.text.includes('requestAnimationFrame(tick)'), 'shared viewer bundles delta-based, animation-frame wheel zoom smoothing');
  ok(board.text.includes('fluidFit: true') && board.text.includes("opts.fluidFit ? '100%'"), 'responsive charts retain live fit width instead of freezing their initial viewport size');
  ok(!board.text.includes('e.deltaY < 0 ? 1.15 : 1 / 1.15'), 'shared viewer no longer compounds a fixed 15% jump per wheel event');
  ok(board.text.includes('ui/update-model-context'), 'board still syncs structured submission context when the host supports it');
  ok(board.text.indexOf('ui/message') < board.text.indexOf('ui/update-model-context'), 'inline submit sends a user message before the silent context update');
  ok(board.text.includes('ui/notifications/initialized'), 'board sends ui/notifications/initialized (the host withholds the spec until it does)');
  ok(board.text.includes('availableDisplayModes'), 'board declares fullscreen support so the host can offer its native control');
  ok(board.text.includes('ui/notifications/tool-input-partial'), 'board renders progressively from streamed partial tool input');
  ok(board.text.includes('--color-background-primary'), 'board color-blends onto the host style variables');
  ok(!board.text.includes('/api/draft') && !board.text.includes('/api/submit'), 'board HTML has no HTTP-server endpoints (pure postMessage)');

  const call = byId[6].result;
  ok(!call.isError && call.structuredContent.spec.questions.length === 1, 'tools/call returns the normalized spec as structuredContent');
  ok(call.structuredContent.spec.blocks[0].id === 'b1', 'tools/call spec is fully normalized (block ids assigned)');
  ok(call.content[0].type === 'text' && /displayed to the user/.test(call.content[0].text), 'tools/call result text tells the model the board is shown');

  ok(byId[7].result.isError && /invalid board spec/.test(byId[7].result.content[0].text), 'a bad spec comes back as an isError tool result (not a protocol crash)');
  ok(byId[8].error && byId[8].error.code === -32002, 'vendor path traversal is rejected (-32002)');
  ok(byId[9].error && byId[9].error.code === -32601, 'unknown method → -32601 method not found');
  const pal = byId[10].result.structuredContent.spec.blocks[0];
  ok(pal.type === 'palette' && pal.palettes[0].colors.length === 2 && pal.palettes[0].featured === true && pal.palettes[0].tagTone === 'warm', 'palette block normalizes (palettes, colors, featured, tagTone)');
  ok(board.text.includes('blk-palette') || board.text.includes('renderPalette'), 'board renderer includes the palette block');
  const cq = byId[11].result.structuredContent.spec.questions[0];
  ok(cq.type === 'color' && Array.isArray(cq.presets) && cq.presets.length === 2 && cq.default === '#c2674b', 'color question normalizes (type, presets, default)');
  ok(board.text.includes('controlColor'), 'board renderer includes the color picker control');
  ok(board.text.includes('RelayAnnotate') && board.text.includes('Annotate.init'), 'board bundles + initializes the element-annotation engine');
  ok(board.text.includes('ann-confirm') && board.text.includes('requestDelete'), 'board ships the confirm-delete modal (no accidental delete)');
  ok(!ask.inputSchema.properties.annotations, 'relay_ask input schema omits result-only "annotations"');
  const sq = byId[12].result.structuredContent.spec.questions;
  ok(sq[0].other === true && sq[1].other === false, 'single questions default "other" ON (opt out with other:false)');
  ok(/\[pick\] Pick one \(single/.test(byId[12].result.content[0].text), 'tool-result text carries a fallback question list for non-rendering surfaces');
  ok(byId[13].result.isError && /invalid mermaid syntax/.test(byId[13].result.content[0].text), 'MCP invalid mermaid returns an isError tool result instead of a displayable board');
}

// ---------- 27. rly mcp config / install ----------
console.log('27. mcp config + install');
{
  const cfg = await run(['mcp', 'config']);
  ok(cfg.code === 0, 'rly mcp config exits 0');
  const parsed = JSON.parse(cfg.stdout);
  ok(parsed.claudeDesktop.add.mcpServers.relay.args.join(' ') === 'mcp', 'mcp config prints the claude-desktop server entry (rly mcp)');
  ok(/\[mcp_servers\.relay\]/.test(parsed.codex.add), 'mcp config prints the codex TOML block');

  // install --target codex writes ~/.codex/config.toml under the test HOME.
  const inst = await run(['mcp', 'install', '--target', 'codex']);
  ok(inst.code === 0 && JSON.parse(inst.stdout).installed === 'codex', 'rly mcp install --target codex writes the config');
  const codexCfg = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8');
  ok(/\[mcp_servers\.relay\]/.test(codexCfg) && /command = "rly"/.test(codexCfg), 'codex config.toml now registers the relay server');
  const again = await run(['mcp', 'install', '--target', 'codex']);
  ok(/already present/.test(JSON.parse(again.stdout).note), 'a second install is idempotent (left as-is)');
  const badTarget = await run(['mcp', 'install', '--target', 'nope']);
  ok(badTarget.code === 4, 'mcp install --target <unknown> → exit 4');
}

// ---------- 28. MCP App server over Streamable HTTP ----------
console.log('28. mcp app server (streamable http)');
{
  const port = 47193;
  const child = spawn(process.execPath, [BIN, 'mcp', '--http', '--port', String(port), '--token', 'tkn'], { env: ENV });
  let serr = '';
  child.stderr.on('data', (d) => (serr += d));
  await new Promise((resolve, reject) => {
    const t = setInterval(() => { if (/listening on/.test(serr)) { clearInterval(t); resolve(); } }, 40);
    setTimeout(() => { clearInterval(t); reject(new Error('http server did not start: ' + serr)); }, 5000);
  });
  const httpRpc = (msg, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(msg);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
      (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
  const noauth = await httpRpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
  ok(noauth.status === 401, 'http: request without the bearer token → 401');
  const init = await httpRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }, { authorization: 'Bearer tkn' });
  ok(init.status === 200 && JSON.parse(init.body).result.serverInfo.name === 'relay', 'http: initialize returns serverInfo');
  ok(typeof init.headers['mcp-session-id'] === 'string' && init.headers['mcp-session-id'].length > 0, 'http: initialize sets an Mcp-Session-Id header');
  ok(init.headers['access-control-allow-origin'] !== undefined, 'http: responses carry CORS headers (web hosts can fetch)');
  const tl = await httpRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: 'Bearer tkn' });
  ok(JSON.parse(tl.body).result.tools.map((t) => t.name).includes('relay_ask'), 'http: tools/list exposes relay_ask');
  const rd = await httpRpc({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://relay/board' } }, { authorization: 'Bearer tkn' });
  ok(JSON.parse(rd.body).result.contents[0].mimeType === 'text/html;profile=mcp-app', 'http: resources/read returns the board html');
  const call = await httpRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'relay_ask', arguments: { questions: [{ id: 'c', type: 'color', label: 'pick' }] } } }, { authorization: 'Bearer tkn' });
  ok(JSON.parse(call.body).result.structuredContent.spec.questions[0].type === 'color', 'http: tools/call normalizes + returns the spec');
  const badMermaidCall = await httpRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'relay_show', arguments: { blocks: [{ type: 'mermaid', code: 'graph TD; A-->' }] } } }, { authorization: 'Bearer tkn' });
  const badMermaidRpc = JSON.parse(badMermaidCall.body).result;
  ok(badMermaidRpc.isError && /invalid mermaid syntax/.test(badMermaidRpc.content[0].text), 'http: invalid mermaid returns an isError tool result before display');
  const evil = await httpRpc({ jsonrpc: '2.0', id: 5, method: 'ping' }, { authorization: 'Bearer tkn', origin: 'https://evil.example' });
  ok(evil.status === 403, 'http: a non-localhost Origin is rejected → 403 (DNS-rebind guard)');
  const note = await httpRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: 'Bearer tkn' });
  ok(note.status === 202, 'http: a notification → 202 Accepted (no body)');
  child.kill();
}

// ---------- 29. markdown mdFile + `rly view` ----------
console.log('29. markdown mdFile + rly view');
{
  const mdA = path.join(HOME, 'doc-a.md');
  const mdB = path.join(HOME, 'doc-b.md');
  const pdf = path.join(HOME, 'sample.pdf');
  fs.writeFileSync(mdA, '# Title A\n\nBody **A**.\n');
  fs.writeFileSync(mdB, '# Title B\n\nBody _B_.\n');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

  // markdown block loads its body from mdFile (mirrors codeFile/diffFile)
  const fileSpec = { title: 'x', blocks: [{ type: 'markdown', mdFile: mdA }] };
  const sp = path.join(HOME, 'md-spec.json');
  fs.writeFileSync(sp, JSON.stringify(fileSpec));
  const { url, exited } = await spawnBlocking(['show', '--file', sp, '--no-open', '--timeout', '60']);
  const board = await (await fetch(new URL('/api/board', url))).json();
  ok(board.spec.blocks[0].type === 'markdown' && board.spec.blocks[0].md.includes('Body **A**'),
    'markdown block loads mdFile contents');
  ok(board.spec.blocks[0].mdFile === undefined, 'mdFile is resolved at spec time (not leaked to the client)');
  await post(url, '/api/submit', {});
  await exited;

  // `rly view` renders one or more files; multi prepends a filename heading
  const v = await spawnBlocking(['view', mdA, mdB, '--no-open', '--timeout', '60']);
  const vb = (await (await fetch(new URL('/api/board', v.url))).json()).spec;
  ok(vb.title === '2 files', 'rly view titles a multi-file board');
  const mds = vb.blocks.filter((b) => b.type === 'markdown');
  ok(mds.length === 4, 'rly view renders a heading + body block per file');
  ok(mds[0].md === '## doc-a.md' && mds[1].md.includes('Body **A**'), 'rly view prepends a filename heading before each file');
  await post(v.url, '/api/submit', {});
  await v.exited;

  // `rly view file.pdf` streams the PDF in a pdf block instead of dumping raw
  // binary into a markdown block.
  const pv = await spawnBlocking(['view', pdf, '--no-open', '--timeout', '60']);
  const pb = (await (await fetch(new URL('/api/board', pv.url))).json()).spec;
  ok(pb.blocks[0].type === 'pdf' && pb.blocks[0].file === pdf && pb.blocks[0].mime === 'application/pdf', 'rly view <pdf> renders a pdf block');
  const pdfPage = await (await fetch(pv.url)).text();
  ok(pdfPage.includes('"type":"pdf"') && pdfPage.includes('"hasFile":true'), 'local pdf block ships hasFile flag');
  ok(!pdfPage.includes(pdf) && !pdfPage.includes('%PDF-1.4'), 'local pdf path and bytes are NOT in the page payload');
  const pdfRes = await fetch(new URL('/pdf/b/' + pb.blocks[0].id, pv.url));
  ok(pdfRes.status === 200 && (pdfRes.headers.get('content-type') || '').includes('application/pdf'), '/pdf/b/<id> serves the local pdf');
  ok((await fetch(new URL('/pdf/b/nope', pv.url))).status === 404, '/pdf/b/<unknown> → 404');
  await post(pv.url, '/api/submit', {});
  await pv.exited;

  // empty markdown (no md, no mdFile) → usage error
  const noMd = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', blocks: [{ type: 'markdown' }] }) });
  ok(noMd.code === 4 && /markdown block needs/.test(noMd.stderr), 'markdown block without md/mdFile → exit 4');
  // bare `rly view` with no file → usage error
  const noFile = await run(['view']);
  ok(noFile.code === 4 && /usage: rly view/.test(noFile.stderr), 'rly view with no file → exit 4');
}

// ---------- 30. rank question type ----------
console.log('30. rank question type');
{
  const RANK_SPEC = {
    title: 'Prioritize',
    questions: [
      { id: 'pri', type: 'rank', label: 'Order by priority',
        options: [{ value: 'a', label: 'Alpha', description: 'first' }, 'b', 'c'] },
      { id: 'pri2', type: 'ranking', label: 'Alias works', options: ['x', 'y'] },
    ],
  };
  const p = path.join(HOME, 'rank-spec.json');
  fs.writeFileSync(p, JSON.stringify(RANK_SPEC));
  const { id, url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const spec = (await (await fetch(new URL('/api/board', url))).json()).spec;
  const q = spec.questions[0];
  ok(q.type === 'rank' && q.options.length === 3 && q.options[0].value === 'a' && q.options[0].label === 'Alpha',
    'rank normalizes its options (string + object)');
  ok(q.other === undefined, 'rank has no "Other" free-text option');
  ok(spec.questions[1].type === 'rank', 'alias "ranking" normalizes to rank');

  // submit a reordered array; the result echoes it verbatim
  await post(url, '/api/submit', { answers: { pri: ['c', 'a', 'b'], pri2: ['y', 'x'] } });
  const res = JSON.parse((await exited).stdout);
  ok(Array.isArray(res.answers.pri) && res.answers.pri.join(',') === 'c,a,b',
    'rank answer roundtrips as an ordered array');
  ok(!res.skipped.includes('pri'), 'a rank question is never "skipped" (always carries an order)');

  // a rank needs at least 2 options
  const tooFew = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', questions: [{ id: 'r', type: 'rank', label: 'r', options: ['only'] }] }) });
  ok(tooFew.code === 4 && /needs at least 2 options/.test(tooFew.stderr), 'rank with <2 options → exit 4');

  // schema advertises the new type
  const schema = JSON.parse((await run(['schema'])).stdout);
  ok(schema.properties.questions.items.properties.type.enum.includes('rank'), 'rly schema lists "rank" in the question type enum');
}

// ---------- 31. checklist + allocate question types ----------
console.log('31. checklist + allocate');
{
  const SPEC31 = {
    title: 'QA & budget',
    questions: [
      { id: 'qa', type: 'checklist', label: 'Sign-off', options: ['login', 'search', 'checkout'] },
      { id: 'qa2', type: 'signoff', label: 'Alias', options: ['a'], statuses: ['yes', 'no'] },
      { id: 'spend', type: 'allocate', label: 'Split budget', total: 100, options: ['eng', 'design', 'ops'] },
      { id: 'spend2', type: 'budget', label: 'Alias', options: ['x', 'y'] },
    ],
  };
  const p = path.join(HOME, 'q31-spec.json');
  fs.writeFileSync(p, JSON.stringify(SPEC31));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const spec = (await (await fetch(new URL('/api/board', url))).json()).spec;
  const qa = spec.questions[0];
  ok(qa.type === 'checklist' && qa.options.length === 3, 'checklist normalizes its options');
  ok(qa.statuses.length === 3 && qa.statuses[0].value === 'pass' && qa.statuses[0].tone === 'ok' && qa.statuses[2].label === 'N/A',
    'checklist default statuses are Pass/Fail/N·A with tones');
  ok(spec.questions[1].type === 'checklist' && spec.questions[1].statuses.length === 2, 'alias "signoff" → checklist; custom statuses honored');
  ok(spec.questions[2].type === 'allocate' && spec.questions[2].total === 100, 'allocate normalizes (default total 100)');
  ok(spec.questions[3].type === 'allocate', 'alias "budget" → allocate');

  await post(url, '/api/submit', { answers: { qa: { login: 'pass', checkout: 'fail' }, spend: { eng: 50, design: 30, ops: 20 } } });
  const res = JSON.parse((await exited).stdout);
  ok(res.answers.qa && res.answers.qa.login === 'pass' && res.answers.qa.checkout === 'fail', 'checklist answer roundtrips as {item: status}');
  ok(res.answers.spend && res.answers.spend.eng === 50 && res.answers.spend.ops === 20, 'allocate answer roundtrips as {option: number}');

  const badChk = await run(['ask', '--file', '-'], { input: JSON.stringify({ title: 'x', questions: [{ id: 'c', type: 'checklist', label: 'c', options: ['a'], statuses: ['only'] }] }) });
  ok(badChk.code === 4 && /checklist needs ≥2/.test(badChk.stderr), 'checklist with <2 statuses → exit 4');
}

// ---------- 32. table rowsFile (CSV/JSON) + rly view data.csv + filter/export ----------
console.log('32. table rowsFile + view data');
{
  // CSV with a quoted field containing a comma and an escaped "" quote
  const csv = 'name,role,note\nAda,Eng,"Lovelace, Ada"\nBob,Design,"says ""hi"""\n';
  const csvFile = path.join(HOME, 'people.csv');
  fs.writeFileSync(csvFile, csv);
  const jsonFile = path.join(HOME, 'people.json');
  fs.writeFileSync(jsonFile, JSON.stringify([{ name: 'Cy', score: 9 }, { name: 'Di', score: 7 }]));

  const SPEC = {
    title: 'Data',
    blocks: [
      { type: 'table', rowsFile: csvFile, filterable: true, exportable: true },
      { type: 'table', rowsFile: jsonFile },
    ],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'data-spec.json');
  fs.writeFileSync(p, JSON.stringify(SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const bb = (await (await fetch(new URL('/api/board', url))).json()).spec.blocks;
  ok(bb[0].columns.map((c) => c.key).join(',') === 'name,role,note', 'rowsFile CSV header → columns');
  ok(bb[0].rows.length === 2 && bb[0].rows[0].note === 'Lovelace, Ada', 'CSV quoted field with a comma parses as one cell');
  ok(bb[0].rows[1].note === 'says "hi"', 'CSV escaped "" quote unescapes');
  ok(bb[0].filterable === true && bb[0].exportable === true, 'table filterable/exportable flags normalize');
  ok(bb[1].columns.map((c) => c.key).join(',') === 'name,score' && bb[1].rows[1].score === 7, 'rowsFile JSON array → columns from keys');
  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;

  // rly view data.csv → a filterable/exportable sortable table
  const v = await spawnBlocking(['view', csvFile, '--no-open', '--timeout', '60']);
  const vb = (await (await fetch(new URL('/api/board', v.url))).json()).spec.blocks;
  ok(vb[0].type === 'table' && vb[0].sortable && vb[0].filterable && vb[0].exportable, 'rly view <csv> renders a sortable+filterable+exportable table');
  await post(v.url, '/api/submit', {});
  await v.exited;
}

// ---------- 33. block ref (modal reference) + image pins normalize ----------
console.log('33. block ref + image pins');
{
  const SPEC = {
    title: 'Ref + pins',
    blocks: [
      { type: 'chart', ref: 'velocity', kind: 'bar', labels: ['a'], series: [{ label: 's', data: [1] }] },
      { type: 'image', src: 'https://example.com/m.png', pins: true },
      { type: 'markdown', md: 'See the [chart](#ref:velocity) and [first block](#block:b1).' },
    ],
    questions: [{ id: 'ok', type: 'yesno', label: 'OK?' }],
  };
  const p = path.join(HOME, 'ref-spec.json');
  fs.writeFileSync(p, JSON.stringify(SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const bb = (await (await fetch(new URL('/api/board', url))).json()).spec.blocks;
  ok(bb[0].ref === 'velocity', 'block "ref" name is preserved for reference links');
  ok(bb[1].type === 'image' && bb[1].pins === true, 'image "pins" flag enables coordinate pin-comments');
  ok(bb[2].md.includes('#ref:velocity'), 'markdown reference syntax passes through to the client renderer');
  await post(url, '/api/submit', { answers: { ok: 'yes' } });
  await exited;
}

// ---------- 34. color palette-as-answer + decision-type note defaults ----------
console.log('34. color palette + note defaults');
{
  const SPEC = {
    title: 'Color + notes',
    questions: [
      { id: 'brand', type: 'color', label: 'Pick a brand color',
        palette: ['#c2674b', { value: 'rgb(77,138,102)', label: 'Forest' }, { color: 'rebeccapurple', name: 'Royal' }] },
      { id: 'rk', type: 'rank', label: 'order', options: ['a', 'b'] },
      { id: 'al', type: 'allocate', label: 'split', options: ['x', 'y'] },
      { id: 'ck', type: 'checklist', label: 'signoff', options: ['p'] },
      { id: 'mu', type: 'multi', label: 'pick', options: ['m', 'n'] },
    ],
  };
  const p = path.join(HOME, 'c34-spec.json');
  fs.writeFileSync(p, JSON.stringify(SPEC));
  const { url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const qs = (await (await fetch(new URL('/api/board', url))).json()).spec.questions;
  const brand = qs[0];
  ok(Array.isArray(brand.palette) && brand.palette.length === 3, 'color question normalizes a palette array');
  ok(brand.palette[0].value === '#c2674b' && brand.palette[1].value === 'rgb(77,138,102)' && brand.palette[1].label === 'Forest', 'palette accepts strings + {value/color,label/name}, any color system');
  ok(brand.palette[2].value === 'rebeccapurple' && brand.palette[2].label === 'Royal', 'palette {color,name} shorthand works (named color)');
  ok(qs[1].note === true && qs[2].note === true && qs[3].note === true, 'rank/allocate/checklist default to note:true');
  ok(qs[4].note === false, 'multi still defaults to note:false');
  await post(url, '/api/submit', { answers: { brand: 'rebeccapurple' } });
  const res = JSON.parse((await exited).stdout);
  ok(res.answers.brand === 'rebeccapurple', 'color answer preserves the authored color string (any system)');
}

// ---------- 35. binding a briefly-busy port retries instead of falling back ----------
console.log('35. port-reuse retries a briefly-busy port');
{
  // Occupy a free port and free it ~500ms later (mimicking a just-stopped
  // board's close grace), then start a detached board ON that port. It should
  // RETRY and win the port — so a reopen/rescue reconnects the user's open tab
  // — rather than immediately falling back to a random one.
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const want = blocker.address().port;
  setTimeout(() => blocker.close(), 500);
  const r = await run(['ask', '-q', 'ok?::yesno', '--title', 'retry', '--port', String(want), '--detach', '--no-open', '--timeout', '30']);
  const info = JSON.parse(r.stdout);
  ok(info.port === want, 'detached board retries a briefly-busy port and binds it (not a random fallback)');
  await run(['stop', info.boardId]);
}

// ---------- 36. native viewer chrome + durable image-region feedback ----------
console.log('36. native viewer chrome + image-region feedback');
{
  const blocksCss = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'blocks.css'), 'utf8');
  const blocksJs = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'blocks.js'), 'utf8');
  const annotateJs = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'annotate.js'), 'utf8');
  ok(/\.blk-tools\s*\{[^}]*position:\s*sticky/s.test(blocksCss), 'viewer toolbar uses browser-native sticky positioning');
  ok(!blocksJs.includes('_rlyToolsSync'), 'viewer toolbar no longer counter-translates itself in a JavaScript scroll handler');
  ok(!annotateJs.includes("Math.abs(window.scrollY - popScrollY) > 80) closePopover()"), 'page scrolling no longer closes and discards an open comment composer');
  ok(annotateJs.includes('commentDrafts') && annotateJs.includes('positionPopover'), 'comment drafts persist per target while the popover re-anchors on scroll');
  ok(blocksJs.includes("kind: 'image-region'") && blocksJs.includes("side: side"), 'image and comparison blocks emit side-aware image-region annotations');
  ok(blocksJs.includes("typeof ctx.saveArtifact === 'function'"), 'shared block context preserves the browser crop uploader');
  ok(blocksJs.includes("class: 'tool-region'") && blocksJs.includes("'aria-pressed'"), 'image viewers expose a discoverable one-shot area-comment mode');
  ok(blocksJs.includes('_rlyRegionMode') && blocksJs.includes('setModeActive'), 'area-comment mode gates image panning and comparison-divider dragging');
  ok(blocksJs.includes('blk-imgregion-provisional') && blocksJs.includes('onClose:'), 'a provisional area remains visible until its comment composer closes');
  ok(blocksJs.includes('blk-imgregion-badge') && blocksJs.includes('blk-imgregion-count'), 'persisted area zones render a comment icon plus count indicator');
  ok(annotateJs.includes('popCloseHook') && annotateJs.includes("closePopover('saved')"), 'annotation composer reports save/cancel lifecycle to provisional zones');
  ok(blocksJs.includes('if (!active && moved > 5) beginSelection'), 'direct primary drag starts image-area selection without a mode click');
  ok(blocksJs.includes("const handleTarget = e.target.closest('.cmp-handle')"), 'comparison divider dragging starts only from its handle');
  ok(blocksJs.includes('viewerSpacePan') && blocksJs.includes('e.button === 1'), 'commentable-image panning uses Space-drag or middle-button drag instead of stealing area selection');
  ok(/class: 'blk-img',[\s\S]{0,220}draggable: 'false'/.test(blocksJs), 'standalone images disable native browser dragging before area selection');
  ok(/\.cmp-frame\s*\{[^}]*cursor:\s*crosshair/s.test(blocksCss), 'comparison canvas uses the area-selection cursor away from the divider');
  ok(/\.cmp-handle\s*\{[^}]*cursor:\s*ew-resize/s.test(blocksCss), 'comparison resize cursor is scoped to the divider handle');

  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const p = path.join(HOME, 'region-spec.json');
  fs.writeFileSync(p, JSON.stringify({
    title: 'Region artifact',
    blocks: [{ type: 'image', src: tinyPng, alt: 'pixel' }, { type: 'compare', before: tinyPng, after: tinyPng }],
  }));
  const { id, url, exited } = await spawnBlocking(['ask', '--file', p, '--no-open', '--timeout', '60']);
  const upload = await post(url, '/api/artifact', {
    dataUrl: tinyPng,
    blockId: 'b1',
    width: 1,
    height: 1,
  });
  const uploaded = await upload.json();
  ok(upload.ok && typeof uploaded.path === 'string' && fs.existsSync(uploaded.path), 'browser crop uploads to a board-owned local image artifact');
  const annotation = {
    id: 'a-region',
    blockId: 'b1',
    questionId: null,
    target: { kind: 'image-region', x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'pixel', crop: uploaded },
    text: 'Inspect this area',
    createdAt: new Date().toISOString(),
  };
  await post(url, '/api/draft', { annotations: [annotation] });
  const draft = await (await fetch(new URL('/api/draft', url))).json();
  ok(draft.draft.annotations[0].target.crop.path === uploaded.path, 'autosaved image-region annotation retains its validated local crop path');
  await post(url, '/api/submit', { annotations: [annotation] });
  const result = JSON.parse((await exited).stdout);
  ok(result.annotations[0].target.kind === 'image-region' && result.annotations[0].target.crop.path === uploaded.path, 'final result gives the agent region coordinates plus a viewable local crop');
  ok(fs.existsSync(path.join(HOME, 'boards', `${id}.artifacts`)), 'region crops live beside the owning board record');
}

// ---------- 37. display-only boards + long-wait defaults ----------
console.log('37. display-only boards + long-wait defaults');
{
  const p = path.join(HOME, 'display-only.json');
  fs.writeFileSync(p, JSON.stringify({
    title: 'Just look',
    responseRequired: false,
    blocks: [
      { type: 'markdown', md: 'No acknowledgement is needed.' },
      { type: 'html', html: '<button>View only</button>' },
    ],
  }));
  const shown = await run(['show', '--file', p, '--detach', '--no-open', '--timeout', '60']);
  const info = JSON.parse(shown.stdout);
  const board = await (await fetch(new URL('/api/board', info.url))).json();
  ok(board.spec.responseRequired === false, 'responseRequired:false normalizes as an explicit display-only board');
  const page = await (await fetch(info.url)).text();
  ok(page.includes('"responseRequired":false'), 'browser boot payload carries display-only mode');
  const displayHtml = await (await fetch(new URL('/html/b/b2', info.url))).text();
  ok(!displayHtml.includes('relayKit.annotate.auto()'), 'display-only custom HTML omits comment affordances');
  const rejected = await post(info.url, '/api/submit', {});
  ok(rejected.status === 409, 'display-only boards reject accidental submissions');
  await run(['stop', info.boardId]);

  const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  ok(cliSrc.includes('DEFAULT_WAIT_TIMEOUT_SEC = 86400'), 'rly wait defaults to a full day instead of a short interaction window');
  const ask = await run(['ask', '-q', 'Long wait?::yesno', '--detach', '--no-open', '--timeout', '60']);
  const askInfo = JSON.parse(ask.stdout);
  const indefiniteWait = run(['wait', askInfo.boardId, '--timeout', '0']);
  await sleep(500);
  await post(askInfo.url, '/api/submit', { answers: { q1: 'yes' } });
  const waited = await indefiniteWait;
  ok(waited.code === 0 && JSON.parse(waited.stdout).status === 'submitted', 'rly wait --timeout 0 waits without a Relay deadline until submit');

  const { byId } = await mcpRoundtrip([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'relay_show', arguments: { blocks: [{ type: 'markdown', md: 'FYI' }] } } },
  ]);
  ok(byId[2].result.structuredContent.spec.responseRequired === false, 'inline relay_show is display-only by default and does not wait for acknowledgement');
  ok(/no acknowledgement/i.test(byId[2].result.content[0].text), 'relay_show tells the agent to continue without waiting');
}

console.log(`\nAll ${passed} assertions passed. (storage: ${HOME})`);
process.exit(0);
