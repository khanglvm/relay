// Names the A2UI board surface and its negotiation share, in one place. The MIME
// strings and the action tool name come from a2ui.org's "A2UI over MCP" guide, which
// the package source does not confirm and one secondary source spells differently,
// so both MIME spellings are accepted and nothing else in Relay repeats them.

/** Relay's own id for the board catalog; a renderer lists it in `supportedCatalogIds`. */
export const BOARD_CATALOG_ID = 'https://github.com/khanglvm/relay/a2ui/catalog/board/v1';
export const A2UI_PROTOCOL_VERSION = '1.0';

/** The MIME a surface is sent as, then the other spelling a host may declare it under. */
export const A2UI_MIME = 'application/a2ui+json';
export const A2UI_MIMES = [A2UI_MIME, 'application/json+a2ui'];

/** The tool a host calls with a renderer event. */
export const A2UI_ACTION_TOOL = 'a2ui_action';
export const ACTION_SUBMIT = 'relay.submit';
export const ACTION_DRAFT = 'relay.draft';

/** Where the person's input lives in the surface's data model. */
export const DATA_ROOT = {
  answers: 'answers',
  notes: 'notes',
  comment: 'comment',
  annotations: 'annotations',
  blockEdits: 'blockEdits',
};

/** Ids that would reach Object.prototype if used as a data-model key. */
export const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

/** Escapes one data-model path segment (RFC 6901). */
export const pointerSegment = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

/** The data-model pointer for one entry under a root: `/answers/q1`. */
export const dataPath = (root, key) => `/${DATA_ROOT[root]}/${pointerSegment(key)}`;
