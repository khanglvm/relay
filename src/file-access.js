// The one place a spec's local-file reads are allowed or refused. Specs are
// untrusted (an MCP client over HTTP writes them), so every path they name is
// resolved through realpath and must land inside a configured root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './util.js';

/**
 * @typedef {object} FileAccess
 * @property {string} cwd Directory that relative spec paths resolve against.
 * @property {string[]} roots Real paths a spec may read from; a root may be a single file.
 */

/** Env var with extra roots, separated by the platform's path delimiter (":" on macOS and Linux). */
export const FILE_ROOTS_ENV = 'RLY_FILE_ROOTS';

const FIX_HINT = 'pass --root PATH (or set RLY_FILE_ROOTS), or fileRoots in registerRelay, to allow it';

/** Expands a leading `~` to the home directory. */
export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Real path of `p`, or of its nearest existing ancestor plus the rest when `p`
 * does not exist. A missing path under an allowed root can then be told apart
 * from one outside every root without touching the outside path.
 */
function realpathOrAncestor(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch (err) {
      const parent = path.dirname(cur);
      if (parent === cur || (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Real paths of the roots that exist; a root that does not exist grants nothing. */
export function realRoots(list, cwd) {
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      out.push(fs.realpathSync.native(path.resolve(cwd, expandHome(raw.trim()))));
    } catch { /* a root that is not there yet grants nothing */ }
  }
  return [...new Set(out)];
}

/**
 * True when `dir` is a filesystem root or the home directory. Such a folder is
 * too wide to grant by default: a desktop host often starts a stdio server at
 * `/`, which would let a spec read the whole disk. Passing it as `--root` still works.
 */
export function isBroadRoot(dir) {
  let real;
  try { real = fs.realpathSync.native(path.resolve(dir)); } catch { return false; }
  if (path.parse(real).root === real) return true;
  try { return real === fs.realpathSync.native(os.homedir()); } catch { return false; }
}

/** Roots named by `RLY_FILE_ROOTS`. */
export function envFileRoots(env = process.env) {
  return String(env[FILE_ROOTS_ENV] || '').split(path.delimiter).filter(Boolean);
}

/**
 * @param {{ cwd?: string, roots?: string[] }} [options] `roots` of `[]` means no local file may be read.
 * @returns {FileAccess}
 */
export function createFileAccess({ cwd = process.cwd(), roots = [cwd] } = {}) {
  return { cwd, roots: realRoots(roots, cwd) };
}

/** True when `target` is a root or lies under one. Both are real paths. */
export function isInsideRoots(target, roots) {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  });
}

/**
 * Resolves a path a spec names and says whether it may be read.
 * @param {FileAccess} access
 * @param {unknown} raw the path as written; `~` and relative paths are expanded
 * @param {{ allowDirectory?: boolean }} [options] directories are refused unless a caller opens them in an app
 * @returns {{ ok: boolean, file?: string, stat?: fs.Stats, reason?: 'invalid' | 'outside' | 'missing' | 'not-file' | 'changed' }} `file` and `stat` when ok; otherwise the `reason`, which callers keep to themselves
 */
export function checkReadable(access, raw, { allowDirectory = false } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.includes('\0')) return { ok: false, reason: 'invalid' };
  const resolved = path.resolve(access.cwd, expandHome(text));
  const real = realpathOrAncestor(resolved);
  if (!isInsideRoots(real, access.roots)) return { ok: false, reason: 'outside' };
  let stat;
  try { stat = fs.statSync(real); } catch { return { ok: false, reason: 'missing' }; }
  if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) return { ok: false, reason: 'not-file' };
  return { ok: true, file: real, stat };
}

// O_NOFOLLOW refuses a final component that became a symlink after the check.
// O_NONBLOCK keeps a file swapped for a FIFO from hanging the open; the identity check below then refuses it.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The path the kernel holds for an open descriptor, or null where Node cannot ask (macOS, Windows).
 * Linux keeps it in /proc/self/fd, which no rename of a parent folder can fake.
 */
function openedPath(fd) {
  if (process.platform !== 'linux') return null;
  try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; }
}

/**
 * True when `file` still resolves to itself, inside the roots, and is the very file `fd` has open.
 * Known open risk on macOS and Windows: the name checks below walk the path again, so a writer inside a
 * root who swaps a parent folder for a symlink and back between those calls can still win the race.
 */
function isStillTheCheckedFile(access, file, fd) {
  try {
    const opened = openedPath(fd);
    if (opened !== null && opened !== file) return false;
    if (fs.realpathSync.native(file) !== file || !isInsideRoots(file, access.roots)) return false;
    const open = fs.fstatSync(fd);
    const named = fs.statSync(file);
    return open.isFile() && open.dev === named.dev && open.ino === named.ino;
  } catch {
    return false;
  }
}

/**
 * Like `checkReadable`, but also opens a regular file, and keeps the open
 * descriptor as the only way to read it. A path checked and then read by name
 * can be swapped for a symlink in between; the descriptor cannot. After the
 * open, the path must still resolve to the same file inside the roots, or the
 * read is refused. A directory (when allowed) comes back with `fd: null`.
 * The caller closes `fd`, or hands it to `streamFile`, which does.
 * @param {FileAccess} access
 * @param {unknown} raw
 * @param {{ allowDirectory?: boolean }} [options]
 * @returns {{ ok: boolean, file?: string, stat?: fs.Stats, fd?: number | null, reason?: 'invalid' | 'outside' | 'missing' | 'not-file' | 'changed' }}
 */
export function openReadable(access, raw, options = {}) {
  const checked = checkReadable(access, raw, options);
  if (!checked.ok) return { ok: false, reason: /** @type {any} */ (checked.reason) };
  const file = /** @type {string} */ (checked.file);
  if (!/** @type {fs.Stats} */ (checked.stat).isFile()) return { ok: true, file, stat: /** @type {fs.Stats} */ (checked.stat), fd: null };
  let fd;
  try { fd = fs.openSync(file, OPEN_FLAGS); } catch { return { ok: false, reason: 'changed' }; }
  if (!isStillTheCheckedFile(access, file, fd)) {
    fs.closeSync(fd);
    return { ok: false, reason: 'changed' };
  }
  return { ok: true, file, stat: fs.fstatSync(fd), fd };
}

/**
 * One message for every refusal, so it says nothing about whether the path
 * exists, where a symlink leads or what the folders look like. It echoes the
 * path as the caller wrote it.
 */
function refusal(where, field, raw) {
  const given = typeof raw === 'string' ? raw : String(raw);
  return new CliError(`${where}: ${field}: cannot read "${given}": no such file, not a regular file, or path outside allowed roots; ${FIX_HINT}.`);
}

/**
 * The real path of a file a spec names, or a CliError worded for the agent.
 * Use `readReadable` to read it.
 * @param {FileAccess} access
 * @param {unknown} raw
 * @param {string} where which block, e.g. `board.blocks[0]`
 * @param {string} field which field, e.g. `codeFile`
 * @returns {{ file: string, stat: fs.Stats }}
 */
export function resolveReadable(access, raw, where, field) {
  const checked = checkReadable(access, raw);
  if (!checked.ok) throw refusal(where, field, raw);
  return { file: /** @type {string} */ (checked.file), stat: /** @type {fs.Stats} */ (checked.stat) };
}

/**
 * The bytes of a file a spec names, read through one opened descriptor.
 * @param {FileAccess} access
 * @param {unknown} raw
 * @param {string} where which block, e.g. `board.blocks[0]`
 * @param {string} field which field, e.g. `codeFile`
 * @returns {{ file: string, stat: fs.Stats, buf: Buffer }}
 */
export function readReadable(access, raw, where, field) {
  const opened = openReadable(access, raw);
  if (!opened.ok || opened.fd === null) throw refusal(where, field, raw);
  try {
    return { file: opened.file, stat: opened.stat, buf: fs.readFileSync(opened.fd) };
  } catch {
    throw refusal(where, field, raw);
  } finally {
    fs.closeSync(opened.fd);
  }
}
