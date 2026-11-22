// `rly schema <name>`: the exact fields of one block or question type, cut out of SPEC_SCHEMA.
import { BLOCK_TYPES, TYPES } from './constants.js';
import { SPEC_SCHEMA } from './schema.js';

const BLOCK_PROPS = SPEC_SCHEMA.properties.blocks.items.properties;
const QUESTION_PROPS = SPEC_SCHEMA.properties.questions.items.properties;

// Fields every block carries on top of its own.
const COMMON_BLOCK_FIELDS = ['type', 'ref', 'height'];

// Which BLOCK_PROPS entries each block type reads. A test checks that every
// property of the block schema belongs to at least one type, so a new field
// cannot be added to the schema without being listed here.
export const BLOCK_FIELDS = {
  markdown: ['md', 'mdFile'],
  mermaid: ['code', 'editable'],
  graphviz: ['dot'],
  plantuml: ['code', 'server'],
  chart: ['kind', 'labels', 'series', 'config', 'title'],
  table: ['columns', 'rows', 'rowsFile', 'sortable', 'filterable', 'exportable'],
  code: ['code', 'codeFile', 'lang', 'filename'],
  diff: ['diff', 'diffFile', 'view', 'review', 'reviewKind', 'commit', 'lang', 'filename'],
  'git-conflict': ['content', 'text', 'file', 'path', 'lang', 'filename'],
  video: ['src', 'alt', 'title'],
  pdf: ['src', 'alt', 'title'],
  html: ['html', 'htmlFile'],
  image: ['src', 'alt', 'pins'],
  palette: ['palettes', 'colors', 'name'],
  kpi: ['items'],
  typography: ['specimens'],
  compare: ['before', 'after', 'beforeLabel', 'afterLabel'],
  a2ui: ['express', 'components', 'dataModel', 'title'],
};

// Fields every question carries on top of its own.
const COMMON_QUESTION_FIELDS = ['id', 'type', 'label', 'description', 'required', 'note', 'blocks'];

export const QUESTION_FIELDS = {
  single: ['options', 'other', 'default'],
  multi: ['options', 'other', 'default'],
  yesno: ['default'],
  text: ['placeholder', 'default'],
  textarea: ['placeholder', 'default'],
  scale: ['min', 'max', 'minLabel', 'maxLabel', 'default'],
  color: ['presets', 'palette', 'default'],
  rank: ['options', 'default'],
  checklist: ['options', 'statuses', 'default'],
  allocate: ['options', 'total', 'unit', 'default'],
};

function pick(props, names) {
  return Object.fromEntries(names.filter((n) => props[n]).map((n) => [n, props[n]]));
}

/** The property names the schema defines for blocks and for questions. */
export function schemaFieldNames() {
  return { block: Object.keys(BLOCK_PROPS), question: Object.keys(QUESTION_PROPS) };
}

/**
 * The fields of one block or question type, or null when the name is neither.
 * A name that is both (`code` is only a block; `color` only a question) never
 * collides today; a block wins if one ever does.
 */
export function lookupSchema(name) {
  const key = String(name).trim().toLowerCase();
  if (BLOCK_TYPES.includes(key)) {
    const fields = pick(BLOCK_PROPS, [...COMMON_BLOCK_FIELDS, ...(BLOCK_FIELDS[key] ?? [])]);
    fields.type = { const: key };
    return { kind: 'block', type: key, fields };
  }
  if (TYPES.includes(key)) {
    const fields = pick(QUESTION_PROPS, [...COMMON_QUESTION_FIELDS, ...(QUESTION_FIELDS[key] ?? [])]);
    fields.type = { const: key };
    return { kind: 'question', type: key, required: ['label'], fields };
  }
  return null;
}
