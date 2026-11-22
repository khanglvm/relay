// fromA2ui: the data model a renderer sends back, as the payload a board submit takes.
// It applies the same "was this answered" rules the web board does, so both surfaces
// produce one result for one set of answers. It is pure: the caller stores the result.
import { cleanPick } from '../spec/pick.js';
import { DATA_ROOT } from './board-constants.js';

const NOTE_MAX = 20000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** The value to submit for one answer, or undefined while the question counts as unanswered. */
export function answeredValue(q, raw) {
  switch (q.type) {
    case 'single': return typeof raw === 'string' && raw ? raw : undefined;
    case 'multi': {
      const picked = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string' && v) : [];
      return picked.length ? picked : undefined;
    }
    case 'yesno': return raw === 'yes' || raw === 'no' ? raw : undefined;
    case 'scale': return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    case 'rank': return Array.isArray(raw) && raw.length ? [...raw] : undefined;
    case 'checklist': return isObject(raw) && Object.keys(raw).length ? { ...raw } : undefined;
    case 'allocate': {
      const sum = isObject(raw) ? Object.values(raw).reduce((a, n) => a + (Number(n) || 0), 0) : 0;
      return sum > 0 ? { ...raw } : undefined;
    }
    case 'pick': return cleanPick(q, raw);
    default: return text(raw) || undefined;
  }
}

/** Block comments (`/annotations/<blockId>`: text) as the annotation records a result carries. */
function blockAnnotations(spec, raw, now) {
  const owner = new Map();
  for (const q of spec.questions) for (const b of q.blocks || []) owner.set(b.id, q.id);
  const known = new Set([...owner.keys(), ...(spec.blocks || []).map((b) => b.id)]);
  return Object.keys(isObject(raw) ? raw : {})
    .filter((blockId) => known.has(blockId) && text(raw[blockId]))
    .map((blockId) => ({
      id: `a2ui-${blockId}`, questionId: owner.get(blockId) ?? null, blockId,
      target: { kind: 'block' }, text: text(raw[blockId]).slice(0, 5000), createdAt: now,
    }));
}

/**
 * @param {Record<string, any>} dataModel the surface's data model: /answers, /notes, /comment, /annotations, /blockEdits
 * @param {Record<string, any>} spec the normalized spec the surface was made from
 * @returns {{ answers: Record<string, unknown>, comment: string, notes: Record<string, string>, annotations: object[], blockEdits: Record<string, unknown> }}
 */
export function fromA2ui(dataModel, spec, { now = new Date().toISOString() } = {}) {
  const model = isObject(dataModel) ? dataModel : {};
  const rawAnswers = model[DATA_ROOT.answers];
  const rawNotes = model[DATA_ROOT.notes];
  const answers = {};
  const notes = {};
  for (const q of spec.questions) {
    const value = answeredValue(q, own(rawAnswers, q.id));
    if (value !== undefined) answers[q.id] = value;
    const note = text(own(rawNotes, q.id));
    if (note) notes[q.id] = note.slice(0, NOTE_MAX);
  }
  const edits = model[DATA_ROOT.blockEdits];
  return {
    answers,
    comment: text(model[DATA_ROOT.comment]).slice(0, NOTE_MAX),
    notes,
    annotations: blockAnnotations(spec, model[DATA_ROOT.annotations], now),
    blockEdits: isObject(edits) ? edits : {},
  };
}
