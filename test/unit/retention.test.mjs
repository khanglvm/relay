// Board retention (boards unchanged for 30 days go) and the atomic board write.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RETENTION_DAYS, pruneBoards, resolveRetentionDays } from '../../src/retention.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-retention-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23);

/** A relay home with boards of the given ages in days; returns the paths. */
function homeWith(ages) {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const boardsDir = path.join(home, 'boards');
  fs.mkdirSync(boardsDir);
  for (const [id, days] of Object.entries(ages)) {
    const file = path.join(boardsDir, `${id}.json`);
    fs.writeFileSync(file, '{}');
    const at = new Date(NOW - days * DAY_MS);
    fs.utimesSync(file, at, at);
  }
  return { home, boardsDir, left: () => fs.readdirSync(boardsDir).sort() };
}
const removeFile = (boardsDir) => (id) => { fs.unlinkSync(path.join(boardsDir, `${id}.json`)); return true; };

test('the window defaults to 30 days, and the option beats the environment', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.equal(resolveRetentionDays(undefined, {}), 30);
  assert.equal(resolveRetentionDays(undefined, { RLY_RETENTION_DAYS: '7' }), 7);
  assert.equal(resolveRetentionDays(14, { RLY_RETENTION_DAYS: '7' }), 14);
  assert.equal(resolveRetentionDays('14', {}), 14);
});

test('0, false and the words off and never turn retention off', () => {
  for (const off of [0, '0', false, 'off', 'OFF', 'never', 'none']) assert.equal(resolveRetentionDays(off, {}), 0, String(off));
  assert.equal(resolveRetentionDays(undefined, { RLY_RETENTION_DAYS: 'off' }), 0);
  assert.equal(resolveRetentionDays(30, { RLY_RETENTION_DAYS: 'off' }), 30);
});

test('a window that is not a number of days is an error that names its source', () => {
  assert.throws(() => resolveRetentionDays('soon', {}), /retentionDays must be a number of days/);
  assert.throws(() => resolveRetentionDays(-3, {}), /retentionDays/);
  assert.throws(() => resolveRetentionDays(undefined, { RLY_RETENTION_DAYS: 'x' }), /RLY_RETENTION_DAYS/);
});

test('boards older than the window go and younger ones stay', () => {
  const { home, boardsDir, left } = homeWith({ 'b-old': 31, 'b-edge': 29, 'b-new': 0 });
  const removed = pruneBoards({ home, boardsDir, days: 30, remove: removeFile(boardsDir), now: NOW });
  assert.deepEqual(removed, ['b-old']);
  assert.deepEqual(left(), ['b-edge.json', 'b-new.json']);
});

test('a board a live server still serves stays, however old', () => {
  const { home, boardsDir, left } = homeWith({ 'b-live': 90, 'b-gone': 90 });
  pruneBoards({ home, boardsDir, days: 30, keep: new Set(['b-live']), remove: removeFile(boardsDir), now: NOW });
  assert.deepEqual(left(), ['b-live.json']);
});

test('days of 0 removes nothing', () => {
  const { home, boardsDir, left } = homeWith({ 'b-old': 400 });
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 0, remove: removeFile(boardsDir), now: NOW }), []);
  assert.deepEqual(left(), ['b-old.json']);
});

test('a board saved after the scan is not removed', () => {
  const { home, boardsDir, left } = homeWith({ 'b-busy': 90 });
  const file = path.join(boardsDir, 'b-busy.json');
  const realStat = fs.statSync;
  let looks = 0;
  // The first look is the scan; the second is the re-check just before removal, after the person saved a draft.
  fs.statSync = (target, ...rest) => {
    const stat = realStat(target, ...rest);
    return String(target) === file && ++looks === 2 ? { ...stat, mtimeMs: NOW } : stat;
  };
  try {
    assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove: removeFile(boardsDir), now: NOW }), []);
  } finally {
    fs.statSync = realStat;
  }
  assert.deepEqual(left(), ['b-busy.json']);
});

test('a sweep skips while another process holds the lock, and takes over a stale lock', () => {
  const { home, boardsDir, left } = homeWith({ 'b-old': 90 });
  const lock = path.join(home, 'prune.lock');
  fs.mkdirSync(lock);
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove: removeFile(boardsDir), now: NOW }), []);
  assert.deepEqual(left(), ['b-old.json'], 'a fresh lock blocks the sweep');
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, stale, stale);
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove: removeFile(boardsDir), now: NOW }), [], 'the takeover clears the lock; the next sweep runs');
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove: removeFile(boardsDir), now: NOW }), ['b-old']);
  assert.ok(!fs.existsSync(lock), 'the lock is released');
});

test('a sweep that ran in the last hour is not repeated unless forced', () => {
  const { home, boardsDir, left } = homeWith({ 'b-a': 90 });
  const remove = removeFile(boardsDir);
  const now = Date.now();
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove, now }), ['b-a']);
  fs.writeFileSync(path.join(boardsDir, 'b-b.json'), '{}');
  const at = new Date(now - 90 * DAY_MS);
  fs.utimesSync(path.join(boardsDir, 'b-b.json'), at, at);
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove, now }), []);
  assert.deepEqual(pruneBoards({ home, boardsDir, days: 30, remove, now, force: true }), ['b-b']);
  assert.deepEqual(left(), []);
});

test('a temp file left by a crashed write is removed after a day', () => {
  const { home, boardsDir, left } = homeWith({ 'b-new': 0 });
  const stale = path.join(boardsDir, 'b-x.json.1.ab.tmp');
  const fresh = path.join(boardsDir, 'b-y.json.2.cd.tmp');
  fs.writeFileSync(stale, '{');
  fs.writeFileSync(fresh, '{');
  const old = new Date(NOW - 2 * DAY_MS);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(fresh, new Date(NOW), new Date(NOW));
  pruneBoards({ home, boardsDir, days: 30, remove: removeFile(boardsDir), now: NOW });
  assert.deepEqual(left(), ['b-new.json', 'b-y.json.2.cd.tmp']);
});

// store.js reads RLY_HOME when it loads, so these run in a child process with a home of their own.
function inChild(env, body) {
  const home = fs.mkdtempSync(path.join(TMP, 'child-'));
  const script = `
    const store = await import(${JSON.stringify(path.join(ROOT, 'src/store.js'))});
    const fs = await import('node:fs');
    const path = await import('node:path');
    const old = (id, days) => {
      const rec = { id, createdAt: new Date().toISOString(), title: id, spec: { questions: [] }, result: null, draft: null };
      store.saveBoard(rec);
      fs.writeFileSync(path.join(store.BOARDS_DIR, id + '.result.json'), '{}');
      fs.mkdirSync(store.artifactDirPath(id), { recursive: true });
      const at = new Date(Date.now() - days * 86400000);
      fs.utimesSync(path.join(store.BOARDS_DIR, id + '.json'), at, at);
    };
    ${body}
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, RLY_HOME: home, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { home, out: run.stdout.trim() };
}

test('making a board removes old boards with their result and artifacts, and keeps open ones', () => {
  const { home, out } = inChild({}, `
    old('b-stale', 45); old('b-recent', 5);
    store.createBoard({ title: 'fresh', questions: [], blocks: [] });
    console.log(JSON.stringify(fs.readdirSync(store.BOARDS_DIR).sort()));
  `);
  const names = JSON.parse(out);
  assert.ok(!names.some((n) => n.startsWith('b-stale')), `stale board and its sidecars are gone: ${names}`);
  assert.ok(names.includes('b-recent.json'));
  assert.equal(names.filter((n) => n.endsWith('.json') && !n.includes('result')).length, 2);
  assert.ok(fs.existsSync(path.join(home, 'prune.stamp')));
});

test('a board that a running server owns survives the sweep', () => {
  const { out } = inChild({}, `
    old('b-served', 90);
    store.saveRunning({ id: 'b-served', pid: process.pid, url: 'http://127.0.0.1:1' });
    store.createBoard({ title: 'fresh', questions: [], blocks: [] });
    console.log(fs.existsSync(path.join(store.BOARDS_DIR, 'b-served.json')));
  `);
  assert.equal(out, 'true');
});

test('RLY_RETENTION_DAYS=off and the retentionDays option keep every board', () => {
  const off = inChild({ RLY_RETENTION_DAYS: 'off' }, `
    old('b-stale', 400);
    store.createBoard({ title: 'fresh', questions: [], blocks: [] });
    console.log(fs.existsSync(path.join(store.BOARDS_DIR, 'b-stale.json')));
  `);
  assert.equal(off.out, 'true');
  const short = inChild({}, `
    old('b-week', 10);
    store.createBoard({ title: 'fresh', questions: [], blocks: [] }, { retentionDays: 7 });
    console.log(fs.existsSync(path.join(store.BOARDS_DIR, 'b-week.json')));
  `);
  assert.equal(short.out, 'false');
});

test('saveBoard writes through a temp file, so a failed write leaves the old board whole', () => {
  const { out } = inChild({}, `
    const rec = { id: 'b-keep', createdAt: 'x', title: 'one', spec: { questions: [] }, result: null, draft: null };
    store.saveBoard(rec);
    const realRename = fs.default.renameSync;
    fs.default.renameSync = () => { throw new Error('crash before the rename'); };
    let failed = false;
    try { store.saveBoard({ ...rec, title: 'two' }); } catch { failed = true; }
    fs.default.renameSync = realRename;
    console.log(JSON.stringify({ failed, title: store.loadBoard('b-keep').title, files: fs.readdirSync(store.BOARDS_DIR) }));
  `);
  assert.deepEqual(JSON.parse(out), { failed: true, title: 'one', files: ['b-keep.json'] });
});
