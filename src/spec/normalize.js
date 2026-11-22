// Turns an agent-written spec into the normalized shape that boards,
// the server and the MCP App read.
import { CliError } from '../util.js';
import { asStr, clampInt, readBlockHtml, readHtml } from './sources.js';
import { ALIASES, BLOCK_ALIASES, BLOCK_HEIGHT, BLOCK_TYPES, CHART_KINDS, HTML_HEIGHT, TYPES } from './constants.js';
import { BLOCK_NORMALIZERS } from './blocks/index.js';
import { normalizePick } from './pick.js';

// Normalizes one block object. `id` is the already-assigned block id.
// Returns the normalized block (with a guaranteed string `type` + `id`).
function normalizeBlock(rawBlock, id, cwd, where) {
  if (rawBlock === null || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
    throw new CliError(`${where}: must be an object with a "type".`);
  }
  let type = asStr(rawBlock.type).trim().toLowerCase();
  if (!type) throw new CliError(`${where}: missing "type". Valid: ${BLOCK_TYPES.join(', ')}.`);
  if (CHART_KINDS.includes(type)) {
    rawBlock = { ...rawBlock, kind: rawBlock.kind ?? type };
    type = 'chart';
  }
  type = BLOCK_ALIASES[type] || type;
  if (!BLOCK_TYPES.includes(type)) {
    throw new CliError(`${where}: unknown block type "${rawBlock.type}". Use one of: ${BLOCK_TYPES.join(', ')}. \`rly schema <type>\` shows its fields.`);
  }

  const hasHeight = rawBlock.height !== undefined && rawBlock.height !== null && rawBlock.height !== '';

































  // type === 'html'
  const normalizer = BLOCK_NORMALIZERS[type];
  if (normalizer) return normalizer(rawBlock, id, cwd, where, hasHeight);

  const html = readBlockHtml(rawBlock, cwd, where);
  if (!html) {
    throw new CliError(`${where}: html block needs an "html" string or readable "htmlFile".`);
  }
  return {
    id,
    type: 'html',
    html,
    height: clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, 360),
  };
}

// Builds the normalized block list for a scope (board or question).
// Legacy html/htmlFile become a PREPENDED html block; ids are assigned in
// final order with `prefix` ('' for board → b1,b2…; '<qid>-' for questions).
function buildBlocks(rawObj, cwd, where, prefix) {
  const blocks = [];
  let n = 0;
  const nextId = () => `${prefix}b${++n}`;

  // Legacy html/htmlFile → a single prepended html block. htmlHeight applies.
  const legacyHtml = readHtml(rawObj, cwd, where);
  if (legacyHtml) {
    const def = prefix ? HTML_HEIGHT.questionDefault : HTML_HEIGHT.boardDefault;
    blocks.push({
      id: nextId(),
      type: 'html',
      html: legacyHtml,
      height: clampInt(rawObj.htmlHeight, HTML_HEIGHT.min, HTML_HEIGHT.max, def),
    });
  }

  if (rawObj.blocks !== undefined && rawObj.blocks !== null) {
    if (!Array.isArray(rawObj.blocks)) throw new CliError(`${where}.blocks: must be an array.`);
    rawObj.blocks.forEach((b, i) => {
      const nb = normalizeBlock(b, nextId(), cwd, `${where}.blocks[${i}]`);
      // Cross-block fields handled uniformly so every block type supports them:
      // `ref` = a stable name a markdown reference link can open in a modal;
      // `pins` = enable coordinate pin-comments on an image.
      if (b && typeof b === 'object') {
        if (typeof b.ref === 'string' && b.ref.trim()) nb.ref = b.ref.trim();
        if (nb.type === 'image' && b.pins === true) nb.pins = true;
      }
      blocks.push(nb);
    });
  }
  return blocks;
}

export function normalizeSpec(raw, { cwd = process.cwd() } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('Spec must be a JSON object. Run `rly agent` for the schema and examples.');
  }
  const spec = {
    title: asStr(raw.title).trim() || 'Relay',
    intro: asStr(raw.intro),
    blocks: buildBlocks(raw, cwd, 'board', ''),
    allowPartial: raw.allowPartial !== false,
    note: raw.note !== false,
    autoClose: raw.autoClose !== false,
    responseRequired: raw.responseRequired !== false,
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
      // Decision types (single/rank/checklist/allocate) show the optional
      // per-answer note by default so the user can qualify their pick; other
      // types stay opt-in. An explicit note:false turns it off.
      note: rq.note === undefined
        ? (type === 'single' || type === 'rank' || type === 'checklist' || type === 'allocate')
        : rq.note === true,
      blocks: buildBlocks(rq, cwd, where, `${id}-`),
      placeholder: asStr(rq.placeholder),
    };

    if (type === 'single' || type === 'multi' || type === 'rank' || type === 'checklist' || type === 'allocate') {
      const opts = Array.isArray(rq.options) ? rq.options : Array.isArray(rq.choices) ? rq.choices : [];
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
          // Per-option visuals: any block type, rendered inside the option card
          // (ids <qid>-o<n>-b<m>). Lets a choice show its example instead of
          // making the user read-and-guess.
          const oblocks = buildBlocks(o, cwd, `${where}.options[${j}]`, `${id}-o${j + 1}-`);
          if (oblocks.length) out.blocks = oblocks;
          return out;
        }
        throw new CliError(`${where}.options[${j}]: must be a string or {value, label, description?, blocks?}.`);
      });
      const minOpts = type === 'rank' ? 2 : 1;
      if (q.options.length < minOpts) {
        throw new CliError(`${where}: type "${type}" needs at least ${minOpts} option${minOpts > 1 ? 's' : ''}.`);
      }
      // Radio (single) questions include an "Other" free-text option by default so
      // the user is never boxed into the listed choices; opt out with other:false.
      // Multi stays opt-in (checkbox lists are usually exhaustive on purpose).
      // rank/checklist/allocate operate over a fixed set, so no "Other".
      if (type === 'single' || type === 'multi') {
        q.other = type === 'single' ? rq.other !== false : rq.other === true;
      }
    }

    if (type === 'pick') normalizePick(q, rq, where, cwd);

    if (type === 'checklist') {
      // Per-item status control. Default Pass / Fail / N/A; override with
      // "statuses" (strings or {value,label,tone?}). tone colors the chip.
      const rawSt = Array.isArray(rq.statuses) && rq.statuses.length
        ? rq.statuses
        : [{ value: 'pass', label: 'Pass', tone: 'ok' }, { value: 'fail', label: 'Fail', tone: 'bad' }, { value: 'na', label: 'N/A', tone: 'muted' }];
      q.statuses = rawSt.map((s, k) => {
        if (typeof s === 'string' || typeof s === 'number') {
          const value = String(s).trim();
          return { value, label: value === 'na' ? 'N/A' : value.charAt(0).toUpperCase() + value.slice(1) };
        }
        if (s && typeof s === 'object') {
          const value = asStr(s.value ?? s.label).trim();
          if (!value) throw new CliError(`${where}.statuses[${k}]: needs "value" or "label".`);
          const out = { value, label: asStr(s.label ?? s.value) || value };
          const tone = asStr(s.tone).trim().toLowerCase();
          if (tone) out.tone = tone;
          return out;
        }
        throw new CliError(`${where}.statuses[${k}]: must be a string or {value, label, tone?}.`);
      });
      if (q.statuses.length < 2) throw new CliError(`${where}: checklist needs ≥2 "statuses".`);
    }

    if (type === 'allocate') {
      q.total = clampInt(rq.total, 1, 1000000, 100);
      if (rq.unit !== undefined) q.unit = asStr(rq.unit);
    }

    if (type === 'scale') {
      q.min = clampInt(rq.min, 0, 9, 1);
      q.max = clampInt(rq.max, q.min + 1, 10, Math.max(5, q.min + 1));
      q.minLabel = asStr(rq.minLabel);
      q.maxLabel = asStr(rq.maxLabel);
    }

    if (type === 'color') {
      // Optional preset swatches the user can click beside the native picker.
      const presets = (Array.isArray(rq.presets) ? rq.presets : [])
        .map((c) => asStr(c).trim())
        .filter(Boolean);
      if (presets.length) q.presets = presets;
      // Richer "pick from a palette": labeled swatch cards. Each click selects
      // that color as the answer and each card is individually commentable.
      // Items: a color string, or {value|color, label?}. Any CSS color system.
      if (Array.isArray(rq.palette) && rq.palette.length) {
        q.palette = rq.palette.map((p, k) => {
          if (typeof p === 'string' || typeof p === 'number') {
            const value = String(p).trim();
            return { value, label: value };
          }
          if (p && typeof p === 'object') {
            const value = asStr(p.value ?? p.color).trim();
            if (!value) throw new CliError(`${where}.palette[${k}]: needs a "value" or "color".`);
            return { value, label: asStr(p.label ?? p.name) || value };
          }
          throw new CliError(`${where}.palette[${k}]: must be a color string or {value/color, label?}.`);
        }).filter((p) => p.value);
      }
    }

    if (rq.default !== undefined) q.default = rq.default;
    spec.questions.push(q);
  });

  if (!spec.questions.length && !spec.blocks.length) {
    throw new CliError('Spec needs "questions" and/or "blocks"/"html" — nothing to show.');
  }
  if (!spec.responseRequired && spec.questions.length) {
    throw new CliError('responseRequired:false makes a display-only board, which cannot hold questions. Remove "responseRequired" to collect answers, or remove "questions" to keep the board display-only.');
  }
  spec.submitLabel = asStr(raw.submitLabel).trim() || (spec.questions.length ? 'Submit' : 'Acknowledge');
  return spec;
}

// Inline question syntax for `rly ask -q`:  "[!]label::type::opt1,opt2"
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
