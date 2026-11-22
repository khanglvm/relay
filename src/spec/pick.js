// The `pick` question: media tiles the person chooses among. This file reads the
// tiles an agent wrote and cleans the answer a board sends back; drawing is
// src/ui/pick.js.
import { CliError } from '../util.js';
import { resolveImageSrc } from './blocks/image.js';
import { PICK } from './constants.js';
import { asStr, clampInt } from './sources.js';

const HTTP_URL = /^https?:\/\/\S+$/i;
const ID_MAX = 80;

function httpUrl(raw, where, field) {
  const url = asStr(raw).trim();
  if (!HTTP_URL.test(url)) throw new CliError(`${where}: "${field}" must be an http(s) URL${field === 'video' ? ' (a YouTube/Vimeo link or a media file URL; a local video file cannot be a tile)' : ''}.`);
  return url;
}

function normalizeTile(raw, j, where, cwd) {
  if (typeof raw === 'string' || typeof raw === 'number') return { id: String(raw), title: String(raw) };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`${where}.items[${j}]: must be a string or {id, title, image?, video?, url?, caption?}.`);
  }
  const at = `${where}.items[${j}]`;
  const id = asStr(raw.id ?? raw.value ?? raw.title ?? raw.label).trim();
  if (!id) throw new CliError(`${at}: needs an "id" or a "title".`);
  if (id.length > ID_MAX) throw new CliError(`${at}: id is longer than ${ID_MAX} characters.`);
  const tile = { id, title: asStr(raw.title ?? raw.label).trim() || id };
  const caption = asStr(raw.caption ?? raw.description).trim();
  if (caption) tile.caption = caption;
  const image = raw.image ?? raw.src ?? raw.img;
  if (image !== undefined && image !== null && image !== '') tile.image = resolveImageSrc(image, cwd, at, '"image"');
  if (raw.video !== undefined && raw.video !== null && raw.video !== '') tile.video = httpUrl(raw.video, at, 'video');
  if (raw.url !== undefined && raw.url !== null && raw.url !== '') tile.url = httpUrl(raw.url, at, 'url');
  return tile;
}

/**
 * Adds the pick fields to a normalized question: `items`, `min`, `max`, `itemNote`, `overall`.
 * The generic per-question note stays off: a pick carries its own notes.
 * @param {Record<string, any>} q the question being built
 * @param {Record<string, any>} rq what the agent wrote
 */
export function normalizePick(q, rq, where, cwd) {
  const rawItems = Array.isArray(rq.items) ? rq.items : Array.isArray(rq.options) ? rq.options : Array.isArray(rq.choices) ? rq.choices : [];
  if (!rawItems.length) throw new CliError(`${where}: type "pick" needs "items", the tiles to choose among: [{id, title, image?, video?, url?, caption?}].`);
  if (rawItems.length > PICK.maxItems) throw new CliError(`${where}: a pick takes at most ${PICK.maxItems} items.`);
  q.items = rawItems.map((raw, j) => normalizeTile(raw, j, where, cwd));
  const seen = new Set();
  for (const tile of q.items) {
    if (seen.has(tile.id)) throw new CliError(`${where}: duplicate item id "${tile.id}".`);
    seen.add(tile.id);
  }
  const imageBytes = q.items.reduce((sum, t) => sum + (t.image ? t.image.length : 0), 0);
  if (imageBytes > PICK.maxImageBytes) throw new CliError(`${where}: the embedded images add up to ${(imageBytes / 1024 / 1024).toFixed(0)}MB; the limit is ${PICK.maxImageBytes / 1024 / 1024}MB. Use https image URLs or smaller files.`);
  const count = q.items.length;
  q.min = clampInt(rq.min, 0, count, rq.required === true ? 1 : 0);
  q.max = clampInt(rq.max, Math.max(1, q.min), count, count);
  if (q.min > 0) q.required = true;
  q.itemNote = rq.itemNote !== false;
  q.overall = rq.overall !== false;
  q.note = false;
  delete q.placeholder;
}

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const limit = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The answer to a pick question, cut down to what the question allows: known ids
 * once each, at most `max` of them in the order picked, notes only when the tiles
 * take them. Returns undefined when nothing is left, which reads as skipped.
 * @returns {{ picks: Array<{ id: string, note?: string }>, overall?: string } | undefined}
 */
export function cleanPick(q, value) {
  const raw = asObject(value);
  const known = new Set((q.items || []).map((t) => t.id));
  const seen = new Set();
  const picks = [];
  for (const entry of Array.isArray(raw.picks) ? raw.picks : []) {
    const id = typeof entry === 'string' ? entry : asObject(entry).id;
    if (typeof id !== 'string' || !known.has(id) || seen.has(id) || picks.length >= q.max) continue;
    seen.add(id);
    const note = q.itemNote === false || typeof entry === 'string' ? '' : limit(entry.note, PICK.maxNoteChars);
    picks.push(note ? { id, note } : { id });
  }
  const overall = q.overall === false ? '' : limit(raw.overall, PICK.maxOverallChars);
  if (!picks.length && !overall) return undefined;
  return overall ? { picks, overall } : { picks };
}

/**
 * A copy of a board's answers in which every pick answer is cleaned. Other
 * answers pass through as sent, which is how every board already treats them.
 */
export function cleanAnswers(spec, answers) {
  const out = { ...answers };
  for (const q of spec.questions) {
    if (q.type !== 'pick' || !(q.id in out)) continue;
    const cleaned = cleanPick(q, out[q.id]);
    if (cleaned) out[q.id] = cleaned;
    else delete out[q.id];
  }
  return out;
}
