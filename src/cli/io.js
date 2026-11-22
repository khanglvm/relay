// What every command needs: output, spec input, loading a board and detaching a server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { envFileRoots, expandHome } from '../file-access.js';
import { linkSetting, loadConfig, serializeLink } from '../link.js';
import { runBoard } from '../server/index.js';
import { assertSpecReady, questionFromInline } from '../spec/index.js';
import { HOME, loadBoard, loadRunning, saveBoard, saveResultFile } from '../store.js';
import { CliError, pollFor } from '../util.js';
import { BIN, DEFAULT_BOARD_TIMEOUT_SEC } from './context.js';

/**
 * The directories a CLI-built spec may read local files from: where the person
 * ran the command, the spec file's directory, the `--html-file` directory, every
 * `--root`, `$RLY_FILE_ROOTS`, and `extra` for paths the command itself was given.
 * @param {Record<string, any>} args parsed flags
 * @param {string[]} [extra]
 * @returns {string[]} absolute paths
 */
export function cliFileRoots(args, extra = []) {
  const given = [
    process.cwd(),
    args.file && args.file !== '-' ? path.dirname(args.file) : '',
    typeof args.htmlFile === 'string' ? path.dirname(args.htmlFile) : '',
    ...(Array.isArray(args.root) ? args.root : []),
    ...envFileRoots(),
    ...extra,
  ];
  return given.filter(Boolean).map((p) => path.resolve(expandHome(p)));
}

export function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// Print a terminal result. A board with many annotations produces a large JSON
// payload, and an agent's shell harness commonly truncates long stdout — so the
// agent silently misses annotations past the cut. We write the FULL result to a
// sidecar file and surface its path FIRST (`resultFile`), so even a truncated
// stdout shows where the complete payload is; the agent reads that file with its
// file tool. Falls back to a plain print if the sidecar can't be written.
export function printResult(result) {
  const resultFile = result && result.boardId ? saveResultFile(result.boardId, result) : null;
  printJson(resultFile ? { resultFile, ...result } : result);
}

// Push-wake for `rly wait --notify-cmd`: run the agent's local shell command
// once a TERMINAL result lands. Result JSON goes to the command's stdin;
// RLY_BOARD_ID / RLY_STATUS / RLY_URL are exported. Same shape as the server's
// --on-result hook. Failures are swallowed; a 30s kill timer caps a hung cmd.
export function runNotifyCmd(cmd, result) {
  if (typeof cmd !== 'string' || !cmd.trim()) return;
  try {
    const child = spawn('/bin/sh', ['-c', cmd], {
      env: {
        ...process.env,
        RLY_BOARD_ID: result.boardId || '',
        RLY_STATUS: result.status || '',
        RLY_URL: result.url || '',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    try {
      child.stdin.write(JSON.stringify(result));
      child.stdin.end();
    } catch {
      // best effort
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 30000);
    killTimer.unref();
    child.on('close', () => clearTimeout(killTimer));
    child.unref();
  } catch {
    // swallow — push-wake is best effort
  }
}

export function exitCodeFor(status) {
  return { submitted: 0, acknowledged: 0, open: 0, timeout: 2, cancelled: 3 }[status] ?? 1;
}

export function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`invalid JSON in ${where}: ${err.message}`);
  }
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export function mustLoad(id) {
  if (!id) throw new CliError('missing <board-id>. See `rly history` for saved boards.');
  const record = loadBoard(id);
  if (!record) throw new CliError(`board "${id}" not found. See \`rly history\`.`, 5);
  return record;
}

export async function resolveSpecInput(args, mode) {
  let raw = {};
  if (args.file) {
    raw =
      args.file === '-'
        ? parseJson(await readStdin(), 'stdin')
        : parseJson(readFileOrThrow(args.file), args.file);
  } else if (args.stdin) {
    raw = parseJson(await readStdin(), 'stdin');
  }
  if (args.title) raw.title = args.title;
  if (args.intro) raw.intro = args.intro;
  if (typeof args.html === 'string') raw.html = args.html;
  if (args.htmlFile) raw.htmlFile = args.htmlFile;
  if (args.height) raw.htmlHeight = args.height;
  if (args.submitLabel) raw.submitLabel = args.submitLabel;
  if (args.displayOnly === true) raw.responseRequired = false;
  if (args.q.length) {
    raw.questions = [...(raw.questions || []), ...args.q.map((s, i) => questionFromInline(s, i))];
  }
  // If the user supplied a spec (file/stdin) let normalizeSpec report what's
  // wrong with it precisely; the generic usage hint is only for a bare call.
  const suppliedSpec = Boolean(args.file || args.stdin);
  const hasContent = (raw.questions && raw.questions.length) || raw.html || raw.htmlFile;
  if (!suppliedSpec && !hasContent) {
    throw new CliError(
      mode === 'show'
        ? 'show needs --html-file <file>, --html "<markup>", or --file <spec.json>. Run `rly agent` for examples.'
        : 'ask needs a spec: --file <spec.json>, --file - (stdin), or -q "label::type::opt1,opt2". Run `rly agent` for examples.'
    );
  }
  return raw;
}

export function readFileOrThrow(p) {
  try {
    return fs.readFileSync(path.resolve(p), 'utf8');
  } catch {
    throw new CliError(`cannot read file "${p}".`);
  }
}

export async function runOrDetach(record, args) {
  await assertSpecReady(record.spec);
  const timeoutSec = args.timeout !== undefined ? Math.max(0, Number.parseInt(args.timeout, 10) || 0) : DEFAULT_BOARD_TIMEOUT_SEC;
  const port = args.port !== undefined ? Number.parseInt(args.port, 10) || 0 : 0;
  const open = args.open !== false;
  const link = linkSetting({ args, config: loadConfig(HOME) });

  // Push-wake: persist the agent's --on-result command on the record so BOTH
  // the inline runBoard path and the detached __serve path pick it up (the
  // detached server reads record.onResult from disk). Runtime concern only —
  // not part of the spec.
  if (typeof args.onResult === 'string' && args.onResult.trim()) {
    record.onResult = args.onResult;
    saveBoard(record);
  }

  if (args.detach) {
    const child = spawn(
      process.execPath,
      [
        BIN, '__serve',
        '--id', record.id,
        '--port', String(port),
        '--timeout', String(timeoutSec),
        ...(open ? [] : ['--no-open']),
        '--link', serializeLink(link),
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    // A link setting adds a link-provider round trip before the board is announced.
    const startSec = link.mode === 'off' ? 8 : 40;
    const info = await pollFor(() => loadRunning(record.id), startSec * 1000);
    if (!info) throw new CliError(`board ${record.id} failed to start (no server after ${startSec}s).`, 1);
    printJson({
      status: 'open',
      boardId: record.id,
      url: info.url,
      port: info.port,
      hint: record.spec.responseRequired === false
        ? 'display-only board opened; no response will be collected'
        : `block for the answers with: rly wait ${record.id}`,
    });
    return 0;
  }

  const { done } = await runBoard({ id: record.id, port, open, timeoutSec, link });
  const result = await done;
  printResult(result);
  return exitCodeFor(result.status);
}
