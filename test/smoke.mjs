// Zero-dependency smoke tests: spawn the real CLI, hit the real server,
// fake-submit like the browser would, and assert on stdout JSON + exit codes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'qbd.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qbd-test-'));
const ENV = { ...process.env, QUEST_BOARD_HOME: HOME };

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
        const m = stderr.match(/\[quest-board\] (b-[a-z0-9]+) open: (\S+)/);
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
    { id: 'parts', type: 'multi', label: 'Parts?', options: ['api', 'ui', 'docs'], other: true },
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
  ok(peeked.status === 'open' && peeked.draft?.answers?.ship === 'yes', 'qbd result exposes live draft while open');
  const reloaded = await (await fetch(url)).text();
  ok(reloaded.includes('"prefill":{"answers":{"ship":"yes"'), 'mid-fill page reload prefills from the live draft');

  const res = await post(url, '/api/submit', {
    answers: { ship: 'yes', parts: ['api', 'custom-other'], conf: 4, layout: 'a' },
    comment: 'looks good',
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
  ok(JSON.parse(schema.stdout).title === 'quest-board board spec', 'schema prints JSON Schema');
  const ver = await run(['--version']);
  ok(/^\d+\.\d+\.\d+/.test(ver.stdout.trim()), '--version prints semver');
  const help = await run(['help']);
  ok(/qbd agent/.test(help.stdout) && /skill install/.test(help.stdout), 'help mentions agent guide + skill');
  const agent = await run(['agent']);
  ok(/sizing contract/i.test(agent.stdout), 'agent guide prints');
  const timeoutRun = await run(['ask', '-q', 'x?::yesno', '--no-open', '--timeout', '1']);
  ok(timeoutRun.code === 2 && JSON.parse(timeoutRun.stdout).status === 'timeout', 'timeout → exit 2');
}

console.log(`\nAll ${passed} assertions passed. (storage: ${HOME})`);
process.exit(0);
