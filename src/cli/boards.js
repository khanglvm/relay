// Commands that act on an existing board: view, reopen, rescue, reuse, update, list, open, stop, history, spec and rm.
import path from 'node:path';
import { openUrl } from '../open.js';
import { assertSpecReady, normalizeSpec, questionFromInline } from '../spec/index.js';
import { HOME, controlUrl, createBoard, deleteBoard, isAlive, listBoards, listRunning, loadBoard, loadRunning, removeRunning, saveBoard } from '../store.js';
import { CliError, pollFor } from '../util.js';
import { mustLoad, parseJson, printJson, readFileOrThrow, readStdin, runOrDetach } from './io.js';

// `rly view <file.md> [more.md …]` — quick read-only board that renders files
// with purpose-built blocks (markdown, data tables, PDF). With 2+ files a small
// filename heading separates them. Sugar over `rly show`.
export async function cmdView(args) {
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

export async function cmdReopen(args) {
  const record = mustLoad(args._[0]);
  if (args.replies !== undefined) {
    const replies = parseJson(readFileOrThrow(args.replies), args.replies);
    seedAgentReplies(record, replies);
  }
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    if (!running.link) openUrl(running.url);
    printJson({ status: 'open', boardId: record.id, url: running.url, note: running.link ? 'already running' : 'already running — browser re-opened' });
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
export async function cmdRescue(args) {
  const record = mustLoad(args._[0]);
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    if (args.open && !running.link) openUrl(running.url);
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

export async function cmdReuse(args) {
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
export async function cmdUpdate(args) {
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
    res = await fetch(new URL('/api/update', controlUrl(running)), {
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

export function cmdList(args) {
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

export function cmdOpen(args) {
  let id = args._[0];
  const running = listRunning();
  if (!id) {
    if (running.length === 1) id = running[0].id;
    else if (running.length === 0) throw new CliError('no boards running. Use `rly reopen <id>` to serve a saved one.', 5);
    else throw new CliError(`multiple boards running — pick one: ${running.map((r) => r.id).join(', ')}`);
  }
  const info = running.find((r) => r.id === id);
  if (!info) throw new CliError(`board "${id}" is not running. Use \`rly reopen ${id}\` to serve it again (with saved answers).`, 5);
  if (!info.link) openUrl(info.url);
  printJson({ status: 'open', boardId: id, url: info.url });
  return 0;
}

export async function cmdStop(args) {
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

export function cmdHistory(args) {
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

export function cmdSpec(args) {
  const record = mustLoad(args._[0]);
  console.log(JSON.stringify(record.spec, null, 2));
  return 0;
}

export function cmdRm(args) {
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
