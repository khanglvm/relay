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
 * @returns {{ ok: boolean, file?: string, stat?: fs.Stats, reason?: 'invalid' | 'outside' | 'missing' | 'not-file', resolved?: string }} `file` and `stat` when ok; otherwise `reason` and the real path it was refused at
 */
export function checkReadable(access, raw, { allowDirectory = false } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.includes('\0')) return { ok: false, reason: 'invalid', resolved: text };
  const resolved = path.resolve(access.cwd, expandHome(text));
  const real = realpathOrAncestor(resolved);
  if (!isInsideRoots(real, access.roots)) return { ok: false, reason: 'outside', resolved: real };
  let stat;
  try { stat = fs.statSync(real); } catch { return { ok: false, reason: 'missing', resolved: real }; }
  if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) return { ok: false, reason: 'not-file', resolved: real };
  return { ok: true, file: real, stat };
}

/**
 * The real path of a file a spec names, or a CliError worded for the agent.
 * @param {FileAccess} access
 * @param {unknown} raw
 * @param {string} where which block, e.g. `board.blocks[0]`
 * @param {string} field which field, e.g. `codeFile`
 * @returns {{ file: string, stat: fs.Stats }}
 */
export function resolveReadable(access, raw, where, field) {
  const checked = checkReadable(access, raw);
  if (checked.ok) return { file: /** @type {string} */ (checked.file), stat: /** @type {fs.Stats} */ (checked.stat) };
  const given = typeof raw === 'string' ? raw : String(raw);
  const prefix = `${where}: ${field}: `;
  if (checked.reason === 'outside') {
    throw new CliError(`${prefix}path outside allowed roots (\"${given}\" resolves to ${checked.resolved}); ${FIX_HINT}.`);
  }
  if (checked.reason === 'not-file') throw new CliError(`${prefix}\"${given}\" is not a regular file (resolved: ${checked.resolved}).`);
  throw new CliError(`${prefix}cannot read \"${given}\" (resolved: ${checked.resolved})`);
}
