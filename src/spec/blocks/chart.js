// The chart block.
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT, CHART_KINDS, CHART_KIND_FIELDS, CHART_SERIES_FIELDS } from '../constants.js';

// The first spelling of a field the agent used, so `chartType` or Chart.js's `datasets` work.
const firstDefined = (raw, names) => raw[names.find((n) => raw[n] !== undefined)];

// Normalizes one chart block. `id` is the already-assigned block id.
export function normalizeChartBlock(raw, id, cwd, where, hasHeight) {
  const rawBlock = { ...raw, kind: firstDefined(raw, CHART_KIND_FIELDS), series: firstDefined(raw, CHART_SERIES_FIELDS) };
  const hasConfig = rawBlock.config && typeof rawBlock.config === 'object' && !Array.isArray(rawBlock.config);
  const hasShorthand =
    typeof rawBlock.kind === 'string' ||
    Array.isArray(rawBlock.labels) ||
    Array.isArray(rawBlock.series);
  if (!hasConfig && !hasShorthand) {
    throw new CliError(`${where}: a chart needs "kind" (${CHART_KINDS.join('|')}), "labels" and "series": [{"label","data":[...]}], or a full Chart.js "config". \`rly schema chart\` shows the fields.`);
  }
  const block = { id, type: 'chart' };
  block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, 320);
  if (hasConfig) {
    block.config = rawBlock.config;
    return block;
  }
  // Shorthand form: validate kind/labels/series.
  const kind = asStr(rawBlock.kind).trim().toLowerCase();
  if (!kind) throw new CliError(`${where}: add "kind": one of ${CHART_KINDS.join('|')}.`);
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
