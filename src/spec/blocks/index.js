// Maps each block type to the function that normalizes it. The html block
// has no entry: normalizeBlock handles it last.
import { normalizeMarkdownBlock } from './markdown.js';
import { normalizeGraphvizBlock, normalizeMermaidBlock, normalizePlantumlBlock } from './diagram.js';
import { normalizeCodeBlock, normalizeDiffBlock } from './code.js';
import { normalizeGitConflictBlock } from './git-conflict.js';
import { normalizeVideoBlock } from './video.js';
import { normalizePdfBlock } from './pdf.js';
import { normalizeChartBlock } from './chart.js';
import { normalizeTableBlock } from './table.js';
import { normalizeImageBlock } from './image.js';
import { normalizeCompareBlock, normalizeKpiBlock, normalizePaletteBlock, normalizeTypographyBlock } from './widgets.js';
import { normalizeA2uiBlock } from './a2ui.js';

export const BLOCK_NORMALIZERS = {
  markdown: normalizeMarkdownBlock,
  mermaid: normalizeMermaidBlock,
  graphviz: normalizeGraphvizBlock,
  plantuml: normalizePlantumlBlock,
  code: normalizeCodeBlock,
  diff: normalizeDiffBlock,
  'git-conflict': normalizeGitConflictBlock,
  video: normalizeVideoBlock,
  pdf: normalizePdfBlock,
  chart: normalizeChartBlock,
  table: normalizeTableBlock,
  image: normalizeImageBlock,
  kpi: normalizeKpiBlock,
  typography: normalizeTypographyBlock,
  compare: normalizeCompareBlock,
  a2ui: normalizeA2uiBlock,
  palette: normalizePaletteBlock,
};
