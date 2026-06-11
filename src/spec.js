import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './util.js';

export const TYPES = ['single', 'multi', 'yesno', 'text', 'textarea', 'scale'];

const ALIASES = {
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
};

const HTML_HEIGHT = { min: 100, max: 2400, boardDefault: 400, questionDefault: 360 };

const asStr = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function readHtml(obj, cwd, where) {
  if (typeof obj.html === 'string' && obj.html.trim()) return obj.html;
  if (typeof obj.htmlFile === 'string' && obj.htmlFile.trim()) {
    const p = path.resolve(cwd, obj.htmlFile);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      throw new CliError(`${where}: cannot read htmlFile "${obj.htmlFile}" (resolved: ${p})`);
    }
  }
  return '';
}

export function normalizeSpec(raw, { cwd = process.cwd() } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('Spec must be a JSON object. Run `qbd agent` for the schema and examples.');
  }
  const spec = {
    title: asStr(raw.title).trim() || 'Quest Board',
    intro: asStr(raw.intro),
    html: readHtml(raw, cwd, 'board'),
    htmlHeight: clampInt(raw.htmlHeight, HTML_HEIGHT.min, HTML_HEIGHT.max, HTML_HEIGHT.boardDefault),
    allowPartial: raw.allowPartial !== false,
    note: raw.note !== false,
    autoClose: raw.autoClose !== false,
    questions: [],
    submitLabel: '',
  };

  const rawQs = raw.questions == null ? [] : raw.questions;
  if (!Array.isArray(rawQs)) throw new CliError('"questions" must be an array.');

  const seen = new Set();
  rawQs.forEach((rq, i) => {
    const where = `questions[${i}]`;
    if (rq === null || typeof rq !== 'object' || Array.isArray(rq)) {
      throw new CliError(`${where}: must be an object.`);
    }
    const label = asStr(rq.label ?? rq.question ?? rq.text).trim();
    if (!label) throw new CliError(`${where}: missing "label".`);

    let type = asStr(rq.type).trim().toLowerCase() || 'text';
    type = ALIASES[type] || type;
    if (!TYPES.includes(type)) {
      throw new CliError(`${where}: unknown type "${rq.type}". Valid: ${TYPES.join(', ')} (plus aliases like radio/checkbox/boolean/rating).`);
    }

    const id = asStr(rq.id).trim() || `q${i + 1}`;
    if (seen.has(id)) throw new CliError(`${where}: duplicate question id "${id}".`);
    seen.add(id);

    const q = {
      id,
      type,
      label,
      description: asStr(rq.description),
      required: rq.required === true,
      html: readHtml(rq, cwd, where),
      htmlHeight: clampInt(rq.htmlHeight, HTML_HEIGHT.min, HTML_HEIGHT.max, HTML_HEIGHT.questionDefault),
      placeholder: asStr(rq.placeholder),
    };

    if (type === 'single' || type === 'multi') {
      const opts = Array.isArray(rq.options) ? rq.options : [];
      q.options = opts.map((o, j) => {
        if (typeof o === 'string' || typeof o === 'number') {
          return { value: String(o), label: String(o) };
        }
        if (o && typeof o === 'object') {
          const value = asStr(o.value ?? o.label).trim();
          const olabel = asStr(o.label ?? o.value).trim();
          if (!value) throw new CliError(`${where}.options[${j}]: needs "value" or "label".`);
          const out = { value, label: olabel || value };
          if (o.description) out.description = asStr(o.description);
          return out;
        }
        throw new CliError(`${where}.options[${j}]: must be a string or {value, label, description?}.`);
      });
      if (q.options.length < 1) {
        throw new CliError(`${where}: type "${type}" needs at least 1 option.`);
      }
      q.other = rq.other === true;
    }

    if (type === 'scale') {
      q.min = clampInt(rq.min, 0, 9, 1);
      q.max = clampInt(rq.max, q.min + 1, 10, Math.max(5, q.min + 1));
      q.minLabel = asStr(rq.minLabel);
      q.maxLabel = asStr(rq.maxLabel);
    }

    if (rq.default !== undefined) q.default = rq.default;
    spec.questions.push(q);
  });

  if (!spec.questions.length && !spec.html) {
    throw new CliError('Spec needs "questions" and/or "html"/"htmlFile" — nothing to show.');
  }
  spec.submitLabel = asStr(raw.submitLabel).trim() || (spec.questions.length ? 'Submit' : 'Acknowledge');
  return spec;
}

// Inline question syntax for `qbd ask -q`:  "[!]label::type::opt1,opt2"
// Leading "!" marks the question required. type defaults to "text".
export function questionFromInline(s, i) {
  let body = asStr(s).trim();
  let required = false;
  if (body.startsWith('!')) {
    required = true;
    body = body.slice(1).trim();
  }
  const [label, type, options] = body.split('::').map((p) => p.trim());
  if (!label) throw new CliError(`-q #${i + 1}: empty question text.`);
  const q = { label, required };
  if (type) q.type = type;
  if (options) q.options = options.split(',').map((o) => o.trim()).filter(Boolean);
  return q;
}

export const SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'quest-board board spec',
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Board title (default "Quest Board")' },
    intro: { type: 'string', description: 'Intro text shown under the title. Newlines preserved.' },
    html: { type: 'string', description: 'Board-level custom HTML, rendered in a sandboxed iframe above the questions.' },
    htmlFile: { type: 'string', description: 'Path to an HTML file (alternative to "html"). Resolved against the CWD.' },
    htmlHeight: { type: 'integer', minimum: 100, maximum: 2400, default: 400, description: 'iframe height in px. Width is always 100% of the content column (~820px max, ~300px min on phones).' },
    allowPartial: { type: 'boolean', default: true, description: 'When true, users may submit with unanswered questions (returned in "skipped").' },
    note: { type: 'boolean', default: true, description: 'Show an optional free-text note box ("Anything else?") returned as "comment".' },
    autoClose: { type: 'boolean', default: true, description: 'Try to close the browser tab automatically after submit.' },
    submitLabel: { type: 'string', description: 'Submit button label. Defaults: "Submit", or "Acknowledge" when there are no questions.' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label'],
        properties: {
          id: { type: 'string', description: 'Answer key in the result JSON. Defaults to q1, q2, …' },
          type: { type: 'string', enum: ['single', 'multi', 'yesno', 'text', 'textarea', 'scale'], default: 'text' },
          label: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean', default: false },
          options: {
            type: 'array',
            description: 'For single/multi. Strings, or {value, label, description}.',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: { value: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } },
                },
              ],
            },
          },
          other: { type: 'boolean', default: false, description: 'single/multi: add a free-text "Other" option. Its text is returned verbatim as the value.' },
          placeholder: { type: 'string', description: 'For text/textarea.' },
          default: { description: 'Pre-selected value. Shape matches the answer shape for the type.' },
          min: { type: 'integer', default: 1, description: 'scale only' },
          max: { type: 'integer', default: 5, maximum: 10, description: 'scale only' },
          minLabel: { type: 'string', description: 'scale only' },
          maxLabel: { type: 'string', description: 'scale only' },
          html: { type: 'string', description: 'Per-question custom HTML (sandboxed iframe above the control).' },
          htmlFile: { type: 'string' },
          htmlHeight: { type: 'integer', minimum: 100, maximum: 2400, default: 360 },
        },
      },
    },
  },
  anyOf: [{ required: ['questions'] }, { required: ['html'] }, { required: ['htmlFile'] }],
};
