import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, sleep, pollFor } from './util.js';
import { assertSpecReady, normalizeSpec, questionFromInline, SPEC_SCHEMA } from './spec.js';
import {
  createBoard,
  loadBoard,
  saveBoard,
  deleteBoard,
  listBoards,
  listRunning,
  loadRunning,
  removeRunning,
  isAlive,
  saveResultFile,
  HOME,
} from './store.js';
import { runBoard } from './server.js';
import { runMcp, runMcpHttp, mcpConfig } from './mcp.js';
import { openUrl } from './open.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const BIN = path.join(PKG_ROOT, 'bin', 'rly.js');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const VERSION = PKG_JSON.version;
const PKG_NAME = PKG_JSON.name; // e.g. "@khanglvm/relay" — the global package to upgrade

const VALUED_FLAGS = new Set([
  'file', 'html', 'html-file', 'title', 'intro', 'timeout', 'port',
  'submit-label', 'height', 'limit', 'target', 'id', 'replies',
  'on-result', 'notify-cmd', 'idle-grace', 'scope', 'range',
  'host', 'token', 'allow-origin',
]);

function camel(key) {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const args = { _: [], q: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-q' || t === '--question') {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${t} needs a value.`);
      args.q.push(v);
    } else if (t === '-') {
      args.stdin = true;
    } else if (t.startsWith('--')) {
      let key = t.slice(2);
      let val = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (VALUED_FLAGS.has(key)) {
        val = argv[++i];
        if (val === undefined) throw new CliError(`--${key} needs a value.`);
      }
      if (key === 'no-open') {
        args.open = false;
      } else {
        args[camel(key)] = val;
      }
    } else {
      args._.push(t);
    }
  }
  return args;
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// Print a terminal result. A board with many annotations produces a large JSON
// payload, and an agent's shell harness commonly truncates long stdout — so the
// agent silently misses annotations past the cut. We write the FULL result to a
// sidecar file and surface its path FIRST (`resultFile`), so even a truncated
// stdout shows where the complete payload is; the agent reads that file with its
// file tool. Falls back to a plain print if the sidecar can't be written.
function printResult(result) {
  const resultFile = result && result.boardId ? saveResultFile(result.boardId, result) : null;
  printJson(resultFile ? { resultFile, ...result } : result);
}

// Push-wake for `rly wait --notify-cmd`: run the agent's local shell command
// once a TERMINAL result lands. Result JSON goes to the command's stdin;
// RLY_BOARD_ID / RLY_STATUS / RLY_URL are exported. Same shape as the server's
// --on-result hook. Failures are swallowed; a 30s kill timer caps a hung cmd.
function runNotifyCmd(cmd, result) {
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

function exitCodeFor(status) {
  return { submitted: 0, acknowledged: 0, open: 0, timeout: 2, cancelled: 3 }[status] ?? 1;
}

function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`invalid JSON in ${where}: ${err.message}`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function mustLoad(id) {
  if (!id) throw new CliError('missing <board-id>. See `rly history` for saved boards.');
  const record = loadBoard(id);
  if (!record) throw new CliError(`board "${id}" not found. See \`rly history\`.`, 5);
  return record;
}

async function resolveSpecInput(args, mode) {
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

function readFileOrThrow(p) {
  try {
    return fs.readFileSync(path.resolve(p), 'utf8');
  } catch {
    throw new CliError(`cannot read file "${p}".`);
  }
}

async function runOrDetach(record, args) {
  await assertSpecReady(record.spec);
  const timeoutSec = args.timeout !== undefined ? Math.max(0, Number.parseInt(args.timeout, 10) || 0) : 1800;
  const port = args.port !== undefined ? Number.parseInt(args.port, 10) || 0 : 0;
  const open = args.open !== false;

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
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    const info = await pollFor(() => loadRunning(record.id), 8000);
    if (!info) throw new CliError(`board ${record.id} failed to start (no server after 8s).`, 1);
    printJson({
      status: 'open',
      boardId: record.id,
      url: info.url,
      port: info.port,
      hint: `block for the answers with: rly wait ${record.id}`,
    });
    return 0;
  }

  const { done } = await runBoard({ id: record.id, port, open, timeoutSec });
  const result = await done;
  printResult(result);
  return exitCodeFor(result.status);
}

async function cmdAsk(args, mode) {
  const raw = await resolveSpecInput(args, mode);
  const spec = normalizeSpec(raw);
  await assertSpecReady(spec);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}

// `rly diff [git args…]` — run `git diff` for the user and open the result as a
// diff-block board in one step (sugar like `rly view`). Everything that isn't a
// recognized rly flag is forwarded to git verbatim, so `rly diff --staged`,
// `rly diff HEAD~1`, `rly diff main -- src/` all work. rly flags: --detach,
// --no-open, --split (side-by-side), --title.
async function cmdDiff(rest) {
  const RLY_FLAGS = new Set(['--detach', '--no-open', '--split']);
  const gitArgs = [];
  const rlyArgv = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--title') { rlyArgv.push(t, rest[++i]); continue; }
    if (t.startsWith('--title=')) { rlyArgv.push(t); continue; }
    if (RLY_FLAGS.has(t)) { rlyArgv.push(t); continue; }
    gitArgs.push(t);
  }
  const args = parseArgs(rlyArgv);
  const res = spawnSync('git', ['--no-pager', 'diff', ...gitArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new CliError(`could not run git: ${res.error.message}. Is git installed and is this a repo?`);
  if (res.status !== 0 && res.stderr) throw new CliError(`git diff failed: ${res.stderr.trim()}`, res.status || 1);
  const diff = res.stdout || '';
  if (!diff.trim()) {
    printJson({ status: 'no-diff', hint: `git diff${gitArgs.length ? ' ' + gitArgs.join(' ') : ''} produced no output — nothing to show` });
    return 0;
  }
  const title = args.title || ('git diff' + (gitArgs.length ? ' ' + gitArgs.join(' ') : ''));
  const spec = normalizeSpec({ title, blocks: [{ type: 'diff', diff, view: args.split ? 'split' : 'unified' }] });
  await assertSpecReady(spec);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}

function runGit(args, message) {
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new CliError(`could not run git: ${res.error.message}. Is git installed and is this a repo?`);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new CliError(`${message}: ${detail || `git ${args.join(' ')} exited ${res.status}`}`, res.status || 1);
  }
  return res.stdout || '';
}

function gitConflictPaths(explicitPaths) {
  if (explicitPaths.length) return explicitPaths;
  const out = runGit(['diff', '--name-only', '--diff-filter=U'], 'git conflict detection failed');
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function gitCommitRows(range, limit) {
  const n = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 20));
  const args = ['log', `-n${n}`, '--date=short', '--pretty=format:%H%x09%h%x09%ad%x09%an%x09%s'];
  if (range) args.push(range);
  return runGit(args, 'git log failed')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, short, date, author, ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t');
      return { sha, short, date, author, subject };
    })
    .filter((r) => r.sha && r.short);
}

function gitCommitDiff(commit) {
  return runGit([
    '--no-pager',
    'show',
    '--format=',
    '--patch',
    '--find-renames',
    '--find-copies',
    '--no-ext-diff',
    commit,
  ], `git show ${commit} failed`).trimEnd();
}

async function cmdGit(rest) {
  const args = parseArgs(rest);
  const modes = new Set(['pick', 'cherry-pick', 'cherrypick', 'conflict', 'conflicts', 'resolve']);
  let mode = 'pick';
  if (args._[0] && modes.has(args._[0])) mode = args._.shift();
  if (mode === 'cherrypick') mode = 'cherry-pick';
  if (mode === 'conflicts' || mode === 'resolve') mode = 'conflict';

  const blocks = [];
  const questions = [];
  let reviewDiffCount = 0;

  if (mode === 'pick' || mode === 'cherry-pick') {
    const range = args.range || args._[0] || '';
    const commits = gitCommitRows(range, args.limit);
    if (!commits.length) throw new CliError(`git log${range ? ` ${range}` : ''} produced no commits to show.`);
    const withCode = args.code === true || args.patch === true || args.diff === true;
    blocks.push({
      type: 'table',
      columns: ['short', 'date', 'author', 'subject'],
      rows: commits.map((c) => ({ short: c.short, date: c.date, author: c.author, subject: c.subject })),
      sortable: true,
      filterable: true,
      exportable: true,
    });
    const options = commits.map((c) => ({
      value: c.sha,
      label: `${c.short} ${c.subject}`,
      description: `${c.date} · ${c.author}`,
    }));
    questions.push({
      id: 'commit_actions',
      type: 'checklist',
      label: mode === 'cherry-pick' ? 'Choose cherry-pick actions' : 'Choose commit actions',
      description: 'Set only the commits you want the agent to act on.',
      options,
      statuses: mode === 'cherry-pick'
        ? [{ value: 'cherry-pick', label: 'Cherry-pick', tone: 'ok' }, { value: 'skip', label: 'Skip', tone: 'muted' }, { value: 'hold', label: 'Hold', tone: 'warn' }]
        : [{ value: 'pick', label: 'Pick', tone: 'ok' }, { value: 'cherry-pick', label: 'Cherry-pick', tone: 'warn' }, { value: 'drop', label: 'Drop', tone: 'bad' }],
    });
    if (options.length > 1) {
      questions.push({
        id: 'commit_order',
        type: 'rank',
        label: mode === 'cherry-pick' ? 'Cherry-pick order' : 'Preferred commit order',
        description: 'Drag or move commits into the order the agent should apply them.',
        options,
      });
    }
    if (withCode) {
      for (const c of commits) {
        const diff = gitCommitDiff(c.sha);
        if (!diff.trim()) continue;
        blocks.push({
          type: 'diff',
          title: `${c.short} ${c.subject}`,
          filename: `${c.short} ${c.subject}`,
          commit: c.sha,
          reviewKind: mode,
          review: true,
          view: 'split',
          diff,
        });
        reviewDiffCount++;
      }
    }
  }

  const paths = mode === 'conflict' ? gitConflictPaths(args._) : gitConflictPaths([]);
  for (const p of paths) {
    let text = '';
    try { text = fs.readFileSync(path.resolve(p), 'utf8'); } catch { /* normalizeSpec will report unreadable explicit files below */ }
    if (!text || /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/.test(text)) {
      blocks.push({ type: 'git-conflict', path: p, filename: p });
    }
  }

  if (mode === 'conflict' && !blocks.some((b) => b.type === 'git-conflict')) {
    throw new CliError(args._.length
      ? 'no conflict markers found in the provided file(s).'
      : 'no unmerged git files with conflict markers were detected.');
  }

  const conflictCount = blocks.filter((b) => b.type === 'git-conflict').length;
  const title = args.title || (mode === 'conflict'
    ? `Resolve ${conflictCount} git conflict${conflictCount === 1 ? '' : 's'}`
    : mode === 'cherry-pick' ? 'Cherry-pick commits' : 'Pick commits');
  const intro = args.intro || (conflictCount
    ? 'Resolve each conflict on the board. The submitted result includes result.blockEdits with per-hunk choices and a full resolved file preview for every conflict block.'
    : reviewDiffCount
      ? 'Review commit code hunks on the board. Apply, skip, or hold each hunk; submit returns commit actions plus diff-review hunk choices as JSON.'
      : 'Pick commit actions and order on the board. Submit returns the selected actions and rank order as JSON.');
  const spec = normalizeSpec({ title, intro, blocks, questions, submitLabel: 'Submit git choices' });
  await assertSpecReady(spec);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}

// `rly view <file.md> [more.md …]` — quick read-only board that renders files
// with purpose-built blocks (markdown, data tables, PDF). With 2+ files a small
// filename heading separates them. Sugar over `rly show`.
async function cmdView(args) {
  const files = args._;
  if (!files.length) throw new CliError('usage: rly view <file.md|.csv|.json|.pdf> [more …] [--title T] [--detach]');
  const multi = files.length > 1;
  const DATA_EXT = new Set(['csv', 'tsv', 'json']);
  const blocks = [];
  for (const f of files) {
    if (multi) blocks.push({ type: 'markdown', md: `## ${path.basename(f)}` });
    const ext = path.extname(f).slice(1).toLowerCase();
    if (DATA_EXT.has(ext)) blocks.push({ type: 'table', rowsFile: f, sortable: true, filterable: true, exportable: true });
    else if (ext === 'pdf') blocks.push({ type: 'pdf', src: f, title: path.basename(f) });
    else blocks.push({ type: 'markdown', mdFile: f });
  }
  const raw = { blocks };
  raw.title = args.title || (multi ? `${files.length} files` : path.basename(files[0]));
  raw.submitLabel = args.submitLabel || 'Done';
  const spec = normalizeSpec(raw); // reads + validates each file, clear error if unreadable
  await assertSpecReady(spec);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}

// Seeds the draft from the last result (as runBoard would on reopen) and
// appends agent replies to the matching annotations, so an agent can ANSWER
// the user's element comments and re-open the board as a conversation.
// Persists the record with the result archived so runBoard doesn't re-seed.
function seedAgentReplies(record, replies) {
  if (!Array.isArray(replies)) throw new CliError('--replies file must be a JSON array of {annotationId, text}.', 4);
  // Mirror runBoard's reopen draft-seeding from the prior result.
  if (record.result) {
    if (record.result.answers) {
      record.draft = {
        answers: record.result.answers,
        comment: record.result.comment || '',
        notes: record.result.notes || {},
        annotations: record.result.annotations || [],
        updatedAt: new Date().toISOString(),
      };
    }
    record.pastResults = [...(record.pastResults || []), record.result].slice(-10);
    record.result = null;
  }
  const annotations = (record.draft && Array.isArray(record.draft.annotations)) ? record.draft.annotations : [];
  const validIds = annotations.map((a) => a && a.id).filter(Boolean);
  const now = new Date().toISOString();
  replies.forEach((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new CliError(`--replies[${i}]: must be an object {annotationId, text}.`, 4);
    }
    const annotationId = typeof r.annotationId === 'string' ? r.annotationId : '';
    const text = typeof r.text === 'string' ? r.text : '';
    if (!annotationId) throw new CliError(`--replies[${i}]: missing "annotationId".`, 4);
    if (!text.trim()) throw new CliError(`--replies[${i}]: missing "text".`, 4);
    const ann = annotations.find((a) => a && a.id === annotationId);
    if (!ann) {
      throw new CliError(
        `--replies[${i}]: unknown annotationId "${annotationId}". Valid ids: ${validIds.length ? validIds.join(', ') : '(none)'}.`,
        4
      );
    }
    if (!Array.isArray(ann.replies)) ann.replies = [];
    ann.replies.push({ author: 'agent', text, createdAt: now });
  });
  if (!record.draft) record.draft = { answers: {}, comment: '', notes: {}, annotations, updatedAt: now };
  else record.draft.annotations = annotations;
  saveBoard(record);
}

async function cmdReopen(args) {
  const record = mustLoad(args._[0]);
  if (args.replies !== undefined) {
    const replies = parseJson(readFileOrThrow(args.replies), args.replies);
    seedAgentReplies(record, replies);
  }
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    openUrl(running.url);
    printJson({ status: 'open', boardId: record.id, url: running.url, note: 'already running — browser re-opened' });
    return 0;
  }
  // Reuse the board's last port (unless the user forced one) so a tab still open
  // from a previous run reconnects on its own instead of being stranded on a
  // dead port. runBoard falls back to a random port if it's been taken.
  return runOrDetach(record, { ...args, port: args.port ?? record.lastPort });
}

// Rescue a board whose browser tab is still open but disconnected (its server
// died / the machine slept). Re-serves the SAME board on the SAME port it last
// used, so the open tab's relative /api/* fetches reconnect on their own — the
// page's recovery loop lifts its "connection lost" block and re-flushes the
// draft (incl. anything the user mirrored to localStorage during the outage)
// with zero action from the user. Defaults to NOT opening a new browser tab
// (the point is the existing one); pass --open to also open a fresh tab.
async function cmdRescue(args) {
  const record = mustLoad(args._[0]);
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    if (args.open) openUrl(running.url);
    printJson({
      status: 'open',
      boardId: record.id,
      url: running.url,
      port: running.port,
      note: 'already running — the open tab should be connected; reload it if not',
    });
    return 0;
  }
  if (!record.lastPort) {
    throw new CliError(
      `board "${record.id}" has no known port to reuse (never served in this version). Use \`rly reopen ${record.id}\` instead.`,
      5
    );
  }
  // Force the original port so the disconnected tab can reconnect; default to
  // not opening a second tab. seedAgentReplies parity with reopen if provided.
  if (args.replies !== undefined) {
    const replies = parseJson(readFileOrThrow(args.replies), args.replies);
    seedAgentReplies(record, replies);
  }
  return runOrDetach(record, { ...args, port: record.lastPort, open: args.open === true });
}

async function cmdReuse(args) {
  const src = mustLoad(args._[0]);
  if (args.dump) {
    console.log(JSON.stringify(src.spec, null, 2));
    return 0;
  }
  const record = createBoard(src.spec);
  return runOrDetach(record, args);
}

// Live-mutates a running board: rebuild the spec (full replace via --file, or
// patch the current spec via --title/--intro/-q), then POST it (already
// normalized) to the board's /api/update with the per-board mutation token.
async function cmdUpdate(args) {
  const id = args._[0];
  if (!id) throw new CliError('usage: rly update <board-id> (--file new-spec.json | --title T | --intro I | -q "...")');
  const record = loadBoard(id);
  if (!record) throw new CliError(`board "${id}" not found. See \`rly history\`.`, 5);
  const running = loadRunning(id);
  if (!running || !isAlive(running.pid)) {
    throw new CliError(`board "${id}" is not running — \`rly reopen ${id}\` to serve it, then update.`, 5);
  }

  let spec;
  if (args.file) {
    const raw =
      args.file === '-'
        ? parseJson(await readStdin(), 'stdin')
        : parseJson(readFileOrThrow(args.file), args.file);
    spec = normalizeSpec(raw);
  } else if (args.title || args.intro || args.q.length) {
    // Patch the CURRENT spec, then re-normalize so it's a clean normalized spec.
    const raw = { ...record.spec };
    if (args.title) raw.title = args.title;
    if (args.intro) raw.intro = args.intro;
    if (args.q.length) {
      raw.questions = [...(raw.questions || []), ...args.q.map((s, i) => questionFromInline(s, i))];
    }
    spec = normalizeSpec(raw);
  } else {
    throw new CliError('update needs --file <spec.json>, --title, --intro, or -q "...".', 4);
  }
  await assertSpecReady(spec);

  let res;
  try {
    res = await fetch(new URL('/api/update', running.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-token': running.token || '' },
      body: JSON.stringify({ spec }),
    });
  } catch (err) {
    throw new CliError(`could not reach board "${id}" at ${running.url}: ${String((err && err.message) || err)}`, 5);
  }
  if (res.status === 403) throw new CliError(`board "${id}" rejected the update token (stale running file?).`, 5);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch {
      // non-JSON body
    }
    throw new CliError(`board "${id}" rejected the update${detail ? `: ${detail}` : ''}.`, 4);
  }
  const body = await res.json();
  printJson({ status: 'updated', boardId: id, rev: body.rev, url: running.url });
  return 0;
}

// Best-effort fetch of /api/presence for a running board. Returns the parsed
// presence object, or null on any failure / timeout (500ms cap via
// AbortController). Never throws.
async function fetchPresence(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(new URL('/api/presence', url), { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function cmdWait(args) {
  const id = args._[0];
  if (!id) throw new CliError('usage: rly wait <board-id> [--timeout <sec>] [--while-active] [--idle-grace <sec>] [--notify-cmd <cmd>]');
  const timeoutSec = args.timeout !== undefined ? Math.max(1, Number.parseInt(args.timeout, 10) || 1) : 3600;
  const whileActive = args.whileActive === true;
  const idleGrace = args.idleGrace !== undefined ? Math.max(0, Number.parseInt(args.idleGrace, 10) || 0) : 180;
  const notifyCmd = typeof args.notifyCmd === 'string' && args.notifyCmd.trim() ? args.notifyCmd : null;
  let deadline = Date.now() + timeoutSec * 1000;
  mustLoad(id);

  // Push-wake: run the agent's --notify-cmd after a TERMINAL result, then print.
  const finishResult = (result) => {
    if (notifyCmd) runNotifyCmd(notifyCmd, result);
    printResult(result);
    return exitCodeFor(result.status);
  };

  while (Date.now() < deadline) {
    const record = mustLoad(id);
    if (record.result && record.result.finishedAt) {
      return finishResult(record.result);
    }
    const running = loadRunning(id);
    if (!running || !isAlive(running.pid)) {
      await sleep(700); // the result write may be racing the process exit
      const again = loadBoard(id);
      if (again?.result?.finishedAt) {
        return finishResult(again.result);
      }
      printResult({
        status: 'lost',
        boardId: id,
        draft: again?.draft ?? null,
        error: 'board server exited without writing a result',
      });
      return 5;
    }
    if (Date.now() >= deadline) break;
    await sleep(400);
  }

  // Deadline hit while the board is still OPEN. Fetch presence (cheaply).
  const running = loadRunning(id);
  const presence = running && isAlive(running.pid) ? await fetchPresence(running.url) : null;

  // --while-active: if the user is present + recently active, EXTEND and keep
  // waiting (repeat indefinitely while they stay active).
  if (
    whileActive &&
    presence &&
    presence.seen &&
    (presence.visible || presence.focused) &&
    presence.secondsSinceActivity < idleGrace
  ) {
    deadline = Date.now() + Math.min(idleGrace, 120) * 1000;
    return cmdWaitLoop(id, deadline, { whileActive, idleGrace, notifyCmd });
  }

  const out = {
    status: 'wait-timeout',
    boardId: id,
    hint: `board is still open — run \`rly wait ${id}\` again, or \`rly result ${id}\` to peek at the live draft`,
  };
  if (presence) out.presence = presence;
  printJson(out);
  return 2;
}

// Continuation loop for `rly wait --while-active` after a deadline extension.
// Identical waiting logic to cmdWait's main loop, then re-evaluates presence;
// extends again while the user stays active, otherwise emits wait-timeout.
async function cmdWaitLoop(id, deadline, opts) {
  const { whileActive, idleGrace, notifyCmd } = opts;
  const finishResult = (result) => {
    if (notifyCmd) runNotifyCmd(notifyCmd, result);
    printResult(result);
    return exitCodeFor(result.status);
  };
  while (Date.now() < deadline) {
    const record = mustLoad(id);
    if (record.result && record.result.finishedAt) {
      return finishResult(record.result);
    }
    const running = loadRunning(id);
    if (!running || !isAlive(running.pid)) {
      await sleep(700);
      const again = loadBoard(id);
      if (again?.result?.finishedAt) {
        return finishResult(again.result);
      }
      printResult({
        status: 'lost',
        boardId: id,
        draft: again?.draft ?? null,
        error: 'board server exited without writing a result',
      });
      return 5;
    }
    if (Date.now() >= deadline) break;
    await sleep(400);
  }
  const running = loadRunning(id);
  const presence = running && isAlive(running.pid) ? await fetchPresence(running.url) : null;
  if (
    whileActive &&
    presence &&
    presence.seen &&
    (presence.visible || presence.focused) &&
    presence.secondsSinceActivity < idleGrace
  ) {
    const next = Date.now() + Math.min(idleGrace, 120) * 1000;
    return cmdWaitLoop(id, next, opts);
  }
  const out = {
    status: 'wait-timeout',
    boardId: id,
    hint: `board is still open — run \`rly wait ${id}\` again, or \`rly result ${id}\` to peek at the live draft`,
  };
  if (presence) out.presence = presence;
  printJson(out);
  return 2;
}

async function cmdResult(args) {
  const record = mustLoad(args._[0]);
  if (record.result && record.result.finishedAt) {
    printResult(record.result);
    return exitCodeFor(record.result.status);
  }
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    // While open, expose the real-time autosaved draft so agents can peek, plus
    // best-effort presence (whether the user is still viewing/focused/active).
    const out = { status: 'open', boardId: record.id, url: running.url, draft: record.draft ?? null };
    const presence = await fetchPresence(running.url);
    if (presence) out.presence = presence;
    printResult(out); // draft can hold many annotations — sidecar it too
    return 0;
  }
  printResult({ status: 'lost', boardId: record.id, draft: record.draft ?? null });
  return 5;
}

function cmdList(args) {
  const running = listRunning();
  if (args.json) {
    printJson(running);
    return 0;
  }
  if (!running.length) {
    console.log('No boards running.');
    return 0;
  }
  for (const r of running) {
    console.log(`${r.id}  ${r.url}  pid ${r.pid}  "${r.title}"  since ${r.startedAt}`);
  }
  return 0;
}

function cmdOpen(args) {
  let id = args._[0];
  const running = listRunning();
  if (!id) {
    if (running.length === 1) id = running[0].id;
    else if (running.length === 0) throw new CliError('no boards running. Use `rly reopen <id>` to serve a saved one.', 5);
    else throw new CliError(`multiple boards running — pick one: ${running.map((r) => r.id).join(', ')}`);
  }
  const info = running.find((r) => r.id === id);
  if (!info) throw new CliError(`board "${id}" is not running. Use \`rly reopen ${id}\` to serve it again (with saved answers).`, 5);
  openUrl(info.url);
  printJson({ status: 'open', boardId: id, url: info.url });
  return 0;
}

async function cmdStop(args) {
  let targets;
  if (args.all) {
    targets = listRunning();
    if (!targets.length) {
      printJson({ stopped: [] });
      return 0;
    }
  } else {
    const id = args._[0];
    if (!id) throw new CliError('usage: rly stop <board-id> | rly stop --all');
    const info = loadRunning(id);
    if (!info || !isAlive(info.pid)) {
      removeRunning(id);
      throw new CliError(`board "${id}" is not running.`, 5);
    }
    targets = [info];
  }
  for (const t of targets) {
    try {
      process.kill(t.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  for (const t of targets) {
    await pollFor(() => (loadRunning(t.id) ? null : true), 5000);
  }
  printJson({
    stopped: targets.map((t) => {
      const record = loadBoard(t.id);
      return { boardId: t.id, status: record?.result?.status ?? 'unknown', draft: record?.draft ?? null };
    }),
  });
  return 0;
}

function cmdHistory(args) {
  const limit = args.limit !== undefined ? Number.parseInt(args.limit, 10) || 15 : 15;
  const records = listBoards(limit);
  const runningIds = new Set(listRunning().map((r) => r.id));
  if (args.json) {
    printJson(
      records.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        title: r.title,
        status: runningIds.has(r.id) ? 'open' : r.result?.status ?? 'unfinished',
        questions: r.spec.questions.length,
        blocks: (r.spec.blocks || []).length,
        hasDraft: Boolean(r.draft),
        answers: r.result?.answers ?? null,
      }))
    );
    return 0;
  }
  if (!records.length) {
    console.log(`No saved boards yet (storage: ${HOME}).`);
    return 0;
  }
  for (const r of records) {
    const status = runningIds.has(r.id) ? 'open' : r.result?.status ?? 'unfinished';
    const nBlocks = (r.spec.blocks || []).length;
    console.log(`${r.id}  ${r.createdAt}  [${status}]  "${r.title}"  ${r.spec.questions.length}q${nBlocks ? `+${nBlocks}b` : ''}`);
  }
  console.log(`\nReuse: \`rly reuse <id>\` · spec: \`rly spec <id>\` · reopen w/ answers: \`rly reopen <id>\` · delete: \`rly rm <id>\``);
  return 0;
}

function cmdSpec(args) {
  const record = mustLoad(args._[0]);
  console.log(JSON.stringify(record.spec, null, 2));
  return 0;
}

function cmdRm(args) {
  const runningIds = new Set(listRunning().map((r) => r.id));
  if (args.all) {
    let removed = 0;
    for (const r of listBoards(0)) {
      if (runningIds.has(r.id)) continue;
      if (deleteBoard(r.id)) removed++;
    }
    printJson({ removed, skippedRunning: runningIds.size });
    return 0;
  }
  const id = args._[0];
  if (!id) throw new CliError('usage: rly rm <board-id> | rly rm --all');
  if (runningIds.has(id)) throw new CliError(`board "${id}" is running — \`rly stop ${id}\` first.`);
  if (!deleteBoard(id)) throw new CliError(`board "${id}" not found.`, 5);
  printJson({ removed: id });
  return 0;
}

const SKILL_SRC = path.join(PKG_ROOT, 'skills', 'relay');

const KNOWN_SKILL_DIRS = () => ({
  claude: path.join(os.homedir(), '.claude', 'skills', 'relay'),
  codex: path.join(os.homedir(), '.codex', 'skills', 'relay'),
  // The cross-agent skills dir (npx-skills ecosystem). Some Codex/agent
  // setups load skills from here INSTEAD of ~/.codex/skills.
  agents: path.join(os.homedir(), '.agents', 'skills', 'relay'),
});

// Pre-rename skill dirs (quest-board). `skill install` removes these so a
// stale copy doesn't shadow the renamed one.
const LEGACY_SKILL_DIRS = () => [
  path.join(os.homedir(), '.claude', 'skills', 'quest-board'),
  path.join(os.homedir(), '.codex', 'skills', 'quest-board'),
];

// One-time stderr nudge so agents that only have the CLI discover the skill.
function firstRunHint() {
  try {
    const marker = path.join(HOME, '.hinted');
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    const installed = Object.values(KNOWN_SKILL_DIRS()).some((p) => fs.existsSync(path.join(p, 'SKILL.md')));
    if (!installed) {
      process.stderr.write(
        'tip (AI agents): rly bundles a universal skill — install it with `rly skill install`; full guide: `rly agent`\n'
      );
    }
  } catch {
    // never let the hint break a real command
  }
}

// Installed skill copies are snapshots — warn when they lag the CLI.
function skillFreshnessWarning() {
  try {
    for (const [agent, dir] of Object.entries(KNOWN_SKILL_DIRS())) {
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      let installedVersion = null;
      try {
        installedVersion = fs.readFileSync(path.join(dir, '.rly-version'), 'utf8').trim();
      } catch {
        // pre-rename install without a version marker
      }
      if (installedVersion !== VERSION) {
        process.stderr.write(
          `note: the relay skill installed for ${agent} is from rly ${installedVersion ?? '<0.2.0'}, you run ${VERSION} — refresh with \`rly skill install\`\n`
        );
      }
    }
  } catch {
    // best effort only
  }
}

function skillTargets(target) {
  const known = KNOWN_SKILL_DIRS();
  if (!target || target === true || target === 'auto') {
    const found = Object.values(known).filter((p) => fs.existsSync(path.dirname(path.dirname(p))));
    if (!found.length) {
      throw new CliError('no agent dirs found (~/.claude, ~/.codex, or ~/.agents). Use --target claude|codex|agents|all|<dir>.');
    }
    return found;
  }
  if (target === 'both' || target === 'all') return Object.values(known);
  if (known[target]) return [known[target]];
  return [path.join(path.resolve(target), 'relay')];
}

// Removes stale pre-rename quest-board skill dirs so the renamed skill is the
// only one an agent sees. Returns the dirs actually removed.
function removeLegacySkills() {
  const removed = [];
  for (const dir of LEGACY_SKILL_DIRS()) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      // best effort — a leftover dir we couldn't remove shouldn't fail install
    }
  }
  return removed;
}

// Stamps the current CLI version into every installed skill dir's .rly-version.
// `rly skill install` writes this itself, but an `npx skills add` refresh does
// not — so after any refresh we re-stamp the dirs that now have a SKILL.md,
// keeping skillFreshnessWarning() from nagging about a just-refreshed skill.
function stampSkillVersion() {
  const stamped = [];
  for (const dir of Object.values(KNOWN_SKILL_DIRS())) {
    try {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        fs.writeFileSync(path.join(dir, '.rly-version'), VERSION);
        stamped.push(dir);
      }
    } catch {
      // best effort — a marker we couldn't write just re-triggers the nudge
    }
  }
  return stamped;
}

// Short instruction block for an agent's main instruction file (CLAUDE.md,
// AGENTS.md, …). A skill is only a tier-1 hint that agents can ignore; these
// rules, appended to the instructions the agent always reads, enforce usage.
// Printed to stdout so `rly skill rules >> CLAUDE.md` is the whole install.
const SKILL_RULES = `## relay — show it in the browser, don't dump it in the terminal

**Why:** your output surface — a terminal, an IDE side-panel (VS Code, JetBrains,
Cursor), a plain-text chat — can't actually render a markdown file, an image, a
chart, a table, a diagram, or a diff. It shows them as walls of monospace text, or
not at all (a terminal can't display a PNG). relay opens a real browser board that
renders them properly AND reads the user's reply back as JSON. **Rule of thumb: if
what you're about to output would look better than monospace text — or is a file
the user should view — put it in relay instead of printing it.**

- **Markdown file / doc / README / plan / report** → \`rly view file.md\` (renders it
  in the browser, no library; \`.csv\`/\`.json\` → a sortable table; \`.pdf\` → an
  inline PDF viewer). Never \`cat\` a doc into the terminal for the user to read.
- **Image / screenshot / mockup / diagram / chart / table** → a relay board with an
  \`image\` block (or \`mermaid\`/\`graphviz\`/\`chart\`/\`table\`/\`kpi\`/\`compare\`). The
  terminal can't show pixels; relay can — with click-to-zoom and comment-in-place.
- **The user's decisions, feedback, requirements, or approval** (anything beyond one
  trivial yes/no) → a relay board, NOT plain terminal text and NOT the native
  \`AskUserQuestion\` / ask-user tool. Build a spec and run
  \`rly ask --file spec.json --detach\`, then \`rly wait <boardId>\`. **Holds in plan
  mode too**; reserve \`ExitPlanMode\` for the final plan-approval gate only.
- **Codex-specific browser-board pattern:** Codex does not have a normal,
  user-facing "wake this agent turn from a browser submit" command. In Codex,
  keep the waiter in the foreground until the user submits:
  \`rly ask --file spec.json --detach\` then
  \`rly wait <boardId> --timeout 1800 --while-active --idle-grace 300\`.
  If wait exits with \`wait-timeout\`, immediately run \`rly result <boardId>\`;
  if it is still open and the user may continue, run \`rly wait\` again. Do not
  use \`--on-result\` as the primary Codex return path; normal Codex CLI sessions
  do not expose a portable inbound API that wakes the current agent turn.
- **A plan, structure, architecture, data, or prototype** → a relay board with
  diagram/chart/table/code/image/html blocks — never ASCII diagrams or walls of prose.
- **"Show me the diff / git diff / these changes"** → \`rly diff\` (runs git diff →
  a diff board), or render diff text in a \`diff\` block — never paste a raw diff.
- **Git pick/cherry-pick/conflict decisions** → \`rly git pick\`, \`rly git cherry-pick\`,
  or \`rly git conflict [files]\`. Conflict boards can also be authored with a
  \`git-conflict\` block from inline \`content\` or a local \`file\`/\`path\`; user
  hunk choices come back in \`result.blockEdits[blockId]\` with resolved content.
- Point the user at a file with a clickable local path in a markdown block; embed a
  screen recording with a \`video\` block; when answer choices are visual, give each
  option its own visual (\`options[].blocks\`) so the user picks by looking.
- **There's a purpose-built component for most content — use the MOST SPECIFIC one,
  never plain prose when a block fits.** Blocks: \`table\` (sortable/filterable/CSV,
  load from .csv/.json), \`chart\`, \`kpi\` (stat cards), \`mermaid\`/\`graphviz\`/\`plantuml\`,
  \`code\`, \`diff\`, \`git-conflict\`, \`image\` (+\`pins\`), \`compare\` (before/after), \`video\`, \`pdf\`, \`palette\`,
  \`typography\`, \`html\`. Question types: \`single\`/\`multi\`/\`yesno\`/\`scale\`/\`color\`/
  \`text\`/\`textarea\` plus \`rank\` (prioritize), \`allocate\` (split a budget), \`checklist\`
  (per-item sign-off). For a business user, reach for \`kpi\`+\`chart\`+\`table\` and
  \`rank\`/\`allocate\`/\`checklist\`; full menu + fields: \`rly agent\` and \`rly schema\`.
- Read the result JSON from stdout; treat \`comment\` and \`annotations\` as
  first-class feedback. Full guide: \`rly agent\`.`;

function cmdSkill(rest) {
  const sub = rest[0];
  if (sub === 'rules') {
    console.log(SKILL_RULES);
    return 0;
  }
  if (sub === 'path') {
    console.log(SKILL_SRC);
    process.stderr.write('(bundled skill source — copy into your agent with `rly skill install`)\n');
    return 0;
  }
  if (sub === 'install') {
    const args = parseArgs(rest.slice(1));
    const targets = skillTargets(args.target);
    const installed = [];
    for (const t of targets) {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      // Clear whatever is already there first. cpSync refuses to overwrite a
      // non-directory (a symlink or file at the target — e.g. a skill dir the
      // user symlinked elsewhere) with a directory, so a plain re-install would
      // crash. rmSync on a symlink removes the link itself, not its target.
      fs.rmSync(t, { recursive: true, force: true });
      fs.cpSync(SKILL_SRC, t, { recursive: true });
      fs.writeFileSync(path.join(t, '.rly-version'), VERSION);
      installed.push(t);
    }
    const removedLegacy = removeLegacySkills();
    printJson({ installed, removedLegacy, note: 'most agents pick new skills up immediately; if yours does not, re-list skills or restart the session' });
    return 0;
  }
  console.log(`relay ships a universal agent skill (Claude Code, Codex, and any SKILL.md-aware agent).

  bundled at:  ${SKILL_SRC}
  install it:  rly skill install            # auto-detects ~/.claude, ~/.codex, ~/.agents
               rly skill install --target claude|codex|both|<dir>
  from repo:   npx skills add khanglvm/relay --skill relay --all
  enforce it:  rly skill rules              # short always-read rules — paste into the file your
                                            # agent reads (CLAUDE.md, AGENTS.md, .cursor/rules, …);
                                            # a skill alone is an ignorable hint

The skill teaches your agent the board spec format (questions + rich blocks +
annotations), the blocking vs --detach patterns, and visualization sizing.
Full guide: \`rly agent\`.`);
  return 0;
}

// ===========================================================================
// `rly install` — inject relay's always-read rules into ANY agent's
// instruction file, cross-platform. `rly skill install` (above) handles the
// full SKILL.md for skill-aware agents; this covers the long tail (Cursor,
// Copilot, Kiro, Windsurf, Cline, Gemini, generic AGENTS.md, …) that read a
// rules/instructions/steering/context markdown file instead.
// ===========================================================================

const RELAY_BEGIN = '<!-- relay:begin (managed by `rly install` — your edits outside these markers are kept) -->';
const RELAY_END = '<!-- relay:end -->';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Resolve OS-specific base dirs from an injectable env/home/platform so the
// path logic is unit-testable for win32 / linux / darwin without running there.
function platformDirs({ platform, home, env }) {
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  // Copilot-in-JetBrains global instructions dir.
  const jetbrainsCopilot = platform === 'win32'
    ? path.join(localApp, 'github-copilot', 'intellij')
    : path.join(xdg, 'github-copilot', 'intellij');
  return { xdg, jetbrainsCopilot, documents: path.join(home, 'Documents') };
}

// The relay instruction registry. Each agent declares how to install relay's
// rules at `global` (user, machine-wide) and/or `project` (cwd) scope, in what
// `style`, and a `detect` dir whose existence means "you use this agent"
// (drives `--all`). Styles:
//   'shared'    — upsert a marked block into a possibly-shared file (CLAUDE.md,
//                 AGENTS.md, copilot-instructions.md, …); your other content is
//                 preserved, only relay's block is rewritten.
//   'dedicated' — relay owns the whole file (.kiro/steering, .windsurf/rules,
//                 .clinerules, …); safe to overwrite.
//   'mdc'       — dedicated, with Cursor `.mdc` YAML frontmatter.
export function agentRegistry({ platform = process.platform, home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const d = platformDirs({ platform, home, env });
  const j = path.join;
  return [
    { id: 'claude', label: 'Claude Code',
      detect: j(home, '.claude'),
      global: { file: j(home, '.claude', 'CLAUDE.md'), style: 'shared' },
      project: { file: j(cwd, 'CLAUDE.md'), style: 'shared' },
      note: 'full skill: `rly skill install`' },
    { id: 'codex', label: 'OpenAI Codex',
      detect: j(home, '.codex'),
      global: { file: j(home, '.codex', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
    { id: 'agents', label: 'AGENTS.md standard (Amp, Jules, Cline, …)',
      detect: j(home, '.agents'),
      global: { file: j(home, '.agents', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
    { id: 'cursor', label: 'Cursor',
      detect: j(home, '.cursor'),
      global: null, // user rules are set in Cursor Settings UI (not file-based)
      project: { file: j(cwd, '.cursor', 'rules', 'relay.mdc'), style: 'mdc' },
      note: 'global "User Rules" are set in Settings UI, not a file' },
    { id: 'copilot', label: 'GitHub Copilot (VS Code / Visual Studio / JetBrains)',
      detect: path.dirname(d.jetbrainsCopilot), // …/github-copilot
      global: { file: j(d.jetbrainsCopilot, 'global-copilot-instructions.md'), style: 'shared' },
      project: { file: j(cwd, '.github', 'copilot-instructions.md'), style: 'shared' },
      note: 'global file applies in JetBrains IDEs; project file applies everywhere' },
    { id: 'kiro', label: 'Kiro',
      detect: j(home, '.kiro'),
      global: { file: j(home, '.kiro', 'steering', 'relay.md'), style: 'dedicated' },
      project: { file: j(cwd, '.kiro', 'steering', 'relay.md'), style: 'dedicated' } },
    { id: 'windsurf', label: 'Windsurf',
      detect: j(home, '.codeium'),
      global: { file: j(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), style: 'shared' },
      project: { file: j(cwd, '.windsurf', 'rules', 'relay.md'), style: 'dedicated' } },
    { id: 'cline', label: 'Cline',
      detect: j(d.documents, 'Cline'),
      global: { file: j(d.documents, 'Cline', 'Rules', 'relay.md'), style: 'dedicated' },
      project: { file: j(cwd, '.clinerules', 'relay.md'), style: 'dedicated' } },
    { id: 'gemini', label: 'Gemini CLI',
      detect: j(home, '.gemini'),
      global: { file: j(home, '.gemini', 'GEMINI.md'), style: 'shared' },
      project: { file: j(cwd, 'GEMINI.md'), style: 'shared' } },
    { id: 'opencode', label: 'OpenCode',
      detect: j(d.xdg, 'opencode'),
      global: { file: j(d.xdg, 'opencode', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
    { id: 'droid', label: 'Droid (Factory)',
      detect: j(home, '.factory'),
      global: { file: j(home, '.factory', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
  ];
}

// Render the relay rules in the style the target file expects.
function renderInstruction(style) {
  if (style === 'mdc') {
    return `---\ndescription: relay — collect decisions & show rich visuals in the browser, not the terminal\nalwaysApply: true\n---\n\n${SKILL_RULES}\n`;
  }
  return `${SKILL_RULES}\n`; // dedicated file — relay owns it
}

// Upsert relay's marked block into a (possibly shared / pre-existing) file,
// leaving everything outside the markers untouched. Returns 'added'|'updated'.
function upsertBlock(file, body) {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const wrapped = `${RELAY_BEGIN}\n${body}\n${RELAY_END}`;
  const re = new RegExp(escapeRegExp(RELAY_BEGIN) + '[\\s\\S]*?' + escapeRegExp(RELAY_END));
  const had = re.test(existing);
  const next = had
    ? existing.replace(re, wrapped)
    : (existing.trim() ? existing.replace(/\s*$/, '') + '\n\n' + wrapped + '\n' : wrapped + '\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return had ? 'updated' : 'added';
}

function writeInstruction(target) {
  if (target.style === 'shared') return upsertBlock(target.file, SKILL_RULES);
  const existed = fs.existsSync(target.file);
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, renderInstruction(target.style));
  return existed ? 'updated' : 'added';
}

function cmdInstall(args) {
  const reg = agentRegistry();
  const byId = Object.fromEntries(reg.map((a) => [a.id, a]));
  const scope = args.scope === 'project' ? 'project' : args.scope === 'global' ? 'global' : null;

  // Pick the target for an agent: explicit --scope wins; else prefer global
  // (machine-wide), falling back to project when the agent has no global file.
  const pick = (a) => {
    if (scope === 'project') return a.project ? { scope: 'project', t: a.project } : null;
    if (scope === 'global') return a.global ? { scope: 'global', t: a.global } : null;
    if (a.global) return { scope: 'global', t: a.global };
    if (a.project) return { scope: 'project', t: a.project };
    return null;
  };

  const wantAll = args.all === true || String(args.target || '').toLowerCase() === 'all';

  // No target → show the matrix for THIS platform.
  if (!wantAll && (args.list === true || !args.target)) {
    printJson({
      platform: process.platform,
      agents: reg.map((a) => ({
        agent: a.id, label: a.label,
        global: a.global ? a.global.file : null,
        project: a.project ? a.project.file : null,
        note: a.note,
      })),
      usage: 'rly install --target <agent>[,<agent>] [--scope global|project] [--print] | rly install --all',
    });
    return 0;
  }

  // Resolve the set of {agent, scope, target} to act on.
  let chosen;
  if (wantAll) {
    chosen = reg
      .filter((a) => { try { return fs.existsSync(a.detect); } catch { return false; } })
      .map((a) => ({ a, ...(pick(a) || {}) }))
      .filter((x) => x.t);
    if (!chosen.length) {
      throw new CliError('no known agents detected on this machine (no ~/.claude, ~/.codex, ~/.cursor, ~/.kiro, …). Use --target <agent>.', 4);
    }
  } else {
    const ids = String(args.target).split(',').map((s) => s.trim()).filter(Boolean);
    chosen = [];
    for (const id of ids) {
      const a = byId[id];
      if (!a) throw new CliError(`unknown agent "${id}". Run \`rly install --list\` to see supported agents.`, 4);
      const p = pick(a);
      if (!p) throw new CliError(`${a.label} has no ${scope || 'installable'} instruction file${a.note ? ` — ${a.note}` : ''}. Try \`--scope project\`.`, 4);
      chosen.push({ a, ...p });
    }
  }

  // --print: emit content + resolved path for manual copy/paste; no writes.
  if (args.print === true) {
    for (const { a, t } of chosen) {
      const content = t.style === 'shared' ? `${RELAY_BEGIN}\n${SKILL_RULES}\n${RELAY_END}` : renderInstruction(t.style);
      process.stdout.write(`# ${a.label}\n# → ${t.file}\n\n${content}\n\n`);
    }
    return 0;
  }

  const installed = chosen.map(({ a, scope: sc, t }) => ({
    agent: a.id, scope: sc, file: t.file, action: writeInstruction(t),
  }));
  printJson({ installed, note: 'reload/re-open your agent (or re-list its rules) if it does not pick this up immediately' });
  return 0;
}

function cmdAgent() {
  console.log(fs.readFileSync(path.join(PKG_ROOT, 'docs', 'AGENT.md'), 'utf8'));
  return 0;
}

// `rly upgrade` — install the latest CLI globally AND refresh the skill (via the
// npx-skills package manager, falling back to the bundled copy) in one shot.
// (`update` is taken by the live-mutate command, so this is
// `upgrade` / `self-update`.) Running boards are surfaced and handled: a global
// reinstall overwrites relay's files, but live detached servers snapshot their
// UI at first request and serve from memory, so they keep working on their own
// version. Flags: --stop (stop running boards first), --force (upgrade while
// they keep running), --cli-only / --skill-only (scope).
async function cmdUpgrade(args) {
  const force = args.force === true;
  const doStop = args.stop === true;
  const wantCli = args.skillOnly !== true;
  const wantSkill = args.cliOnly !== true;

  const running = listRunning();

  // --dry-run: report the plan (incl. how running boards would be handled)
  // without installing anything or stopping anything.
  if (args.dryRun === true) {
    printJson({
      dryRun: true,
      wouldRun: [wantCli && `npm install -g ${PKG_NAME}@latest`, wantSkill && 'npx skills add khanglvm/relay --skill relay --all'].filter(Boolean),
      runningBoards: running.map((r) => r.id),
      runningHandling: running.length
        ? doStop
          ? 'stop them first'
          : force
            ? 'leave them running (snapshotted)'
            : 'BLOCKED — pass --stop or --force'
        : 'none running',
    });
    return 0;
  }

  if (running.length) {
    const ids = running.map((r) => r.id).join(', ');
    if (doStop) {
      process.stderr.write(`Stopping ${running.length} running board(s) before upgrading: ${ids}\n`);
      for (const r of running) {
        try { process.kill(r.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      for (const r of running) await pollFor(() => (loadRunning(r.id) ? null : true), 5000);
    } else if (!force) {
      // Default: don't silently overwrite under live boards — explain + let the
      // user choose. The boards themselves are safe; this is about clarity.
      process.stderr.write(
        `${running.length} board(s) still running: ${ids}\n` +
          'They keep serving their current version safely (each snapshots its UI in memory),\n' +
          'and stay readable via `rly result <id>` / `rly wait <id>`. Pick one:\n' +
          '  • rly stop --all       then re-run `rly upgrade`  (cleanest)\n' +
          '  • rly upgrade --stop   stop them as part of this upgrade\n' +
          '  • rly upgrade --force  upgrade now; leave them running on their snapshot\n'
      );
      printJson({ upgraded: false, reason: 'running-boards', running: running.map((r) => r.id) });
      return 0;
    } else {
      process.stderr.write(`--force: leaving ${running.length} board(s) running on their snapshotted version: ${ids}\n`);
    }
  }

  const did = {};

  if (wantCli) {
    process.stderr.write(`\nUpgrading ${PKG_NAME} → latest  (npm install -g ${PKG_NAME}@latest)\n`);
    // shell:true so Windows resolves `npm` → `npm.cmd` (same reason the skill /
    // version spawns below use it); the package name has no shell metacharacters.
    const r = spawnSync('npm', ['install', '-g', `${PKG_NAME}@latest`], { stdio: 'inherit', shell: true });
    if (r.error || r.status !== 0) {
      throw new CliError(
        `npm install failed${r.error ? ` (${r.error.message})` : ` (exit ${r.status})`}. ` +
          `Update manually: npm install -g ${PKG_NAME}@latest`,
        1
      );
    }
    did.cli = `${PKG_NAME}@latest`;
  }

  if (wantSkill) {
    // Refresh the skill through the npx-skills package manager — the same channel
    // the skill is normally managed by (skills-lock.json, ~/.agents, ~/.claude, …)
    // — so the global install stays in sync and pulls the freshest skill for
    // khanglvm/relay. `npx -y` so the one-off download needs no prompt.
    process.stderr.write('\nRefreshing the relay skill  (npx skills add khanglvm/relay --skill relay --all)\n');
    let r = spawnSync('npx', ['-y', 'skills', 'add', 'khanglvm/relay', '--skill', 'relay', '--all'], { stdio: 'inherit', shell: true });
    let how = 'npx-skills';
    if (r.error || r.status !== 0) {
      // Fallback: install the skill bundled with the CLI we just upgraded. Works
      // offline / when the skills CLI is unreachable, and matches this version.
      process.stderr.write('\nnpx skills unavailable — falling back to the bundled skill  (rly skill install)\n');
      r = spawnSync('rly', ['skill', 'install'], { stdio: 'inherit', shell: true });
      how = 'bundled';
    }
    if (r.error || r.status !== 0) {
      process.stderr.write(
        `Skill refresh did not complete${r.error ? ` (${r.error.message})` : ` (exit ${r.status})`} — ` +
          'run `npx skills add khanglvm/relay --skill relay --all` (or `rly skill install`) yourself.\n'
      );
    } else {
      // Keep the freshness marker accurate however the skill landed, so the next
      // `rly` run doesn't nag that the just-refreshed skill is stale.
      stampSkillVersion();
      did.skill = how;
    }
  }

  // Report the now-current global version (best-effort).
  let nowVersion = null;
  try {
    const v = spawnSync('rly', ['--version'], { encoding: 'utf8', shell: true });
    if (v.status === 0 && v.stdout) nowVersion = String(v.stdout).trim();
  } catch {
    // best effort
  }

  printJson({
    upgraded: true,
    ...did,
    version: nowVersion,
    note: 'most agents pick the new skill up immediately; if not, re-list skills or restart the session',
  });
  return 0;
}

// `rly mcp` — run relay as an MCP App server, or print/write the host config.
//   rly mcp                      serve over stdio (what a local desktop host launches)
//   rly mcp --http [--port N]    serve over Streamable HTTP (web/mobile/remote hosts)
//   rly mcp config [--print]     show setup for Claude / Codex / generic hosts
//   rly mcp install --target claude|codex   write it into that host's config
async function cmdMcp(rest) {
  const sub = rest[0];
  if (sub === 'config' || sub === 'setup' || sub === 'install' || sub === 'add') {
    return cmdMcpConfig(parseArgs(rest.slice(1)), sub);
  }
  const args = parseArgs(rest);
  if (args.http) {
    // Port precedence: --port flag, then PaaS-injected $PORT / $RLY_MCP_PORT,
    // then the default. PaaS hosts (Render, Railway, Fly, mcpdeploy, …) set $PORT.
    const envPort = process.env.PORT || process.env.RLY_MCP_PORT;
    return runMcpHttp({
      port: args.port ? Number(args.port) : (envPort ? Number(envPort) : undefined),
      host: typeof args.host === 'string' ? args.host : (process.env.RLY_MCP_HOST || '127.0.0.1'),
      token: typeof args.token === 'string' ? args.token : (process.env.RLY_MCP_TOKEN || ''),
      allowOrigin: typeof args.allowOrigin === 'string' ? args.allowOrigin : (process.env.RLY_MCP_ALLOW_ORIGIN || ''),
    });
  }
  // Default: be the stdio server. main() never resolves this, so the CLI's
  // post-run exit timer never arms — the server lives until stdin closes.
  return runMcp();
}

// Resolve Claude Desktop's config path for this platform.
function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function cmdMcpConfig(args, sub) {
  const cfg = mcpConfig({ command: 'rly' });
  const target = String(args.target || '').toLowerCase();
  const wantInstall = (sub === 'install' || sub === 'add') && args.print !== true;

  // --print, or `config`/`setup` with no writable target: show every option.
  if (!wantInstall || !target) {
    const claudePath = claudeDesktopConfigPath();
    const codexPath = path.join(os.homedir(), '.codex', 'config.toml');
    printJson({
      note: 'Register relay as an MCP App server, then call relay_ask / relay_show from inside the host.',
      claudeCode: 'claude mcp add relay -- rly mcp',
      claudeDesktop: { file: claudePath, add: cfg.json },
      codex: { file: codexPath, add: cfg.toml },
      generic: { add: cfg.json },
      webMobile: cfg.http,
      install: 'rly mcp install --target claude   |   rly mcp install --target codex',
    });
    return 0;
  }

  if (target === 'claude' || target === 'claude-desktop') {
    const file = claudeDesktopConfigPath();
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = {}; }
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    existing.mcpServers = existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {};
    existing.mcpServers.relay = { command: cfg.command, args: cfg.args };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
    printJson({ installed: 'claude-desktop', file, server: 'relay', note: 'restart Claude Desktop to load it' });
    return 0;
  }
  if (target === 'codex') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { body = ''; }
    if (/\[mcp_servers\.relay\]/.test(body)) {
      printJson({ installed: 'codex', file, server: 'relay', note: 'already present — left as-is' });
      return 0;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sep = body && !body.endsWith('\n') ? '\n\n' : body ? '\n' : '';
    fs.writeFileSync(file, body + sep + cfg.toml);
    printJson({ installed: 'codex', file, server: 'relay', note: 'restart Codex to load it' });
    return 0;
  }
  throw new CliError(`unknown --target "${target}". Use claude or codex (or \`rly mcp config\` to print all).`, 4);
}

async function cmdServeInternal(args) {
  const id = args.id;
  if (!id) throw new CliError('__serve: missing --id');
  const { done } = await runBoard({
    id,
    port: args.port !== undefined ? Number.parseInt(args.port, 10) || 0 : 0,
    open: args.open !== false,
    timeoutSec: args.timeout !== undefined ? Math.max(0, Number.parseInt(args.timeout, 10) || 0) : 1800,
    quiet: true,
    // Detached board: timeout hands back to the agent but keeps serving so the
    // user can keep commenting and still submit (seamless past the deadline).
    keepAliveOnTimeout: true,
  });
  await done;
  return 0;
}

function printHelp() {
  console.log(`rly ${VERSION} — relay: browser question boards, rich blocks & annotations for AI agents

USAGE
  rly ask --file spec.json            create board, open browser, BLOCK until submit, print answers JSON
  rly ask --file - < spec.json        spec from stdin
  rly ask -q "Deploy?::yesno" -q "!Env::single::dev,staging,prod"
                                      quick inline questions ("!" = required, label::type::options)
  rly ask ... --detach                no blocking: prints {boardId,url} now; collect via \`rly wait <id>\`
  rly ask ... --on-result "<cmd>"     push-wake: run <cmd> when the board finishes (result JSON on stdin)
  rly show --html-file viz.html       visualization-only board (submit button = acknowledge)
  rly view <file.md> [more.md …]      quick read-only board rendering markdown file(s) (no lib)
                                      (.csv/.tsv/.json render as a filterable, sortable table;
                                       .pdf streams in an inline PDF viewer)
  rly diff [git args…]                run git diff and show it in a diff board (--split, --detach,
                                      --title; other args pass to git: rly diff --staged | HEAD~1 | -- path)
  rly git pick [range]                board for choosing pick/cherry-pick/drop actions plus commit order
  rly git cherry-pick [range]         board for choosing commits and cherry-pick order
                                      add --code for split code view with per-hunk Apply/Skip/Hold
  rly git conflict [files…]           board for resolving conflict-marker files; with no files, auto-detects
                                      unmerged git files and returns resolved content in result.blockEdits
  rly wait <id> [--timeout 3600]      block until board finishes, print result JSON
                                      --while-active [--idle-grace 180]: keep waiting past the deadline
                                        while the user is still viewing/focused & recently active
                                      --notify-cmd "<cmd>": run <cmd> on a terminal result (JSON on stdin)
                                      NB: also writes the FULL result to "resultFile" (first field) —
                                        read that file if your shell truncates stdout; never pipe to head/tail
  rly result <id>                     result/status now (includes live autosaved draft + presence while open)
  rly list [--json]                   running boards
  rly open [id]                       re-open the browser tab of a running board
  rly reopen <id> [--replies f.json]  serve a saved board again, prefilled with saved answers
                                      (--replies [{annotationId,text}] = agent answers to element comments)
  rly rescue <id> [--open]            re-serve a board on its ORIGINAL port so a still-open but
                                      disconnected browser tab auto-reconnects & re-saves (no new tab
                                      unless --open). Use when a tab shows "connection lost".
  rly reuse <id> [--dump]             re-run a past board as a new board (--dump prints its spec)
  rly update <id> --file spec.json    live-mutate a RUNNING board (or --title/--intro/-q); page reloads
  rly stop <id> | --all               stop running board(s) (status: cancelled, draft preserved)
  rly history [--limit n] [--json]    saved boards
  rly spec <id>                       print a saved board's spec JSON (edit, then ask --file again)
  rly rm <id> | --all                 delete saved board(s)
  rly schema                          JSON Schema of the board spec
  rly agent                           FULL GUIDE for AI agents (spec format, blocks, sizing, patterns)
  rly skill [install|rules|path]      bundled universal agent skill (Claude Code, Codex, …)
                                      \`rly skill rules >> CLAUDE.md\` adds always-read usage rules
  rly install --target <agent>        inject relay's rules into an agent's instruction file
                                      claude codex cursor copilot kiro windsurf cline gemini opencode droid agents
                                      --scope global|project · --print (copy/paste) · --all · --list (no flags)
  rly upgrade                         install the latest CLI globally + refresh the skill in one step
                                      --stop/--force handle running boards · --dry-run · --cli-only/--skill-only
  rly mcp                             run relay as an MCP App server (stdio) — boards render INLINE in
                                      a local desktop host (Claude Desktop, Codex) instead of a browser tab
  rly mcp --http [--port N]           serve over Streamable HTTP for web/mobile/remote hosts
                                      [--host H --token SECRET --allow-origin ORIGIN]
  rly mcp config | install --target   print host setup, or write it (claude | codex)

COMMON FLAGS
  --title <s> --intro <s> --html-file <f> --height <px> --submit-label <s>
  --timeout <sec> (default 1800; 0 = none) --port <n> --no-open --detach

EXIT CODES   0 submitted/acknowledged · 2 timeout · 3 cancelled · 4 usage · 5 not found

NOTES        answers & annotations autosave in real time (drafts survive timeout/cancel);
             submitting auto-closes the tab and unblocks the CLI.

AI AGENTS    run \`rly agent\` for the complete machine-oriented guide.
             a universal skill is bundled — install with \`rly skill install\`
             (or from the repo: npx skills add khanglvm/relay --skill relay --all)`);
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== '__serve') firstRunHint();
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === 'agent' || cmd === 'skill') {
    skillFreshnessWarning();
  }
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return printHelp();
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        return 0;
      case 'ask':
        return await cmdAsk(parseArgs(rest), 'ask');
      case 'show':
        return await cmdAsk(parseArgs(rest), 'show');
      case 'view':
        return await cmdView(parseArgs(rest));
      case 'diff':
        return await cmdDiff(rest);
      case 'git':
        return await cmdGit(rest);
      case 'reopen':
        return await cmdReopen(parseArgs(rest));
      case 'rescue':
        return await cmdRescue(parseArgs(rest));
      case 'reuse':
        return await cmdReuse(parseArgs(rest));
      case 'update':
        return await cmdUpdate(parseArgs(rest));
      case 'wait':
        return await cmdWait(parseArgs(rest));
      case 'result':
        return await cmdResult(parseArgs(rest));
      case 'list':
        return cmdList(parseArgs(rest));
      case 'open':
        return cmdOpen(parseArgs(rest));
      case 'stop':
        return await cmdStop(parseArgs(rest));
      case 'history':
        return cmdHistory(parseArgs(rest));
      case 'spec':
        return cmdSpec(parseArgs(rest));
      case 'rm':
        return cmdRm(parseArgs(rest));
      case 'skill':
        return cmdSkill(rest);
      case 'install':
        return cmdInstall(parseArgs(rest));
      case 'upgrade':
      case 'self-update':
        return await cmdUpgrade(parseArgs(rest));
      case 'agent':
        return cmdAgent();
      case 'schema':
        console.log(JSON.stringify(SPEC_SCHEMA, null, 2));
        return 0;
      case 'mcp':
        return await cmdMcp(rest);
      case '__serve':
        return await cmdServeInternal(parseArgs(rest));
      default:
        throw new CliError(`unknown command "${cmd}". Run \`rly help\`.`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`rly: ${err.message}\n`);
      if (err.code === 4) process.stderr.write('run `rly agent` for the agent-oriented guide\n');
      return err.code;
    }
    throw err;
  }
}
