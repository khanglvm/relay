import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBoard, saveBoard, saveRunning, removeRunning, loadPref, savePref } from './store.js';
import { openUrl } from './open.js';
import { assertSpecReady } from './spec.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Concurrently authored UI assets (blocks/annotate) may not exist yet at this
// phase's runtime — read-guard so the server still boots with empty fallbacks.
//
// Successful reads are cached for the lifetime of the process. A running board
// thus serves one consistent UI snapshot taken at first request: if the relay
// package is updated on disk (e.g. `rly upgrade`) while this server is live, it
// keeps serving its own version instead of mixing new assets with old in-memory
// server logic. Empty/failed reads are NOT cached, preserving the boot-time
// fallback for assets authored concurrently during a build.
const _uiCache = new Map();
function readUi(name) {
  const hit = _uiCache.get(name);
  if (hit) return hit;
  let content = '';
  try {
    content = fs.readFileSync(path.join(UI_DIR, name), 'utf8');
  } catch {
    return '';
  }
  if (content) _uiCache.set(name, content);
  return content;
}

// Strips block bodies for the client payload: html blocks ship only metadata
// (their bodies are served via /html/b/<id>), embedded images ship only
// metadata (bytes served via /img/b/<id>), streamed local media ships only
// metadata (bytes served via /video/b/<id> or /pdf/b/<id>), everything else
// ships as-is.
function clientBlock(b) {
  // Cross-block fields preserved when we ship metadata-only (ref = reference-link
  // target name; pins = image coordinate comments). The default `return b` path
  // already carries them.
  const extra = {};
  if (b && b.ref !== undefined) extra.ref = b.ref;
  if (b && b.type === 'html') {
    return { id: b.id, type: 'html', height: b.height, hasHtml: Boolean(b.html), ...extra };
  }
  if (b && b.type === 'image' && typeof b.src === 'string' && b.src.startsWith('data:')) {
    return { id: b.id, type: 'image', alt: b.alt, height: b.height, hasData: true, ...(b.pins ? { pins: true } : {}), ...extra };
  }
  // Local video: the absolute file path stays server-side; the client gets a
  // flag + mime and loads the bytes (Range-streamed) from /video/b/<id>.
  if (b && b.type === 'video' && typeof b.file === 'string') {
    return { id: b.id, type: 'video', title: b.title, height: b.height, mime: b.mime, hasFile: true, ...extra };
  }
  if (b && b.type === 'pdf' && typeof b.file === 'string') {
    return { id: b.id, type: 'pdf', title: b.title, height: b.height, mime: b.mime, hasFile: true, ...extra };
  }
  return b;
}

// One question for the client payload: strip block bodies at the question
// level AND inside each option's blocks.
function clientQuestion(q) {
  const out = { ...q, blocks: (q.blocks || []).map(clientBlock) };
  if (Array.isArray(q.options)) {
    out.options = q.options.map((o) =>
      o && Array.isArray(o.blocks) && o.blocks.length ? { ...o, blocks: o.blocks.map(clientBlock) } : o
    );
  }
  return out;
}

// True when any block in the spec needs a given vendored library.
function specNeeds(spec, type) {
  const has = (blocks) => Array.isArray(blocks) && blocks.some((b) => b && b.type === type);
  if (has(spec.blocks)) return true;
  return spec.questions.some(
    (q) => has(q.blocks) || (Array.isArray(q.options) && q.options.some((o) => o && has(o.blocks)))
  );
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
    questions: spec.questions.map(clientQuestion),
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
        // The server draft's save time, so the client can pick the NEWER of this
        // vs. its localStorage mirror (a tab that kept typing while the server
        // was unreachable holds fresher input than the last server save).
        updatedAt: record.draft.updatedAt || null,
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

function limitString(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function sanitizeConflictResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'git-conflict-resolution') return null;
  const out = {
    type: 'git-conflict-resolution',
    filename: limitString(value.filename, 500),
    file: limitString(value.file, 1200),
    resolved: value.resolved === true,
    resolutions: {},
    content: limitString(value.content, 512 * 1024),
  };
  const raw = value.resolutions && typeof value.resolutions === 'object' && !Array.isArray(value.resolutions)
    ? value.resolutions
    : {};
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= 200) break;
    const r = raw[id];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const choice = limitString(r.choice, 30);
    if (!['ours', 'theirs', 'both', 'custom'].includes(choice)) continue;
    out.resolutions[limitString(id, 80)] = {
      choice,
      value: limitString(r.value, 128 * 1024),
    };
    n++;
  }
  return Object.keys(out.resolutions).length ? out : null;
}

function sanitizeDiffReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'diff-review') return null;
  const out = {
    type: 'diff-review',
    reviewKind: limitString(value.reviewKind, 80),
    commit: limitString(value.commit, 120),
    title: limitString(value.title, 500),
    resolved: value.resolved === true,
    hunks: {},
  };
  const raw = value.hunks && typeof value.hunks === 'object' && !Array.isArray(value.hunks)
    ? value.hunks
    : {};
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= 500) break;
    const h = raw[id];
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    const choice = limitString(h.choice, 30);
    if (!['apply', 'skip', 'hold'].includes(choice)) continue;
    out.hunks[limitString(id, 80)] = {
      choice,
      file: limitString(h.file, 1200),
      header: limitString(h.header, 500),
    };
    n++;
  }
  return Object.keys(out.hunks).length ? out : null;
}

// Validates + sanitizes an incoming blockEdits map (from draft/submit).
// String values are editable Mermaid source. Structured git-conflict-resolution
// and diff-review values carry bounded per-hunk choices. Caps prevent a draft
// from bloating board storage; invalid entries are dropped.
function sanitizeBlockEdits(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (n >= 50) break;
    if (typeof key !== 'string') continue;
    const v = value[key];
    if (typeof v === 'string') {
      if (v.length > 20000) continue;
      out[key] = v;
    } else {
      const edit = sanitizeConflictResolution(v) || sanitizeDiffReview(v);
      if (!edit) continue;
      out[key] = edit;
    }
    n++;
  }
  return out;
}

// Resolves a block by id + type from the board, any question, or any option.
function findBlock(spec, blockId, type) {
  const scan = (blocks) => (Array.isArray(blocks) ? blocks.find((b) => b && b.id === blockId && b.type === type) : undefined);
  const board = scan(spec.blocks);
  if (board) return board;
  for (const q of spec.questions) {
    const hit = scan(q.blocks);
    if (hit) return hit;
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const opt = o && scan(o.blocks);
      if (opt) return opt;
    }
  }
  return undefined;
}

function findHtmlBlock(spec, blockId) {
  return findBlock(spec, blockId, 'html');
}

// The board's first html block (legacy /html/board alias).
function firstBoardHtml(spec) {
  return (spec.blocks || []).find((b) => b && b.type === 'html');
}

// A question's first html block (legacy /html/q/<id> alias).
function firstQuestionHtml(q) {
  return (q.blocks || []).find((b) => b && b.type === 'html');
}

// ---------- local-file links (POST /api/open) ----------
// The markdown renderer turns file paths an agent writes (~/x, ./x, /abs/x,
// file://…) into click-to-open links. Clicking POSTs the raw path here; the
// server resolves it against the board's authoring cwd and opens it in the OS
// default app — BUT only if the path is one the board actually references
// (allowlist below). That keeps a cross-site/blind POST from opening arbitrary
// files: the only openable paths are ones the agent already put on the board.
//
// FILE_PATH_RE / looksLikeLocalPath MUST stay in sync with the same logic in
// ui/blocks.js, so the set the server allows matches the set the page links.
const FILE_PATH_RE =
  /(?<![\w@:./])(?:file:\/\/\/?[^\s)<>"'`*]+|~\/[^\s)<>"'`*]+|\.{1,2}\/[^\s)<>"'`*]+|\/[^\s)<>"'`*]+|[A-Za-z]:[\\/][^\s)<>"'`*]+)/g;

function looksLikeLocalPath(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^file:\/\//i.test(t)) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true; // windows drive
  if (t === '~' || /^~\//.test(t)) return true;
  if (/^\.\.?\//.test(t)) return true; // ./ or ../
  if (t.startsWith('/')) {
    // a lone "/" or a one-segment "/word" is more likely punctuation/URL — only
    // treat as a file when it has ≥2 segments or a file extension.
    return /\/[^/]+\/[^/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
  }
  return false;
}

// Expands ~ / file:// and resolves a (possibly relative) path to an absolute,
// normalized one against the board's authoring cwd. null on a malformed URL.
function resolveLocalPath(raw, baseCwd) {
  let p = String(raw || '').trim();
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  } else if (p === '~' || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p)) p = path.resolve(baseCwd || process.cwd(), p);
  return path.normalize(p);
}

// Every markdown source the page runs through its inline renderer (intro + any
// markdown block, board / question / option scoped). These are the only places
// file paths become clickable, so they define the open allowlist.
function collectMarkdownSources(spec) {
  const out = [];
  if (typeof spec.intro === 'string') out.push(spec.intro);
  const addBlocks = (blocks) => {
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (b && b.type === 'markdown' && typeof b.md === 'string') out.push(b.md);
    }
  };
  addBlocks(spec.blocks);
  for (const q of spec.questions || []) {
    addBlocks(q.blocks);
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (o) addBlocks(o.blocks);
    }
  }
  return out;
}

// The set of absolute paths the board references and is therefore allowed to
// open. Rebuilt per request (specs are small) so it tracks live `rly update`s.
function buildOpenAllowlist(spec, baseCwd) {
  const set = new Set();
  const text = collectMarkdownSources(spec).join('\n');
  const re = new RegExp(FILE_PATH_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (!looksLikeLocalPath(m[0])) continue;
    const abs = resolveLocalPath(m[0], baseCwd);
    if (abs) set.add(abs);
  }
  return set;
}

// True when an Origin header (if present) belongs to this board's own server.
// Same-origin fetches send no Origin or our own; a foreign Origin is a
// cross-site POST and must not be allowed to open a local file.
function sameOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).host;
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  } catch {
    return false;
  }
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

// Streams a file with HTTP Range support so a <video>/<audio> element can seek
// and the browser can request byte ranges instead of the whole clip. Honors a
// single "bytes=start-end" range; falls back to the full body otherwise. Safe
// for a HEAD probe (sends headers, no body).
function streamFile(req, res, filePath, contentType) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'file not found' });
  }
  const total = stat.size;
  const range = req.headers.range;
  const baseHeaders = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  let start = 0;
  let end = total - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      if (m[1] === '' && m[2] === '') {
        // "bytes=-" — unsatisfiable
      } else if (m[1] === '') {
        start = Math.max(0, total - Number(m[2])); // suffix range
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
    }
    if (start > end || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}`, 'cache-control': 'no-store' });
      return res.end();
    }
    status = 206;
    baseHeaders['content-range'] = `bytes ${start}-${end}/${total}`;
  }
  baseHeaders['content-length'] = String(end - start + 1);
  res.writeHead(status, baseHeaders);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'stream error' });
    else res.destroy();
  });
  stream.pipe(res);
}

// Loaded into every custom-HTML iframe so users can hover any element to leave a
// comment (relayKit.annotate.auto). Idempotent with an author-added /kit.js, and
// a no-op when the author opts out via data-relay-annotate="off".
const ANNOTATE_BOOTSTRAP =
  '<script>(function(){function go(){try{window.relayKit&&window.relayKit.annotate&&window.relayKit.annotate.auto();}catch(e){}}' +
  'if(window.relayKit&&window.relayKit.annotate)return go();' +
  "var s=document.createElement('script');s.src='/kit.js';s.onload=go;s.onerror=go;" +
  '(document.head||document.documentElement).appendChild(s);})();<\/script>';

// Insert a snippet right before </body> (else </html>, else append).
function injectBeforeBodyEnd(html, snippet) {
  const lower = html.toLowerCase();
  let idx = lower.lastIndexOf('</body>');
  if (idx === -1) idx = lower.lastIndexOf('</html>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

// Custom-HTML fragments (no <html> tag) get wrapped in a minimal document that
// matches the user's theme, so e.g. "<b>hi</b>" doesn't paint a stark white
// block in dark mode. Full documents are served verbatim — their authors can
// read the ?theme=light|dark query param themselves. Either way the annotate
// bootstrap is injected so every element is hover-commentable.
function wrapFragment(content, theme) {
  if (/<html[\s>]/i.test(content)) return injectBeforeBodyEnd(content, ANNOTATE_BOOTSTRAP);
  const dark = theme === 'dark';
  const bg = dark ? '#282624' : '#ffffff';
  const fg = dark ? '#edeae4' : '#1c1b19';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:${dark ? 'dark' : 'light'}}body{margin:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:${bg};color:${fg}}</style></head><body>${content}${ANNOTATE_BOOTSTRAP}</body></html>`;
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
export async function runBoard({ id, port = 0, open = true, timeoutSec = 1800, quiet = false, keepAliveOnTimeout = false }) {
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
  // Soft timeout: the board's time is up and a `timeout` result was handed back
  // to the waiting agent, but the server stays live so the user can keep
  // working and still submit. Surfaced via /api/status so the page can show a
  // calm "agent stopped waiting" note instead of disconnecting.
  let softTimedOut = false;
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
        sendJson(res, 200, { status, rev, softTimedOut });
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
        try {
          await assertSpecReady(next);
        } catch (err) {
          return sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
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
      } else if (req.method === 'GET' && pathname.startsWith('/img/b/')) {
        // Embedded image bytes (image blocks authored from local files).
        const blockId = decodeURIComponent(pathname.slice('/img/b/'.length));
        const block = findBlock(record.spec, blockId, 'image');
        const m = block && typeof block.src === 'string' ? block.src.match(/^data:([^;,]+);base64,(.*)$/s) : null;
        if (!m) return sendJson(res, 404, { error: `no embedded image block "${blockId}"` });
        res.writeHead(200, { 'content-type': m[1], 'cache-control': 'no-store' });
        res.end(Buffer.from(m[2], 'base64'));
      } else if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/video/b/')) {
        // Local video bytes, Range-streamed so the <video> element can seek.
        const blockId = decodeURIComponent(pathname.slice('/video/b/'.length));
        const block = findBlock(record.spec, blockId, 'video');
        if (!block || typeof block.file !== 'string') return sendJson(res, 404, { error: `no local video block "${blockId}"` });
        streamFile(req, res, block.file, block.mime || 'application/octet-stream');
      } else if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/pdf/b/')) {
        // Local PDF bytes, Range-streamed for the browser's built-in PDF viewer.
        const blockId = decodeURIComponent(pathname.slice('/pdf/b/'.length));
        const block = findBlock(record.spec, blockId, 'pdf');
        if (!block || typeof block.file !== 'string') return sendJson(res, 404, { error: `no local pdf block "${blockId}"` });
        streamFile(req, res, block.file, block.mime || 'application/pdf');
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
        if (typeof body.fontScale === 'number' && body.fontScale >= 0.5 && body.fontScale <= 2) {
          savePref({ fontScale: body.fontScale });
        }
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'POST' && pathname === '/api/open') {
        // Open a board-referenced local file in the OS default app. Guarded by
        // a same-origin check + an allowlist of paths the board actually links.
        if (!sameOrigin(req, actualPort)) return sendJson(res, 403, { error: 'cross-origin requests cannot open files' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const raw = typeof body.path === 'string' ? body.path : '';
        if (!raw.trim()) return sendJson(res, 400, { error: 'missing "path"' });
        const baseCwd = record.cwd || process.cwd();
        const target = resolveLocalPath(raw, baseCwd);
        if (!target) return sendJson(res, 400, { error: 'invalid path' });
        if (!buildOpenAllowlist(record.spec, baseCwd).has(target)) {
          return sendJson(res, 403, { error: 'this path is not referenced on the board' });
        }
        let stat = null;
        try {
          stat = fs.statSync(target);
        } catch {
          stat = null;
        }
        if (!stat) return sendJson(res, 404, { error: 'file not found', path: target });
        if (!openUrl(target)) return sendJson(res, 500, { error: 'could not open the file' });
        sendJson(res, 200, { ok: true, path: target, name: path.basename(target) });
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

  // Bind the requested port (reopen/rescue reuse the board's last port so a
  // still-open tab reconnects). A board just stopped on that port holds its
  // listening socket through a short close grace, so a stop-then-reopen on the
  // same port can briefly hit EADDRINUSE — retry for ~2s to ride that out before
  // giving up. Only then fall back to a random free port rather than failing.
  await new Promise((resolve, reject) => {
    const RETRY_MS = 200;
    const MAX_RETRIES = 10; // ~2s — covers a prior server's ~600ms close grace
    let retries = 0;
    const bind = (p, allowFallback) => {
      const onErr = (e) => {
        if (allowFallback && e && e.code === 'EADDRINUSE' && p !== 0) {
          if (retries++ < MAX_RETRIES) {
            setTimeout(() => bind(p, true), RETRY_MS); // port freeing up — retry it
          } else {
            bind(0, false); // still busy after retries → random free port
          }
        } else {
          reject(e);
        }
      };
      server.once('error', onErr);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        resolve();
      });
    };
    bind(port, true);
  });
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/`;
  // Remember the port this board last bound, so `rly rescue <id>` can re-serve
  // on the SAME port — letting a still-open (but disconnected) browser tab
  // reconnect to its relative /api/* URLs without the user touching anything.
  if (record.lastPort !== actualPort) {
    record.lastPort = actualPort;
    saveBoard(record);
  }
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
  let idleTimer = null;
  // The detached server's timeout is SOFT (keepAliveOnTimeout): at the deadline
  // we hand a `timeout` result back to the waiting agent (so `rly wait` returns
  // with the autosaved draft) but keep the server listening, so the user can
  // keep working and still submit. A late submit overwrites the result with
  // `submitted` and re-fires the push-wake; the board only truly closes on
  // submit, an explicit stop, or once the user has clearly left (idle
  // watchdog). A BLOCKING `rly ask` has no separate waiter to hand back to, so
  // its timeout stays hard (close + resolve, exit 2).
  if (timeoutSec > 0) {
    timer = setTimeout(keepAliveOnTimeout ? softTimeout : () => finish({ status: 'timeout' }), timeoutSec * 1000);
  }
  const onSignal = () => finish({ status: 'cancelled' });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Build + persist a result object onto the record (read cross-process by
  // `rly wait` / `rly result`). Does NOT touch the server lifecycle.
  function persistResult(partial) {
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
      // Per-question notes are first-class feedback. Always emit the key (even
      // empty {}) so a consumer can SEE it exists and never silently misses a
      // note the user left under a question. Falls back to the autosaved draft
      // on timeout/cancel.
      notes: partial.notes ?? (record.draft?.notes || {}),
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
    return result;
  }

  // Tear the HTTP server down after a short grace (so the success page renders
  // and auto-closes first). The result is assumed already persisted.
  function closeServer(result) {
    removeRunning(record.id);
    if (timer) clearTimeout(timer);
    if (idleTimer) clearInterval(idleTimer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
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

  // Terminal finish (submit / acknowledge / explicit cancel): persist the
  // result, push-wake the agent for EVERY terminal status, and close the
  // server. A late submit after a soft timeout lands here and overwrites the
  // earlier `timeout` result with `submitted` (re-firing the push-wake).
  function finish(partial) {
    if (finished) return;
    finished = true;
    status = partial.status;
    const result = persistResult(partial);
    runOnResult(record.onResult, result, { quiet });
    closeServer(result);
  }

  // SOFT timeout — hand a `timeout` result to the agent but keep the board live
  // and submittable. The agent's `rly wait` returns now; the user can carry on.
  function softTimeout() {
    if (finished || softTimedOut) return;
    softTimedOut = true;
    const result = persistResult({ status: 'timeout' });
    runOnResult(record.onResult, result, { quiet });
    startIdleWatchdog();
  }

  // After a soft timeout, close the board for real once the user has clearly
  // left (no presence ping for IDLE_CLOSE_MS) or a hard absolute cap is hit, so
  // an abandoned board doesn't keep a server alive forever. Re-persists the
  // latest draft as the final `timeout` result; no double push-wake.
  function startIdleWatchdog() {
    const IDLE_CLOSE_MS = 15 * 60 * 1000;
    const HARD_CAP_MS = 6 * 60 * 60 * 1000;
    const softAt = Date.now();
    idleTimer = setInterval(() => {
      if (finished) {
        clearInterval(idleTimer);
        return;
      }
      const lastSeen = presence ? presence.atMs : softAt;
      if (Date.now() - lastSeen > IDLE_CLOSE_MS || Date.now() - softAt > HARD_CAP_MS) {
        finished = true;
        clearInterval(idleTimer);
        closeServer(persistResult({ status: 'timeout' }));
      }
    }, 60 * 1000);
    idleTimer.unref?.();
  }

  if (open) openUrl(url);
  if (!quiet) {
    process.stderr.write(
      `[relay] ${record.id} open: ${url} (waiting for submit; timeout: ${timeoutSec > 0 ? `${timeoutSec}s` : 'none'})\n`
    );
  }
  return { url, port: actualPort, done };
}
