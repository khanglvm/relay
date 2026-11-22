// What each relay tool does to a board, apart from MCP framing: build, view, draft, submit, read.
import { assertSpecReady, normalizeSpec } from '../spec/index.js';
import { CliError } from '../util.js';
import { saveBoardArtifact } from '../store.js';
import { sanitizeAnnotations, sanitizeBlockEdits } from '../server/sanitize.js';
import { ARTIFACT_MAX_BYTES, ARTIFACT_MIMES } from '../server/result.js';
import { RESULT_BUDGET_BYTES } from './constants.js';

const MAX_TEXT = 20000;
const MAX_EVENTS = 200;

const limit = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** One board call's mode: a board that wants a reply is `ask`, anything else `show`. Questions always want a reply. */
export const modeOf = (spec) => (spec.responseRequired === false ? 'show' : 'ask');

/**
 * Normalizes the tool arguments into a stored board. Spec errors come back as
 * CliError so the tool can answer with an isError result the model can fix.
 * @param {import('./store.js').RelayStore} store
 * @param {Record<string, any>} args
 * @param {{ displayOnly?: boolean }} [options]
 */
export async function createMcpBoard(store, args, options = {}) {
  const raw = { ...args };
  const hasQuestions = Array.isArray(raw.questions) && raw.questions.length > 0;
  if (options.displayOnly || (!hasQuestions && raw.responseRequired === undefined)) raw.responseRequired = false;
  const spec = normalizeSpec(raw);
  await assertSpecReady(spec);
  const record = await store.create(spec);
  return { record, spec, mode: modeOf(spec) };
}

/** The compact list of questions a model sees in the relay_board result: id, type, label. */
export function questionList(spec, labelMax = 80) {
  return spec.questions.map((q) => ({ id: q.id, type: q.type, label: limit(q.label, labelMax), ...(q.required ? { required: true } : {}) }));
}

/**
 * The relay_board result: a summary and structuredContent, never the spec.
 * The question list shrinks until the whole result fits RESULT_BUDGET_BYTES.
 * @returns {ToolResult}
 */
export function boardResult(record, spec, mode) {
  const text = mode === 'ask'
    ? `Board "${spec.title}" (${record.id}) is on screen${spec.questions.length ? ` with ${spec.questions.length} question${spec.questions.length === 1 ? '' : 's'}` : ' for the person to acknowledge'}. They answer there. Read the answers with relay_result {boardId, wait_seconds}. Do not re-ask them in chat.`
    : `Board "${spec.title}" (${record.id}) is on screen, display-only. Continue without waiting.`;
  for (const labelMax of [80, 40, 20, 0]) {
    const structuredContent = { boardId: record.id, mode, title: spec.title, questions: questionList(spec, labelMax) };
    const size = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(structuredContent));
    if (size <= RESULT_BUDGET_BYTES) return { content: [{ type: 'text', text }], structuredContent };
  }
  const structuredContent = { boardId: record.id, mode, title: limit(spec.title, 80), questionCount: spec.questions.length };
  return { content: [{ type: 'text', text }], structuredContent };
}

/** @typedef {import('@modelcontextprotocol/server').CallToolResult} ToolResult */

/** @returns {ToolResult} */
export const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/** An invalid spec as a tool error; anything else is a server bug and rethrows. */
export function specError(err) {
  if (err instanceof CliError) return errorResult(`relay: invalid board spec. ${err.message}`);
  throw err;
}

/** Saves the person's answers so far, so relay_result can show them before the final submit. */
export async function saveDraft(store, id, draft) {
  const d = asObject(draft);
  return store.update(id, {
    draft: {
      answers: asObject(d.answers),
      comment: limit(d.comment, MAX_TEXT),
      notes: asObject(d.notes),
      annotations: sanitizeAnnotations(d.annotations, id),
      updatedAt: new Date().toISOString(),
    },
  });
}

// An iframe sends a region crop as base64; the record keeps a file path, like the browser board.
function persistCrops(id, annotations) {
  if (!Array.isArray(annotations)) return annotations;
  return annotations.map((a) => {
    const crop = a && a.target && a.target.crop;
    if (!crop || typeof crop.data !== 'string' || !ARTIFACT_MIMES[crop.mime || 'image/png']) return a;
    const bytes = Buffer.from(crop.data, 'base64');
    if (!bytes.length || bytes.length > ARTIFACT_MAX_BYTES) return { ...a, target: { ...a.target, crop: undefined } };
    const path = saveBoardArtifact(id, bytes, ARTIFACT_MIMES[crop.mime || 'image/png']);
    return { ...a, target: { ...a.target, crop: { path, mime: crop.mime || 'image/png', width: crop.width, height: crop.height } } };
  });
}

/**
 * Stores the final answers. A second submit is refused so a stray click cannot
 * overwrite what the agent may already have read.
 * @returns {Promise<{ ok: boolean, status?: string, error?: string }>}
 */
export async function submitBoard(store, record, body) {
  if (record.spec.responseRequired === false) return { ok: false, error: 'this board is display-only' };
  if (record.result) return { ok: false, error: 'this board was already submitted' };
  const b = asObject(body);
  const answers = asObject(b.answers);
  const status = record.spec.questions.length ? 'submitted' : 'acknowledged';
  const result = {
    status,
    answers,
    skipped: record.spec.questions.filter((q) => !(q.id in answers)).map((q) => q.id),
    comment: limit(b.comment, MAX_TEXT),
    notes: asObject(b.notes),
    annotations: sanitizeAnnotations(persistCrops(record.id, b.annotations), record.id),
    blockEdits: sanitizeBlockEdits(b.blockEdits),
    submittedAt: new Date().toISOString(),
  };
  await store.update(record.id, { result });
  return { ok: true, status };
}

/** Appends one a2ui button click for relay_result to report. */
export async function recordEvent(store, record, event) {
  const e = asObject(event);
  const entry = { blockId: limit(e.blockId, 200), name: limit(e.name, 200), context: asObject(e.context), at: new Date().toISOString() };
  const events = [...(record.events || []), entry].slice(-MAX_EVENTS);
  await store.update(record.id, { events });
  return entry;
}

/** What relay_result reports for a board right now. */
export function resultOf(record) {
  const r = record.result;
  if (r) return { boardId: record.id, ...r, ...(record.events?.length ? { events: record.events } : {}) };
  const status = record.spec.responseRequired === false ? 'display-only' : 'open';
  return {
    boardId: record.id,
    status,
    ...(record.draft ? { draft: record.draft } : {}),
    ...(record.events?.length ? { events: record.events } : {}),
  };
}

export const isFinal = (record) => Boolean(record.result) || record.spec.responseRequired === false;
