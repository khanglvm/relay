// toA2ui: a normalized board spec as the A2UI v1.0 messages that draw it on the board catalog
// (board-catalog.json). It is pure: the host renders, and answers come back through fromA2ui.
import { CliError } from '../util.js';
import {
  A2UI_PROTOCOL_VERSION, ACTION_SUBMIT, BOARD_CATALOG_ID, DATA_ROOT, dataPath, UNSAFE_KEYS,
} from './board-constants.js';

const COMPONENT_OF = {
  markdown: 'Markdown', chart: 'Chart', table: 'Table', code: 'Code', diff: 'Diff', mermaid: 'Mermaid',
  graphviz: 'Graphviz', plantuml: 'Plantuml', image: 'Image', compare: 'Compare', html: 'Html',
  palette: 'Palette', kpi: 'Kpi', typography: 'Typography', video: 'Video', pdf: 'Pdf',
  'git-conflict': 'GitConflict', a2ui: 'Widget',
};

const FALLBACK_CHARS = 2000;
const clip = (s, max = FALLBACK_CHARS) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}…` : String(s ?? ''));

/** The plain text a renderer shows for a block it cannot draw. */
export function fallbackText(block) {
  switch (block.type) {
    case 'markdown': return clip(block.md);
    case 'chart': return clip(`Chart${block.title ? `: ${block.title}` : ''}${block.kind ? ` (${block.kind})` : ''}${Array.isArray(block.labels) ? `. ${block.labels.join(', ')}` : ''}`);
    case 'table': return clip(`Table with ${Array.isArray(block.rows) ? block.rows.length : 0} rows. Columns: ${(block.columns || []).map((c) => (typeof c === 'string' ? c : c.label ?? c.key)).join(', ')}`);
    case 'code': case 'mermaid': case 'plantuml': return clip(block.code);
    case 'graphviz': return clip(block.dot);
    case 'diff': return clip(block.diff);
    case 'image': return clip(block.alt || block.src);
    case 'compare': return clip(`${block.beforeLabel || 'Before'} and ${block.afterLabel || 'After'}`);
    case 'html': return 'Custom page. Open the full board to see it.';
    case 'video': return clip(block.title || `${block.provider} video ${block.videoId}`);
    case 'pdf': return clip(block.title || block.src);
    case 'kpi': return clip((block.items || []).map((i) => `${i.label}: ${i.value}`).join('; '));
    case 'git-conflict': return clip(block.filename || 'A file with merge conflicts');
    case 'a2ui': return clip(block.title || 'Widget');
    default: return clip(block.title || block.type);
  }
}

/** Maps block and question ids to unique component ids that fit the A2UI id rules. */
function idMaker() {
  const used = new Set(['root', 'comment', 'submit']);
  return (prefix, raw) => {
    // A2UI component ids are UAX #31 identifiers: letters, digits and underscores.
    const base = `${prefix}_${String(raw).replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 60);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  };
}

function blockComponent(block, id, extra = {}) {
  const { id: _id, type, a2uiSurface, components, dataModel, express, ...fields } = block;
  const out = { id, component: COMPONENT_OF[type], ...fields, text: fallbackText(block), ...extra };
  if (type === 'a2ui') {
    out.widgetComponents = components ?? [];
    if (dataModel) out.widgetData = dataModel;
  }
  if (!out.title && type !== 'markdown') out.title = block.title ?? block.filename ?? block.type;
  return out;
}

function questionComponent(q, id, childIds) {
  const { id: questionId, type, label, blocks, html, htmlFile, htmlHeight, note, ...rest } = q;
  return {
    id, component: 'Question', questionId, questionType: type, label, ...rest,
    hasNote: note === true,
    text: clip(label),
    value: { '@path': dataPath('answers', questionId) },
    note: { '@path': dataPath('notes', questionId) },
    ...(childIds.length ? { children: childIds } : {}),
  };
}

/** Questions are keyed in the data model by their ids, so the ones that could reach the prototype are refused. */
function assertSafeIds(spec) {
  const bad = spec.questions.find((q) => UNSAFE_KEYS.includes(q.id));
  if (bad) throw new CliError(`question id "${bad.id}" cannot be sent as A2UI; use another id.`);
}

/** The data model a surface starts with: defaults, then the saved draft. */
function initialData(spec, draft) {
  const answers = new Map();
  for (const q of spec.questions) if (q.default !== undefined) answers.set(q.id, q.default);
  const saved = draft && typeof draft === 'object' ? draft : {};
  if (saved.answers && typeof saved.answers === 'object') for (const [k, v] of Object.entries(saved.answers)) answers.set(k, v);
  const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
  return {
    [DATA_ROOT.answers]: Object.fromEntries(answers),
    [DATA_ROOT.notes]: pick(saved.notes),
    [DATA_ROOT.comment]: typeof saved.comment === 'string' ? saved.comment : '',
    [DATA_ROOT.annotations]: {},
    [DATA_ROOT.blockEdits]: pick(saved.blockEdits),
  };
}

/**
 * The three messages that make up a board's surface: createSurface, updateComponents, updateDataModel.
 * @param {Record<string, any>} spec a normalized spec
 * @param {{ surfaceId?: string, draft?: Record<string, any> | null }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function toA2ui(spec, { surfaceId = 'relay-board', draft = null } = {}) {
  assertSafeIds(spec);
  const nextId = idMaker();
  const components = [];
  const children = [];
  const addBlock = (block, extra) => {
    const id = nextId('b', block.id);
    components.push(blockComponent(block, id, extra));
    return id;
  };
  for (const block of spec.blocks || []) children.push(addBlock(block));
  for (const q of spec.questions) {
    const own = [];
    for (const block of q.blocks || []) own.push(addBlock(block));
    for (const option of q.options || []) {
      for (const block of option.blocks || []) own.push(addBlock(block, { optionValue: option.value }));
    }
    const id = nextId('q', q.id);
    components.push(questionComponent({ ...q, options: (q.options || []).map(({ blocks, ...o }) => o) }, id, own));
    children.push(id);
  }
  const display = spec.responseRequired === false;
  if (!display) {
    if (spec.note) {
      components.push({ id: 'comment', component: 'Comment', label: 'Anything else?', value: { '@path': `/${DATA_ROOT.comment}` } });
      children.push('comment');
    }
    components.push({
      id: 'submit', component: 'Submit', label: spec.submitLabel || 'Submit',
      action: { event: { name: ACTION_SUBMIT, context: {} } },
    });
    children.push('submit');
  }
  components.unshift({
    id: 'root', component: 'Board', title: spec.title, text: clip(spec.intro || spec.title),
    ...(spec.intro ? { intro: spec.intro } : {}), children,
    responseRequired: !display, allowPartial: spec.allowPartial !== false,
  });
  const v = A2UI_PROTOCOL_VERSION;
  return [
    { version: v, createSurface: { surfaceId, catalogId: BOARD_CATALOG_ID, sendDataModel: !display } },
    { version: v, updateComponents: { surfaceId, components } },
    { version: v, updateDataModel: { surfaceId, value: initialData(spec, draft) } },
  ];
}
