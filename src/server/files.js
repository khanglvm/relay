// Local files a board may open or stream: path detection, allowlist and range streaming.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFileReference } from '../file-preview.js';
import { sendJson } from './http.js';

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
export function resolveLocalPath(raw, baseCwd) {
  let p = splitFileReference(raw).path;
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
export function buildOpenAllowlist(spec, baseCwd) {
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

// Streams a file with HTTP Range support so a <video>/<audio> element can seek
// and the browser can request byte ranges instead of the whole clip. Honors a
// single "bytes=start-end" range; falls back to the full body otherwise. Safe
// for a HEAD probe (sends headers, no body).
export function streamFile(req, res, filePath, contentType) {
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
