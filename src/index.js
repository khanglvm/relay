// Public library entry (`import ... from '@khanglvm/relay'`). It exposes the
// spec checks and the board store without starting a server or a browser.
import { compileExpress, validateSurface } from './a2ui/compile.js';
import { normalizeSpec } from './spec/index.js';
import { createBoard as storeBoard } from './store.js';

/**
 * A board spec as an agent writes it: `questions`, `blocks`, or both. Run
 * `rly agent` or read schema/spec.v1.json for every field.
 * @typedef {object} RelaySpec
 * @property {1} [version] Spec version; a spec without it is read as version 1.
 * @property {string} [$schema] Schema URL, ignored by Relay.
 * @property {string} [title]
 * @property {string} [intro]
 * @property {Array<Record<string, unknown>>} [blocks] Board-level blocks.
 * @property {Array<Record<string, unknown>>} [questions]
 * @property {boolean} [allowPartial] Let the user submit with unanswered questions.
 * @property {boolean} [note] Show the free-text "Anything else?" box.
 * @property {boolean} [autoClose] Close the browser tab after submit.
 * @property {boolean} [responseRequired] False for a display-only board.
 * @property {string} [submitLabel]
 */

/**
 * A comment the user attached to one element of a block.
 * @typedef {object} Annotation
 * @property {string} id
 * @property {string | null} questionId
 * @property {string | null} blockId
 * @property {{ kind: string } & Record<string, unknown>} target What the comment points at.
 * @property {string} text
 * @property {string} createdAt ISO timestamp.
 */

/**
 * What `rly result` prints once the user submits.
 * @typedef {object} RelayResult
 * @property {Record<string, unknown>} answers Answer per question id.
 * @property {Record<string, string>} [notes] Per-question note text.
 * @property {string} [comment] The "Anything else?" text.
 * @property {string[]} [skipped] Question ids left unanswered.
 * @property {Annotation[]} [annotations]
 * @property {Record<string, unknown> | null} [blockEdits] Edited block payloads by block id.
 */

/**
 * A board stored on disk under RLY_HOME (default ~/.relay).
 * @typedef {object} BoardRecord
 * @property {string} id
 * @property {string} createdAt ISO timestamp.
 * @property {string} title
 * @property {string} cwd Directory the board was authored in.
 * @property {Record<string, unknown>} spec The normalized spec.
 * @property {unknown} draft
 * @property {RelayResult | null} result
 */

/**
 * A validated A2UI surface: a flat component list plus an optional data model.
 * @typedef {object} A2uiSurface
 * @property {Array<Record<string, unknown>>} components
 * @property {Record<string, unknown>} [dataModel]
 */

/**
 * Checks a spec without throwing. Reads the files a spec names (`mdFile`,
 * `rowsFile`) relative to `cwd`. Mermaid syntax and A2UI Express are checked
 * later, when a board opens.
 * @param {unknown} raw
 * @param {{ cwd?: string }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSpec(raw, options) {
  try {
    normalizeSpec(raw, options);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Normalizes a spec and stores it as a new board, the way `rly ask` does
 * before it opens one. Throws when the spec is invalid.
 * @param {unknown} raw
 * @param {{ cwd?: string }} [options]
 * @returns {BoardRecord}
 */
export function createBoard(raw, options) {
  return storeBoard(normalizeSpec(raw, options));
}

/**
 * Compiles A2UI Express text, or checks ready components, into a surface that
 * the board draws.
 * @param {string | A2uiSurface} source
 * @returns {Promise<A2uiSurface>}
 */
export async function compileA2ui(source) {
  const surface = typeof source === 'string' ? await compileExpress(source) : source;
  return validateSurface(surface);
}

export { normalizeSpec };
