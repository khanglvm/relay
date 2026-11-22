// rly wait and rly result: block for a board's answer, or read it.
import { controlUrl, isAlive, loadBoard, loadRunning } from '../store.js';
import { CliError, sleep } from '../util.js';
import { DEFAULT_WAIT_TIMEOUT_SEC } from './context.js';
import { exitCodeFor, mustLoad, printJson, printResult, runNotifyCmd } from './io.js';

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

export async function cmdWait(args) {
  const id = args._[0];
  if (!id) throw new CliError('usage: rly wait <board-id> [--timeout <sec>] [--while-active] [--idle-grace <sec>] [--notify-cmd <cmd>]');
  const timeoutSec = args.timeout !== undefined ? Math.max(0, Number.parseInt(args.timeout, 10) || 0) : DEFAULT_WAIT_TIMEOUT_SEC;
  const whileActive = args.whileActive === true;
  const idleGrace = args.idleGrace !== undefined ? Math.max(0, Number.parseInt(args.idleGrace, 10) || 0) : 180;
  const notifyCmd = typeof args.notifyCmd === 'string' && args.notifyCmd.trim() ? args.notifyCmd : null;
  let deadline = timeoutSec === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutSec * 1000;
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
  const presence = running && isAlive(running.pid) ? await fetchPresence(controlUrl(running)) : null;

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
  const presence = running && isAlive(running.pid) ? await fetchPresence(controlUrl(running)) : null;
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

export async function cmdResult(args) {
  const record = mustLoad(args._[0]);
  const sideReviews = {
    referenceOnly: true,
    note: 'Side reviews are reference only. Wait for the board owner (or owner-authorized collaborator) to submit the final answer.',
    submissions: Array.isArray(record.sideReviews) ? record.sideReviews : [],
    drafts: record.reviewDrafts && typeof record.reviewDrafts === 'object' ? record.reviewDrafts : {},
  };
  if (record.result && record.result.finishedAt) {
    printResult({ ...record.result, sideReviews });
    return exitCodeFor(record.result.status);
  }
  const running = loadRunning(record.id);
  if (running && isAlive(running.pid)) {
    // While open, expose the real-time autosaved draft so agents can peek, plus
    // best-effort presence (whether the user is still viewing/focused/active).
    const out = { status: 'open', boardId: record.id, url: running.url, draft: record.draft ?? null, sideReviews };
    const presence = await fetchPresence(controlUrl(running));
    if (presence) out.presence = presence;
    printResult(out); // draft can hold many annotations — sidecar it too
    return 0;
  }
  printResult({ status: 'lost', boardId: record.id, draft: record.draft ?? null, sideReviews });
  return 5;
}
