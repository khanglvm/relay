// What each relay tool does to a board, apart from MCP framing: build, view, draft, submit, read.
import { assertSpecReady, cleanAnswers, normalizeSpec } from '../spec/index.js';
import { CliError } from '../util.js';
import { saveBoardArtifact } from '../store.js';
import { ACTION_DRAFT, ACTION_SUBMIT } from '../a2ui/board-constants.js';
import { assertSafeJson } from '../a2ui/compile.js';
import { fromA2ui } from '../a2ui/from-a2ui.js';
import { findBlock, sanitizeAnnotations, sanitizeBlockEdits } from '../server/sanitize.js';
import { ARTIFACT_MAX_BYTES, ARTIFACT_MIMES, artifactBytesMatch } from '../server/result.js';
import { RESULT_BUDGET_BYTES } from './constants.js';

const MAX_TEXT = 20000;
const MAX_EVENTS = 200;
const MAX_CROPS = 500;
const MAX_CROP_BASE64 = Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4;
const MAX_EVENT_CONTEXT = 4096;
const EVENT_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

const limit = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** One board call's mode: a board that wants a reply is `ask`, anything else `show`. Questions always want a reply. */
export const modeOf = (spec) => (spec.responseRequired === false ? 'show' : 'ask');

/**
 * Normalizes the tool arguments into a stored board. Spec errors come back as
 * CliError so the tool can answer with an isError result the model can fix.
 * @param {import('./store.js').RelayStore} store
 * @param {Record<string, any>} args
 * @param {{ displayOnly?: boolean, fileRoots?: string[] }} [options] `fileRoots` are the only places a spec may read local files from; none by default
 */
export async function createMcpBoard(store, args, options = {}) {
  const fileRoots = options.fileRoots ?? [];
  const raw = { ...args };
  const hasQuestions = Array.isArray(raw.questions) && raw.questions.length > 0;
  if (options.displayOnly || (!hasQuestions && raw.responseRequired === undefined)) raw.responseRequired = false;
  const spec = normalizeSpec(raw, { fileRoots });
  await assertSpecReady(spec);
  const record = await store.create(spec, { fileRoots });
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
  const title = limit(spec.title, 120);
  const text = mode === 'ask'
    ? `Board "${title}" (${record.id}) is on screen${spec.questions.length ? ` with ${spec.questions.length} question${spec.questions.length === 1 ? '' : 's'}` : ' for the person to acknowledge'}. They answer there. Read the answers with relay_result {boardId, wait_seconds}. Do not re-ask them in chat.`
    : `Board "${title}" (${record.id}) is on screen, display-only. Continue without waiting.`;
  for (const labelMax of [80, 40, 20, 0]) {
    const structuredContent = { boardId: record.id, mode, title, questions: questionList(spec, labelMax) };
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
export async function saveDraft(store, id, draft, spec) {
  const d = asObject(draft);
  return store.update(id, {
    draft: {
      answers: spec ? cleanAnswers(spec, asObject(d.answers)) : asObject(d.answers),
      comment: limit(d.comment, MAX_TEXT),
      notes: asObject(d.notes),
      annotations: sanitizeAnnotations(d.annotations, id),
      updatedAt: new Date().toISOString(),
    },
  });
}

/** One base64 region crop written to the board's artifacts, under the same checks as the browser board's upload. */
function persistCrop(id, crop) {
  const mime = crop.mime ?? 'image/png';
  if (crop.data.length > MAX_CROP_BASE64 || !Object.hasOwn(ARTIFACT_MIMES, mime)) return undefined;
  const bytes = Buffer.from(crop.data, 'base64');
  if (!bytes.length || bytes.length > ARTIFACT_MAX_BYTES || !artifactBytesMatch(mime, bytes)) return undefined;
  return { path: saveBoardArtifact(id, bytes, ARTIFACT_MIMES[mime]), mime, width: crop.width, height: crop.height };
}

// An iframe sends a region crop as base64; the record keeps a file path, like the browser board.
// Only a crop the sanitizer will keep is written, so a submit cannot fill the disk with dropped files.
function persistCrops(id, annotations) {
  if (!Array.isArray(annotations)) return annotations;
  let written = 0;
  return annotations.map((a) => {
    const crop = a && a.target && a.target.crop;
    if (!crop || typeof crop.data !== 'string') return a;
    const keep = written < MAX_CROPS && a.target.kind === 'image-region' && typeof a.text === 'string' && a.text.length <= 5000;
    const saved = keep ? persistCrop(id, crop) : undefined;
    if (saved) written++;
    return { ...a, target: { ...a.target, crop: saved } };
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
  const answers = cleanAnswers(record.spec, asObject(b.answers));
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

/**
 * Appends one a2ui button click for relay_result to report. The click must name
 * an a2ui block on this board and pass the checks the browser board applies to a2ui state.
 * @returns {Promise<{ ok: boolean, entry?: object, error?: string }>}
 */
export async function recordEvent(store, record, event) {
  const e = asObject(event);
  if (typeof e.blockId !== 'string' || !findBlock(record.spec, e.blockId, 'a2ui')) return { ok: false, error: 'no a2ui block with that id' };
  if (typeof e.name !== 'string' || !EVENT_NAME.test(e.name)) return { ok: false, error: 'invalid a2ui event name' };
  const context = asObject(e.context);
  try {
    assertSafeJson(context, 'a2ui event');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (JSON.stringify(context).length > MAX_EVENT_CONTEXT) return { ok: false, error: 'a2ui event context is too large' };
  const entry = { blockId: e.blockId, name: e.name, context, at: new Date().toISOString() };
  const events = [...(record.events || []), entry].slice(-MAX_EVENTS);
  await store.update(record.id, { events });
  return { ok: true, entry };
}

/**
 * A renderer event from an A2UI surface. `relay.submit` and `relay.draft` carry the surface's
 * data model and store it as a submit or a draft; any other name is a widget button click.
 * @returns {Promise<{ ok: boolean, status?: string, error?: string }>}
 */
export async function handleSurfaceAction(store, record, args) {
  const action = asObject(args.action);
  const name = typeof action.name === 'string' ? action.name : args.name;
  if (name !== ACTION_SUBMIT && name !== ACTION_DRAFT) {
    const blockId = args.blockId;
    return recordEvent(store, record, { blockId, name, context: args.context ?? action.context });
  }
  const dataModel = args.dataModel ?? asObject(action.context).dataModel ?? action.dataModel;
  if (!dataModel || typeof dataModel !== 'object') return { ok: false, error: 'the event carries no data model' };
  const payload = fromA2ui(dataModel, record.spec);
  if (name === ACTION_SUBMIT) return submitBoard(store, record, payload);
  await saveDraft(store, record.id, payload, record.spec);
  return { ok: true };
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
