// The small display blocks: kpi, typography, compare and palette.
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { resolveImageSrc } from './image.js';
import { BLOCK_HEIGHT } from '../constants.js';

// Normalizes one kpi block. `id` is the already-assigned block id.
export function normalizeKpiBlock(rawBlock, id, files, where, hasHeight) {
  // Stat cards: a row of big-number metrics, each with an optional delta
  // (up/down tinted) and sublabel. For "revenue ↑12%" at a glance, no chart.
  const rawItems = Array.isArray(rawBlock.items) ? rawBlock.items : [];
  if (!rawItems.length) throw new CliError(`${where}: kpi block needs a non-empty "items" array of {label, value, delta?, dir?, sub?}.`);
  const items = rawItems.map((it, k) => {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) throw new CliError(`${where}.items[${k}]: must be an object {label, value, …}.`);
    const out = { label: asStr(it.label), value: asStr(it.value) };
    if (it.delta !== undefined && it.delta !== null && it.delta !== '') out.delta = asStr(it.delta);
    const dir = asStr(it.dir ?? it.deltaDir).trim().toLowerCase();
    if (dir === 'up' || dir === 'down' || dir === 'flat') out.dir = dir;
    if (it.sub !== undefined) out.sub = asStr(it.sub);
    return out;
  });
  const block = { id, type: 'kpi', items };
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  return block;
}

// Normalizes one typography block. `id` is the already-assigned block id.
export function normalizeTypographyBlock(rawBlock, id, files, where, hasHeight) {
  // Type specimens: render sample text at given size/weight/font so a designer
  // can react to type choices the way they react to a palette.
  const raw = Array.isArray(rawBlock.specimens) ? rawBlock.specimens : (Array.isArray(rawBlock.samples) ? rawBlock.samples : []);
  if (!raw.length) throw new CliError(`${where}: typography block needs a non-empty "specimens" array of {label?, size?, weight?, text?}.`);
  const specimens = raw.map((s, k) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new CliError(`${where}.specimens[${k}]: must be an object.`);
    const out = { text: asStr(s.text ?? s.sample) || 'The quick brown fox jumps over the lazy dog' };
    if (s.label !== undefined) out.label = asStr(s.label);
    if (s.size !== undefined) out.size = asStr(s.size);
    if (s.weight !== undefined) out.weight = asStr(s.weight);
    if (s.font !== undefined) out.font = asStr(s.font);
    const lh = s.lineHeight ?? s.leading;
    if (lh !== undefined) out.lineHeight = asStr(lh);
    const ls = s.letterSpacing ?? s.tracking;
    if (ls !== undefined) out.letterSpacing = asStr(ls);
    return out;
  });
  const block = { id, type: 'typography', specimens };
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  if (rawBlock.font !== undefined) block.font = asStr(rawBlock.font);
  return block;
}

// Normalizes one compare block. `id` is the already-assigned block id.
export function normalizeCompareBlock(rawBlock, id, files, where, hasHeight) {
  // Before/after: two images with a draggable divider to compare a redesign.
  const beforeRaw = rawBlock.before && typeof rawBlock.before === 'object' ? rawBlock.before.src : (rawBlock.before ?? rawBlock.beforeSrc);
  const afterRaw = rawBlock.after && typeof rawBlock.after === 'object' ? rawBlock.after.src : (rawBlock.after ?? rawBlock.afterSrc);
  const block = {
    id, type: 'compare',
    before: resolveImageSrc(beforeRaw, files, where, '"before"'),
    after: resolveImageSrc(afterRaw, files, where, '"after"'),
  };
  block.beforeLabel = asStr(rawBlock.beforeLabel ?? (rawBlock.before && rawBlock.before.label) ?? 'Before') || 'Before';
  block.afterLabel = asStr(rawBlock.afterLabel ?? (rawBlock.after && rawBlock.after.label) ?? 'After') || 'After';
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}

// Normalizes one palette block. `id` is the already-assigned block id.
export function normalizePaletteBlock(rawBlock, id, files, where, hasHeight) {
  // Accept either { palettes: [{name, colors:[…]}, …] } or a single-palette
  // shorthand { name?, colors:[…] }. Each palette needs a non-empty colors
  // array of CSS color strings (#rrggbb, rgb(), hsl(), named — kept as given).
  const rawList = Array.isArray(rawBlock.palettes)
    ? rawBlock.palettes
    : (Array.isArray(rawBlock.colors) ? [{ name: rawBlock.name, sub: rawBlock.sub, colors: rawBlock.colors }] : null);
  if (!rawList || !rawList.length) {
    throw new CliError(`${where}: palette block needs "palettes" (array) or a "colors" array.`);
  }
  const palettes = rawList.map((p, j) => {
    if (!p || typeof p !== 'object') throw new CliError(`${where}.palettes[${j}]: must be an object with "colors".`);
    const colors = (Array.isArray(p.colors) ? p.colors : [])
      .map((c) => asStr(c).trim())
      .filter(Boolean);
    if (!colors.length) throw new CliError(`${where}.palettes[${j}]: needs a non-empty "colors" array.`);
    const out = { colors };
    if (p.name !== undefined) out.name = asStr(p.name);
    const sub = p.sub ?? p.mood;
    if (sub !== undefined) out.sub = asStr(sub);
    const tag = p.badge ?? p.tag;
    if (tag !== undefined) out.tag = asStr(tag);
    if (p.tagTone !== undefined) out.tagTone = asStr(p.tagTone).trim().toLowerCase();
    if (p.featured === true) out.featured = true;
    return out;
  });
  const block = { id, type: 'palette', palettes };
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  return block;
}
