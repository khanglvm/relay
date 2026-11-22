// Limits, allowed values and aliases that the spec readers share.

export const TYPES = ['single', 'multi', 'yesno', 'text', 'textarea', 'scale', 'color', 'rank', 'checklist', 'allocate'];

export const ALIASES = {
  radio: 'single',
  choice: 'single',
  select: 'single',
  checkbox: 'multi',
  checkboxes: 'multi',
  boolean: 'yesno',
  bool: 'yesno',
  yn: 'yesno',
  input: 'text',
  string: 'text',
  longtext: 'textarea',
  long: 'textarea',
  rating: 'scale',
  likert: 'scale',
  colour: 'color',
  swatch: 'color',
  ranking: 'rank',
  order: 'rank',
  ordering: 'rank',
  prioritize: 'rank',
  sort: 'rank',
  signoff: 'checklist',
  'sign-off': 'checklist',
  qa: 'checklist',
  allocation: 'allocate',
  budget: 'allocate',
  distribute: 'allocate',
  points: 'allocate',
};

export const HTML_HEIGHT = { min: 100, max: 2400, boardDefault: 400, questionDefault: 360 };

// Block heights clamp to the same window; defaults vary per block type.
export const BLOCK_HEIGHT = { min: 100, max: 2400 };
export const BLOCK_TYPES = ['markdown', 'mermaid', 'graphviz', 'plantuml', 'chart', 'table', 'code', 'diff', 'git-conflict', 'video', 'pdf', 'html', 'image', 'palette', 'kpi', 'typography', 'compare', 'a2ui'];
export const CHART_KINDS = ['bar', 'line', 'pie', 'doughnut', 'radar', 'scatter'];

// code/diff blocks may load their text from a local file (like htmlFile). Caps
// keep a runaway file from bloating the board payload.
export const TEXT_FILE_MAX_BYTES = 512 * 1024;

// video blocks: a YouTube/Vimeo link embeds via iframe; an http(s) media URL or
// a local file plays in a <video> element (local files stream from the server,
// never embedded, so large clips don't bloat the board).
export const VIDEO_MIMES = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
  ogg: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska',
};
export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;

export const PDF_MIME = 'application/pdf';
export const PDF_MAX_BYTES = 512 * 1024 * 1024;

// image blocks: local files are embedded as data URIs at spec time (the page
// then loads them via /img/b/<id>), so boards stay self-contained offline.
export const IMAGE_MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
};
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
