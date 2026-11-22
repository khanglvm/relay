// The chart block.
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT, CHART_KINDS } from '../constants.js';

// Normalizes one chart block. `id` is the already-assigned block id.
export function normalizeChartBlock(rawBlock, id, cwd, where, hasHeight) {
  const hasConfig = rawBlock.config && typeof rawBlock.config === 'object' && !Array.isArray(rawBlock.config);
  const hasShorthand =
    typeof rawBlock.kind === 'string' ||
    Array.isArray(rawBlock.labels) ||
    Array.isArray(rawBlock.series);
  if (!hasConfig && !hasShorthand) {
    throw new CliError(`${where}: chart needs "config" (full Chart.js config) or "kind"+"labels"+"series".`);
  }
  const block = { id, type: 'chart' };
  block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, 320);
  if (hasConfig) {
    block.config = rawBlock.config;
    return block;
  }
  // Shorthand form: validate kind/labels/series.
  const kind = asStr(rawBlock.kind).trim().toLowerCase();
  if (!kind) throw new CliError(`${where}: chart shorthand needs a "kind" (${CHART_KINDS.join('|')}).`);
  if (!CHART_KINDS.includes(kind)) {
    throw new CliError(`${where}: unknown chart kind "${rawBlock.kind}". Valid: ${CHART_KINDS.join(', ')}.`);
  }
  if (!Array.isArray(rawBlock.labels)) {
    throw new CliError(`${where}: chart shorthand needs a "labels" array.`);
  }
  if (!Array.isArray(rawBlock.series) || rawBlock.series.length < 1) {
    throw new CliError(`${where}: chart shorthand needs a non-empty "series" array of {label, data[]}.`);
  }
  block.kind = kind;
  block.labels = rawBlock.labels.map((l) => asStr(l));
  block.series = rawBlock.series.map((s, k) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new CliError(`${where}.series[${k}]: must be an object {label, data[]}.`);
    }
    if (!Array.isArray(s.data)) {
      throw new CliError(`${where}.series[${k}]: needs a "data" array.`);
    }
    const out = { label: asStr(s.label), data: s.data };
    if (s.color !== undefined) out.color = asStr(s.color);
    return out;
  });
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  return block;
}
