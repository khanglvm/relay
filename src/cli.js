import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, sleep, pollFor } from './util.js';
import { normalizeSpec, questionFromInline, SPEC_SCHEMA } from './spec.js';
import {
  createBoard,
  loadBoard,
  deleteBoard,
  listBoards,
  listRunning,
  loadRunning,
  removeRunning,
  isAlive,
  HOME,
} from './store.js';
import { runBoard } from './server.js';
import { openUrl } from './open.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const BIN = path.join(PKG_ROOT, 'bin', 'rly.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

const VALUED_FLAGS = new Set([
  'file', 'html', 'html-file', 'title', 'intro', 'timeout', 'port',
  'submit-label', 'height', 'limit', 'target', 'id',
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
  const timeoutSec = args.timeout !== undefined ? Math.max(0, Number.parseInt(args.timeout, 10) || 0) : 1800;
  const port = args.port !== undefined ? Number.parseInt(args.port, 10) || 0 : 0;
  const open = args.open !== false;

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
  printJson(result);
  return exitCodeFor(result.status);
}

async function cmdAsk(args, mode) {
  const raw = await resolveSpecInput(args, mode);
  const spec = normalizeSpec(raw);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}

async function cmdReopen(args) {
  const record = mustLoad(args._[0]);
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    openUrl(running.url);
    printJson({ status: 'open', boardId: record.id, url: running.url, note: 'already running — browser re-opened' });
    return 0;
  }
  return runOrDetach(record, args);
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

async function cmdWait(args) {
  const id = args._[0];
  if (!id) throw new CliError('usage: rly wait <board-id> [--timeout <sec>]');
  const timeoutSec = args.timeout !== undefined ? Math.max(1, Number.parseInt(args.timeout, 10) || 1) : 3600;
  const deadline = Date.now() + timeoutSec * 1000;
  mustLoad(id);
  while (Date.now() < deadline) {
    const record = mustLoad(id);
    if (record.result && record.result.finishedAt) {
      printJson(record.result);
      return exitCodeFor(record.result.status);
    }
    const running = loadRunning(id);
    if (!running || !isAlive(running.pid)) {
      await sleep(700); // the result write may be racing the process exit
      const again = loadBoard(id);
      if (again?.result?.finishedAt) {
        printJson(again.result);
        return exitCodeFor(again.result.status);
      }
      printJson({
        status: 'lost',
        boardId: id,
        draft: again?.draft ?? null,
        error: 'board server exited without writing a result',
      });
      return 5;
    }
    await sleep(400);
  }
  printJson({
    status: 'wait-timeout',
    boardId: id,
    hint: `board is still open — run \`rly wait ${id}\` again, or \`rly result ${id}\` to peek at the live draft`,
  });
  return 2;
}

function cmdResult(args) {
  const record = mustLoad(args._[0]);
  if (record.result && record.result.finishedAt) {
    printJson(record.result);
    return exitCodeFor(record.result.status);
  }
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    // While open, expose the real-time autosaved draft so agents can peek.
    printJson({ status: 'open', boardId: record.id, url: running.url, draft: record.draft ?? null });
    return 0;
  }
  printJson({ status: 'lost', boardId: record.id, draft: record.draft ?? null });
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
  const home = os.homedir();
  const known = {
    claude: path.join(home, '.claude', 'skills', 'relay'),
    codex: path.join(home, '.codex', 'skills', 'relay'),
  };
  if (!target || target === true || target === 'auto') {
    const found = Object.values(known).filter((p) => fs.existsSync(path.dirname(path.dirname(p))));
    if (!found.length) {
      throw new CliError('no agent dirs found (~/.claude or ~/.codex). Use --target claude|codex|both|<dir>.');
    }
    return found;
  }
  if (target === 'both') return Object.values(known);
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

function cmdSkill(rest) {
  const sub = rest[0];
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
  install it:  rly skill install            # auto-detects ~/.claude and ~/.codex
               rly skill install --target claude|codex|both|<dir>
  from repo:   npx skills add khanglvm/relay

The skill teaches your agent the board spec format (questions + rich blocks +
annotations), the blocking vs --detach patterns, and visualization sizing.
Full guide: \`rly agent\`.`);
  return 0;
}

function cmdAgent() {
  console.log(fs.readFileSync(path.join(PKG_ROOT, 'docs', 'AGENT.md'), 'utf8'));
  return 0;
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
  rly show --html-file viz.html       visualization-only board (submit button = acknowledge)
  rly wait <id> [--timeout 3600]      block until board finishes, print result JSON
  rly result <id>                     result/status now (includes live autosaved draft while open)
  rly list [--json]                   running boards
  rly open [id]                       re-open the browser tab of a running board
  rly reopen <id>                     serve a saved board again, prefilled with its saved answers
  rly reuse <id> [--dump]             re-run a past board as a new board (--dump prints its spec)
  rly stop <id> | --all               stop running board(s) (status: cancelled, draft preserved)
  rly history [--limit n] [--json]    saved boards
  rly spec <id>                       print a saved board's spec JSON (edit, then ask --file again)
  rly rm <id> | --all                 delete saved board(s)
  rly schema                          JSON Schema of the board spec
  rly agent                           FULL GUIDE for AI agents (spec format, blocks, sizing, patterns)
  rly skill [install|path]            bundled universal agent skill (Claude Code, Codex, …)

COMMON FLAGS
  --title <s> --intro <s> --html-file <f> --height <px> --submit-label <s>
  --timeout <sec> (default 1800; 0 = none) --port <n> --no-open --detach

EXIT CODES   0 submitted/acknowledged · 2 timeout · 3 cancelled · 4 usage · 5 not found

NOTES        answers & annotations autosave in real time (drafts survive timeout/cancel);
             submitting auto-closes the tab and unblocks the CLI.

AI AGENTS    run \`rly agent\` for the complete machine-oriented guide.
             a universal skill is bundled — install with \`rly skill install\`
             (or from the repo: npx skills add khanglvm/relay)`);
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
      case 'reopen':
        return await cmdReopen(parseArgs(rest));
      case 'reuse':
        return await cmdReuse(parseArgs(rest));
      case 'wait':
        return await cmdWait(parseArgs(rest));
      case 'result':
        return cmdResult(parseArgs(rest));
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
      case 'agent':
        return cmdAgent();
      case 'schema':
        console.log(JSON.stringify(SPEC_SCHEMA, null, 2));
        return 0;
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
