import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoard, saveBoard, saveRunning, removeRunning, loadPref, savePref } from './store.js';
import { openUrl } from './open.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildPage(record) {
  const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  const spec = record.spec;
  // Custom HTML is served via /html/* iframes, so strip the bodies from the
  // embedded payload and only ship hasHtml flags.
  const clientSpec = {
    ...spec,
    html: undefined,
    hasHtml: Boolean(spec.html),
    questions: spec.questions.map((q) => ({ ...q, html: undefined, hasHtml: Boolean(q.html) })),
  };
  // Prefill from the LIVE draft at request time (drafts autosave in real time),
  // so a mid-fill page reload restores everything the user already entered.
  const prefill = record.draft
    ? { answers: record.draft.answers || {}, comment: record.draft.comment || '', notes: record.draft.notes || {} }
    : null;
  const boot = { boardId: record.id, spec: clientSpec, prefill, pref: loadPref() };
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return html
    .split('__TITLE__').join(escapeHtml(spec.title))
    .split('/*__CSS__*/').join(css)
    .split('/*__JS__*/').join(js)
    .split('__BOOT_JSON__').join(json);
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

// Serves one board on 127.0.0.1 and resolves `done` when it finishes
// (submitted / acknowledged / timeout / cancelled). The result is also
// persisted into the board record so `qbd wait` / `qbd result` can read it
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
        updatedAt: new Date().toISOString(),
      };
    }
    record.pastResults = [...(record.pastResults || []), record.result].slice(-10);
    record.result = null;
    saveBoard(record);
  }

  const startedAt = Date.now();
  let status = 'open';
  let finished = false;
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
        sendHtml(res, buildPage(record));
      } else if (req.method === 'GET' && pathname === '/api/board') {
        sendJson(res, 200, { id: record.id, spec, draft: record.draft, result: record.result });
      } else if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { status });
      } else if (req.method === 'GET' && pathname === '/html/board') {
        sendHtml(res, wrapFragment(spec.html || '', theme));
      } else if (req.method === 'GET' && pathname.startsWith('/html/q/')) {
        const qid = decodeURIComponent(pathname.slice('/html/q/'.length));
        const q = spec.questions.find((q) => q.id === qid);
        if (!q) return sendJson(res, 404, { error: `no question "${qid}"` });
        sendHtml(res, wrapFragment(q.html || '', theme));
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
          updatedAt: new Date().toISOString(),
        };
        saveBoard(record);
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'POST' && pathname === '/api/submit') {
        if (status !== 'open') return sendJson(res, 409, { error: 'board already finished' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
        const skipped = spec.questions.filter((q) => !(q.id in answers)).map((q) => q.id);
        sendJson(res, 200, { ok: true });
        finish({
          status: spec.questions.length ? 'submitted' : 'acknowledged',
          answers,
          skipped,
          comment: typeof body.comment === 'string' ? body.comment : '',
          notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
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
    const result = {
      status: partial.status,
      boardId: record.id,
      title: spec.title,
      url,
      answers: partial.answers ?? null,
      skipped: partial.skipped ?? null,
      comment: partial.comment ?? '',
      notes: partial.notes ?? null,
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
      `[quest-board] ${record.id} open: ${url} (waiting for submit; timeout: ${timeoutSec > 0 ? `${timeoutSec}s` : 'none'})\n`
    );
  }
  return { url, port: actualPort, done };
}
