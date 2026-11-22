// Public surface of the spec module: normalize, check and describe a board spec.
export { TYPES, BLOCK_TYPES } from './constants.js';
export { assertSpecReady } from './ready.js';
export { normalizeSpec, questionFromInline } from './normalize.js';
export { SPEC_SCHEMA } from './schema.js';
