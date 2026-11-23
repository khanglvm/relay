// How long boards stay on disk, and the sweep that removes the ones past it.
// The sweep takes plain paths and callbacks, so store.js wires it to the relay home.
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './util.js';

export const RETENTION_ENV = 'RLY_RETENTION_DAYS';
export const DEFAULT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
// Boards are swept at most once an hour per relay home, however many boards are created.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// A sweep that died without releasing its lock is taken over after this long.
const STALE_LOCK_MS = 10 * 60 * 1000;
// A temp file left by a write that crashed before its rename.
const STALE_TEMP_MS = DAY_MS;
const LOCK_NAME = 'prune.lock';
const STAMP_NAME = 'prune.stamp';
const OFF_WORDS = new Set(['0', 'off', 'never', 'none', 'false', 'no']);

/**
 * The retention window in days; 0 means boards are kept forever.
 * The option wins over `RLY_RETENTION_DAYS`, which wins over the 30-day default.
 * @param {unknown} [option] a number of days, a numeric string, or `0`, `false` or "off" to keep every board
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveRetentionDays(option, env = process.env) {
  const fromEnv = env[RETENTION_ENV];
  const raw = option !== undefined && option !== null && option !== '' ? option : fromEnv;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RETENTION_DAYS;
  if (raw === false) return 0;
  const text = String(raw).trim().toLowerCase();
  if (OFF_WORDS.has(text)) return 0;
  const days = Number(text);
  if (!Number.isFinite(days) || days < 0) {
    const source = option !== undefined && option !== null && option !== '' ? 'retentionDays' : RETENTION_ENV;
    throw new CliError(`${source} must be a number of days (0 or "off" keeps every board), got "${text}".`);
  }
  return days;
}

/** Takes the sweep lock; false when another process holds it. */
function takeLock(lockDir) {
  try {
    fs.mkdirSync(lockDir);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return false;
  }
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_LOCK_MS) fs.rmdirSync(lockDir);
  } catch { /* the holder finished, or another process took it over first */ }
  return false;
}

const releaseLock = (lockDir) => { try { fs.rmdirSync(lockDir); } catch { /* already gone */ } };

/** True when the last sweep of this home was less than an hour ago. */
function sweptRecently(stampFile, now) {
  try { return now - fs.statSync(stampFile).mtimeMs < SWEEP_INTERVAL_MS; } catch { return false; }
}

const isOlderThan = (file, ms, now) => {
  try { return now - fs.statSync(file).mtimeMs > ms; } catch { return false; }
};

/** Ids of board files not touched for `days`; every save and draft updates a board file. */
function expiredBoardIds(boardsDir, days, now, keep) {
  const expired = [];
  for (const name of fs.readdirSync(boardsDir)) {
    const match = /^(b-[a-z0-9]+)\.json$/i.exec(name);
    if (match && !keep.has(match[1]) && isOlderThan(path.join(boardsDir, name), days * DAY_MS, now)) expired.push(match[1]);
  }
  return expired;
}

function removeStaleTempFiles(dir, now) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!name.endsWith('.tmp') || !isOlderThan(file, STALE_TEMP_MS, now)) continue;
    try { fs.unlinkSync(file); } catch { /* removed by another process */ }
  }
}

/**
 * Removes boards whose files have not changed for `days`. Several processes can
 * share one relay home: a lock directory keeps two sweeps apart, and a stamp
 * file keeps a busy home from sweeping on every new board. A board a running
 * server still serves, and any board younger than the window, stays.
 * @param {object} options
 * @param {string} options.home the relay home; holds the lock and the stamp
 * @param {string} options.boardsDir
 * @param {number} options.days window in days; 0 or less does nothing
 * @param {Set<string>} [options.keep] ids that must stay, such as boards with a live server
 * @param {(id: string) => boolean} options.remove deletes one board and its sidecar files
 * @param {number} [options.now] ms since the epoch
 * @param {boolean} [options.force] sweep even when one ran in the last hour
 * @returns {string[]} the ids removed
 */
export function pruneBoards({ home, boardsDir, days, keep = new Set(), remove, now = Date.now(), force = false }) {
  if (!(days > 0)) return [];
  const lockDir = path.join(home, LOCK_NAME);
  const stampFile = path.join(home, STAMP_NAME);
  if (!takeLock(lockDir)) return [];
  try {
    if (!force && sweptRecently(stampFile, now)) return [];
    // A board saved since the scan is checked again, so a draft that lands mid-sweep keeps its board.
    const removed = expiredBoardIds(boardsDir, days, now, keep)
      .filter((id) => isOlderThan(path.join(boardsDir, `${id}.json`), days * DAY_MS, now) && remove(id));
    removeStaleTempFiles(boardsDir, now);
    fs.writeFileSync(stampFile, new Date(now).toISOString());
    return removed;
  } finally {
    releaseLock(lockDir);
  }
}
