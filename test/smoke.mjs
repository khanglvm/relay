// Zero-dependency smoke tests: spawn the real CLI, hit the real server,
// fake-submit like the browser would, and assert on stdout JSON + exit codes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'rly.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-test-'));
// RLY_HOME is the live var; QUEST_BOARD_HOME is set too in case any code path
// still reads the pre-rename name.
const ENV = { ...process.env, RLY_HOME: HOME, QUEST_BOARD_HOME: HOME };

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
function spawnBlocking(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: ENV });
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
  const legacy = await (await fetch(new URL('/html/board', url))).text();
  ok(legacy.includes('<b>block body marker</b>'), 'legacy /html/board aliases the first board html block');
  const missing = await fetch(new URL('/html/b/does-not-exist', url));
  ok(missing.status === 404, '/html/b/<unknown> → 404');
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
      target: { kind: 'html-element', label: 'CTA button', detail: '#buy' },
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
  ok(ver.stdout.trim() === '0.3.0', '--version prints 0.3.0');
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

console.log(`\nAll ${passed} assertions passed. (storage: ${HOME})`);
process.exit(0);
