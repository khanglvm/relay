// Builds the board page: client payload, vendor checks and the share host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPref } from '../store.js';
import { SRC_DIR, fillPage } from '../ui/manifest.js';
import { VENDOR_DIR } from './paths.js';

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
function readUi(file) {
  const hit = _uiCache.get(file);
  if (hit) return hit;
  let content = '';
  try {
    content = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  } catch {
    return '';
  }
  if (content) _uiCache.set(file, content);
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

function cleanShareHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let host = s;
  try {
    host = s.includes('://') ? new URL(s).hostname : s;
  } catch {
    host = s;
  }
  host = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].trim();
  if (!host || host === '127.0.0.1' || host === 'localhost') return null;
  return host;
}

function isPrivateIpv4(address) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
  const parts = address.split('.').map((n) => Number(n));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function shareHost() {
  const forced = cleanShareHost(process.env.RLY_SHARE_HOST);
  if (forced) return forced;
  const candidates = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (!net || net.internal || net.family !== 'IPv4') continue;
      candidates.push(net.address);
    }
  }
  return candidates.find(isPrivateIpv4) || candidates[0] || null;
}

export function buildPage(record, rev, { access = null, draftRev = 0 } = {}) {
  const html = fs.readFileSync(path.join(SRC_DIR, 'ui', 'index.html'), 'utf8');
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
  // Reviewer answers are an independent, reference-only draft. They must never
  // prefill from or overwrite the owner's final-answer draft. Read-only viewers
  // see the owner's current state but cannot mutate it.
  const reviewDrafts = record.reviewDrafts && typeof record.reviewDrafts === 'object' ? record.reviewDrafts : {};
  const sourceDraft = access && access.role === 'review'
    ? (reviewDrafts[access.reviewSessionId] || null)
    : record.draft;
  const prefill = sourceDraft
    ? {
        answers: sourceDraft.answers || {},
        comment: sourceDraft.comment || '',
        notes: sourceDraft.notes || {},
        annotations: sourceDraft.annotations || [],
        blockEdits: sourceDraft.blockEdits || {},
        // The server draft's save time, so the client can pick the NEWER of this
        // vs. its localStorage mirror (a tab that kept typing while the server
        // was unreachable holds fresher input than the last server save).
        updatedAt: sourceDraft.updatedAt || null,
      }
    : null;
  const boot = { boardId: record.id, spec: clientSpec, prefill, pref: loadPref(), vendor, rev, draftRev, access };
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return fillPage(html, { title: escapeHtml(spec.title), bootJson: json, entry: 'app' }, readUi);
}

export function buildLockedPage(title = 'Relay board') {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fcfbf9;color:#1c1b19;display:grid;min-height:100vh;place-items:center}.box{max-width:420px;padding:28px;text-align:center}.title{font-size:22px;font-weight:650;margin-bottom:8px}.sub{color:#57534e}</style>' +
    '</head><body><div class="box"><div class="title">Share link not active</div><div class="sub">Ask the board owner to use Share and choose a permission before opening this board from another device.</div></div></body></html>';
}
