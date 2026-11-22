// Cleans what a page posts (replies, annotations, edits, A2UI state) before it is stored.
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeJson } from '../a2ui/compile.js';
import { artifactDirPath } from '../store.js';
import { ARTIFACT_MAX_BYTES, ARTIFACT_MIMES } from './result.js';

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
function sanitizeAnnotationCrop(value, boardId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !boardId) return null;
  const rawPath = typeof value.path === 'string' ? value.path : '';
  if (!rawPath) return null;
  const base = path.resolve(artifactDirPath(boardId)) + path.sep;
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(base)) return null;
  let stat;
  try { stat = fs.statSync(resolved); } catch { return null; }
  if (!stat.isFile() || stat.size < 1 || stat.size > ARTIFACT_MAX_BYTES) return null;
  const mime = ARTIFACT_MIMES[value.mime] ? value.mime : 'image/png';
  return {
    path: resolved,
    name: path.basename(resolved),
    mime,
    bytes: stat.size,
    width: Math.max(1, Math.min(10000, Number.parseInt(value.width, 10) || 1)),
    height: Math.max(1, Math.min(10000, Number.parseInt(value.height, 10) || 1)),
  };
}

function sanitizeAnnotationTarget(value, boardId) {
  const clean = { ...value };
  delete clean.cropDataUrl;
  if (clean.kind !== 'image-region') {
    delete clean.crop;
    return clean;
  }
  const unit = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  clean.x = unit(clean.x);
  clean.y = unit(clean.y);
  clean.w = unit(clean.w);
  clean.h = unit(clean.h);
  if (clean.x + clean.w > 1) clean.w = 1 - clean.x;
  if (clean.y + clean.h > 1) clean.h = 1 - clean.y;
  clean.label = limitString(clean.label, 200);
  if (clean.side !== 'before' && clean.side !== 'after') delete clean.side;
  const crop = sanitizeAnnotationCrop(clean.crop, boardId);
  if (crop) clean.crop = crop;
  else delete clean.crop;
  return clean;
}

export function sanitizeAnnotations(value, boardId) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const a of value) {
    if (out.length >= 500) break;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) continue;
    if (typeof a.text !== 'string' || a.text.length > 5000) continue;
    if (a.target === null || typeof a.target !== 'object' || Array.isArray(a.target)) continue;
    const clean = {
      ...a,
      target: sanitizeAnnotationTarget(a.target, boardId),
      author: a.author === 'agent' ? 'agent' : 'user',
    };
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

// An a2ui block's state: the widget's data model (inputs the user changed) and
// the button events they fired, in order. Bounded like every other edit.
const A2UI_STATE_MAX_BYTES = 64 * 1024;
const A2UI_EVENTS_MAX = 50;
function sanitizeA2uiState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'a2ui') return null;
  try {
    assertSafeJson(value.data ?? {}, 'a2ui state');
    const events = (Array.isArray(value.events) ? value.events : []).slice(-A2UI_EVENTS_MAX).flatMap((e) => {
      if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(e.name)) return [];
      const context = e.context && typeof e.context === 'object' && !Array.isArray(e.context) ? e.context : {};
      assertSafeJson(context, 'a2ui event');
      if (JSON.stringify(context).length > 4096) return [];
      return [{ name: e.name, context, at: limitString(e.at, 40) }];
    });
    const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : {};
    if (JSON.stringify(data).length > A2UI_STATE_MAX_BYTES) return null;
    return { type: 'a2ui', data, events };
  } catch {
    return null;
  }
}

// Validates + sanitizes an incoming blockEdits map (from draft/submit).
// String values are editable Mermaid source. Structured git-conflict-resolution
// and diff-review values carry bounded per-hunk choices. Caps prevent a draft
// from bloating board storage; invalid entries are dropped.
export function sanitizeBlockEdits(value) {
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
      const edit = sanitizeConflictResolution(v) || sanitizeDiffReview(v) || sanitizeA2uiState(v);
      if (!edit) continue;
      out[key] = edit;
    }
    n++;
  }
  return out;
}

// Resolves a block by id + type from the board, any question, or any option.
export function findBlock(spec, blockId, type) {
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

export function findHtmlBlock(spec, blockId) {
  return findBlock(spec, blockId, 'html');
}

// The board's first html block (legacy /html/board alias).
export function firstBoardHtml(spec) {
  return (spec.blocks || []).find((b) => b && b.type === 'html');
}

// A question's first html block (legacy /html/q/<id> alias).
export function firstQuestionHtml(q) {
  return (q.blocks || []).find((b) => b && b.type === 'html');
}
