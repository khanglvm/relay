import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBoard, saveBoard, saveRunning, removeRunning, loadPref, savePref } from './store.js';
import { openUrl } from './open.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Concurrently authored UI assets (blocks/annotate) may not exist yet at this
// phase's runtime — read-guard so the server still boots with empty fallbacks.
function readUi(name) {
  try {
    return fs.readFileSync(path.join(UI_DIR, name), 'utf8');
  } catch {
    return '';
  }
}

// Strips block bodies for the client payload: html blocks ship only metadata
// (their bodies are served via /html/b/<id>), everything else ships as-is.
function clientBlock(b) {
  if (b && b.type === 'html') {
    return { id: b.id, type: 'html', height: b.height, hasHtml: Boolean(b.html) };
  }
  return b;
}

// True when any block in the spec needs a given vendored library.
function specNeeds(spec, type) {
  const has = (blocks) => Array.isArray(blocks) && blocks.some((b) => b && b.type === type);
  if (has(spec.blocks)) return true;
  return spec.questions.some((q) => has(q.blocks));
}

function vendorPresent(file) {
  try {
    return fs.existsSync(path.join(VENDOR_DIR, file));
  } catch {
    return false;
  }
}

function buildPage(record, rev) {
  const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const css = readUi('style.css');
  const blocksCss = readUi('blocks.css');
  const annotateCss = readUi('annotate.css');
  const blocksJs = readUi('blocks.js');
  const annotateJs = readUi('annotate.js');
  const appJs = readUi('app.js');
  const spec = record.spec;
  // Block bodies (html) are served via /html/b/* iframes, so strip them from
  // the embedded payload and only ship metadata.
  const clientSpec = {
    ...spec,
    blocks: (spec.blocks || []).map(clientBlock),
    questions: spec.questions.map((q) => ({ ...q, blocks: (q.blocks || []).map(clientBlock) })),
  };
  // Tell the client which vendored libraries to lazy-load — true only when a
  // block needs it AND the vendored asset is actually present.
  // Filenames must match what the clients request (blocks.js / kit.js load
  // /vendor/chart.umd.js and /vendor/mermaid.min.js).
  const vendor = {
    chart: specNeeds(spec, 'chart') && vendorPresent('chart.umd.js'),
    mermaid: specNeeds(spec, 'mermaid') && vendorPresent('mermaid.min.js'),
    viz: specNeeds(spec, 'graphviz') && vendorPresent('viz-standalone.js'),
  };
  // Prefill from the LIVE draft at request time (drafts autosave in real time),
  // so a mid-fill page reload restores everything the user already entered.
  const prefill = record.draft
    ? {
        answers: record.draft.answers || {},
        comment: record.draft.comment || '',
        notes: record.draft.notes || {},
        annotations: record.draft.annotations || [],
        blockEdits: record.draft.blockEdits || {},
      }
    : null;
  const boot = { boardId: record.id, spec: clientSpec, prefill, pref: loadPref(), vendor, rev };
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return html
    .split('__TITLE__').join(escapeHtml(spec.title))
    .split('/*__CSS__*/').join(css)
    .split('/*__BLOCKS_CSS__*/').join(blocksCss)
    .split('/*__ANNOTATE_CSS__*/').join(annotateCss)
    .split('/*__BLOCKS_JS__*/').join(blocksJs)
    .split('/*__ANNOTATE_JS__*/').join(annotateJs)
    .split('/*__APP_JS__*/').join(appJs)
    .split('__BOOT_JSON__').join(json);
}

// Validates + sanitizes one annotation's threaded replies. Keeps only
// well-formed {author, text, createdAt} entries; caps at 50; coerces author.
function sanitizeReplies(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const r of value) {
    if (out.length >= 50) break;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
    if (typeof r.text !== 'string' || r.text.length > 5000) continue;
    const author = r.author === 'agent' ? 'agent' : 'user';
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString();
    out.push({ author, text: r.text, createdAt });
  }
  return out;
}

// Validates + sanitizes an incoming annotations array (from draft/submit).
// Drops anything that isn't a well-formed annotation object; caps at 500.
// Each annotation may carry an optional author ('user'|'agent', default
// 'user') and a threaded replies array (validated + capped at 50).
function sanitizeAnnotations(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const a of value) {
    if (out.length >= 500) break;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) continue;
    if (typeof a.text !== 'string' || a.text.length > 5000) continue;
    if (a.target === null || typeof a.target !== 'object' || Array.isArray(a.target)) continue;
    const clean = { ...a, author: a.author === 'agent' ? 'agent' : 'user' };
    if (a.replies !== undefined) clean.replies = sanitizeReplies(a.replies);
    out.push(clean);
  }
  return out;
}

// Validates + sanitizes an incoming blockEdits map (from draft/submit).
// Keeps only string-keyed entries with string values <= 20000 chars; caps at
// 50 entries; drops invalid entries. Returns {} when nothing valid is present.
function sanitizeBlockEdits(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (n >= 50) break;
    if (typeof key !== 'string') continue;
    const v = value[key];
    if (typeof v !== 'string' || v.length > 20000) continue;
    out[key] = v;
    n++;
  }
  return out;
}

// Resolves an html block body by id from the board or any question scope.
function findHtmlBlock(spec, blockId) {
  const scan = (blocks) => (Array.isArray(blocks) ? blocks.find((b) => b && b.id === blockId && b.type === 'html') : undefined);
  const board = scan(spec.blocks);
  if (board) return board;
  for (const q of spec.questions) {
    const hit = scan(q.blocks);
    if (hit) return hit;
  }
  return undefined;
}

// The board's first html block (legacy /html/board alias).
function firstBoardHtml(spec) {
  return (spec.blocks || []).find((b) => b && b.type === 'html');
}

// A question's first html block (legacy /html/q/<id> alias).
function firstQuestionHtml(q) {
  return (q.blocks || []).find((b) => b && b.type === 'html');
}

function sendJson(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendJs(res, body) {
  res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// Serves a file from a fixed directory, rejecting any path that escapes it
// (no traversal). Returns false (404 not written) when the file is missing.
function sendFromDir(res, dir, name, contentType) {
  const target = path.resolve(dir, name);
  if (target !== dir && !target.startsWith(dir + path.sep)) return false;
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    return false;
  }
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

// Custom-HTML fragments (no <html> tag) get wrapped in a minimal document that
// matches the user's theme, so e.g. "<b>hi</b>" doesn't paint a stark white
// block in dark mode. Full documents are served verbatim — their authors can
// read the ?theme=light|dark query param themselves.
function wrapFragment(content, theme) {
  if (/<html[\s>]/i.test(content)) return content;
  const dark = theme === 'dark';
  const bg = dark ? '#282624' : '#ffffff';
  const fg = dark ? '#edeae4' : '#1c1b19';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:${dark ? 'dark' : 'light'}}body{margin:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:${bg};color:${fg}}</style></head><body>${content}</body></html>`;
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Push-wake: run the agent's own local shell command after a board finishes.
// The full result JSON is written to the command's stdin; RLY_BOARD_ID /
// RLY_STATUS / RLY_URL are exported. Failures are swallowed (best effort) —
// only a stderr note when not quiet. A 30s kill timer prevents a hung command
// from keeping the process alive.
function runOnResult(cmd, result, { quiet = false } = {}) {
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
    child.on('error', () => {
      if (!quiet) process.stderr.write(`[relay] --on-result command failed to spawn\n`);
    });
    try {
      child.stdin.write(JSON.stringify(result));
      child.stdin.end();
    } catch {
      // best effort — stdin may already be gone
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
    if (!quiet) process.stderr.write(`[relay] --on-result command failed to run\n`);
  }
}

// Serves one board on 127.0.0.1 and resolves `done` when it finishes
// (submitted / acknowledged / timeout / cancelled). The result is also
// persisted into the board record so `rly wait` / `rly result` can read it
// from another process.
export async function runBoard({ id, port = 0, open = true, timeoutSec = 1800, quiet = false }) {
  const record = loadBoard(id);
  if (!record) throw new Error(`board ${id} not found`);
  const spec = record.spec;

  // Reopening a finished board: seed the draft from its last submitted answers
  // (so the page prefills them), archive the old result, and go back to "open"
  // so wait/result reflect this run only.
  if (record.result) {
    if (record.result.answers) {
      record.draft = {
        answers: record.result.answers,
        comment: record.result.comment || '',
        notes: record.result.notes || {},
        annotations: record.result.annotations || [],
        blockEdits: record.result.blockEdits || {},
        updatedAt: new Date().toISOString(),
      };
    }
    record.pastResults = [...(record.pastResults || []), record.result].slice(-10);
    record.result = null;
    saveBoard(record);
  }

  const startedAt = Date.now();
  // Mutation token: only `rly update` (which reads the running-file record)
  // can authenticate to POST /api/update. Never embedded in the page/boot.
  const token = crypto.randomBytes(16).toString('hex');
  let rev = 1;
  let status = 'open';
  let finished = false;
  // Latest client presence ping (null until the first ping arrives).
  let presence = null;
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const pathname = reqUrl.pathname;
    const theme = reqUrl.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    try {
      if (req.method === 'GET' && pathname === '/') {
        sendHtml(res, buildPage(record, rev));
      } else if (req.method === 'GET' && pathname === '/api/board') {
        sendJson(res, 200, { id: record.id, spec: record.spec, draft: record.draft, result: record.result });
      } else if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { status, rev });
      } else if (req.method === 'POST' && pathname === '/api/ping') {
        const body = JSON.parse((await readBody(req)) || '{}');
        // Validate body shape: visible/focused booleans, idleMs finite >= 0.
        if (
          typeof body.visible === 'boolean' &&
          typeof body.focused === 'boolean' &&
          Number.isFinite(body.idleMs) &&
          body.idleMs >= 0
        ) {
          presence = { atMs: Date.now(), visible: body.visible, focused: body.focused, idleMs: body.idleMs };
        }
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'GET' && pathname === '/api/presence') {
        if (!presence) {
          sendJson(res, 200, { open: true, seen: false });
        } else {
          sendJson(res, 200, {
            open: true,
            seen: true,
            visible: presence.visible,
            focused: presence.focused,
            secondsSinceActivity: Math.round((Date.now() - presence.atMs + presence.idleMs) / 1000),
            secondsSincePing: Math.round((Date.now() - presence.atMs) / 1000),
          });
        }
      } else if (req.method === 'POST' && pathname === '/api/update') {
        if (req.headers['x-relay-token'] !== token) return sendJson(res, 403, { error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const next = body.spec;
        if (next === null || typeof next !== 'object' || Array.isArray(next) ||
            !Array.isArray(next.questions) || !Array.isArray(next.blocks)) {
          return sendJson(res, 400, { error: 'spec must be an object with questions[] and blocks[] arrays' });
        }
        record.spec = next;
        rev++;
        saveBoard(record);
        sendJson(res, 200, { ok: true, rev });
      } else if (req.method === 'GET' && pathname === '/kit.js') {
        if (!sendFromDir(res, UI_DIR, 'kit.js', 'application/javascript; charset=utf-8')) {
          sendJs(res, ''); // kit.js authored concurrently — empty fallback keeps iframes working
        }
      } else if (req.method === 'GET' && pathname.startsWith('/vendor/')) {
        const name = decodeURIComponent(pathname.slice('/vendor/'.length));
        if (!sendFromDir(res, VENDOR_DIR, name, 'application/javascript; charset=utf-8')) {
          sendJson(res, 404, { error: `no vendor file "${name}"` });
        }
      } else if (req.method === 'GET' && pathname.startsWith('/html/b/')) {
        const blockId = decodeURIComponent(pathname.slice('/html/b/'.length));
        const block = findHtmlBlock(record.spec, blockId);
        if (!block) return sendJson(res, 404, { error: `no html block "${blockId}"` });
        sendHtml(res, wrapFragment(block.html || '', theme));
      } else if (req.method === 'GET' && pathname === '/html/board') {
        // Legacy alias → the board's first html block.
        const block = firstBoardHtml(record.spec);
        sendHtml(res, wrapFragment((block && block.html) || '', theme));
      } else if (req.method === 'GET' && pathname.startsWith('/html/q/')) {
        const qid = decodeURIComponent(pathname.slice('/html/q/'.length));
        const q = record.spec.questions.find((q) => q.id === qid);
        if (!q) return sendJson(res, 404, { error: `no question "${qid}"` });
        const block = firstQuestionHtml(q);
        sendHtml(res, wrapFragment((block && block.html) || '', theme));
      } else if (req.method === 'POST' && pathname === '/api/pref') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (['auto', 'light', 'dark'].includes(body.theme)) savePref({ theme: body.theme });
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'POST' && pathname === '/api/draft') {
        const body = JSON.parse((await readBody(req)) || '{}');
        record.draft = {
          answers: body.answers && typeof body.answers === 'object' ? body.answers : {},
          comment: typeof body.comment === 'string' ? body.comment : '',
          notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
          annotations: sanitizeAnnotations(body.annotations),
          blockEdits: sanitizeBlockEdits(body.blockEdits),
          updatedAt: new Date().toISOString(),
        };
        saveBoard(record);
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'POST' && pathname === '/api/submit') {
        if (status !== 'open') return sendJson(res, 409, { error: 'board already finished' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
        const skipped = record.spec.questions.filter((q) => !(q.id in answers)).map((q) => q.id);
        sendJson(res, 200, { ok: true });
        finish({
          status: record.spec.questions.length ? 'submitted' : 'acknowledged',
          answers,
          skipped,
          comment: typeof body.comment === 'string' ? body.comment : '',
          notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
          annotations: sanitizeAnnotations(body.annotations),
          blockEdits: sanitizeBlockEdits(body.blockEdits),
        });
      } else {
        sendJson(res, 404, { error: 'not found' });
      }
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/`;
  saveRunning({
    id: record.id,
    pid: process.pid,
    port: actualPort,
    url,
    title: spec.title,
    token,
    startedAt: new Date().toISOString(),
  });

  let timer = null;
  if (timeoutSec > 0) timer = setTimeout(() => finish({ status: 'timeout' }), timeoutSec * 1000);
  const onSignal = () => finish({ status: 'cancelled' });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  function finish(partial) {
    if (finished) return;
    finished = true;
    status = partial.status;
    // blockEdits: from this submit, else fall back to the autosaved draft
    // (timeout/cancel). null when there are none.
    const editsRaw = partial.blockEdits ?? (record.draft?.blockEdits || {});
    const blockEdits = editsRaw && Object.keys(editsRaw).length ? editsRaw : null;
    const result = {
      status: partial.status,
      boardId: record.id,
      title: spec.title,
      url,
      answers: partial.answers ?? null,
      skipped: partial.skipped ?? null,
      comment: partial.comment ?? '',
      notes: partial.notes ?? null,
      annotations: partial.annotations ?? (record.draft?.annotations || []),
      blockEdits,
      createdAt: record.createdAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    // Drafts autosave in real time, so even an abandoned board surfaces the
    // partial answers the user had typed.
    if ((partial.status === 'timeout' || partial.status === 'cancelled') && record.draft) {
      result.draft = record.draft;
    }
    record.result = result;
    saveBoard(record);
    // Push-wake: run the agent's local command for EVERY terminal status.
    runOnResult(record.onResult, result, { quiet });
    removeRunning(record.id);
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Grace period so the success page renders (and auto-closes) first.
    setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        // best effort
      }
      server.close(() => resolveDone(result));
      setTimeout(() => resolveDone(result), 1500).unref();
    }, 600);
  }

  if (open) openUrl(url);
  if (!quiet) {
    process.stderr.write(
      `[relay] ${record.id} open: ${url} (waiting for submit; timeout: ${timeoutSec > 0 ? `${timeoutSec}s` : 'none'})\n`
    );
  }
  return { url, port: actualPort, done };
}
