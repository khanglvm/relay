// Turns what an agent writes for an `a2ui` block into a safe, flat A2UI v1.0
// surface ({components, dataModel}) that the board's renderer can draw.
// Two inputs: A2UI Express text (compiled by the vendored @a2ui/agent SDK) or
// ready JSON components. Both pass the same checks against Relay's catalog.
// Drawing is src/ui/a2ui.js; this module never touches the DOM.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError } from '../util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_FILE = path.join(HERE, 'catalog.json');
const SDK_FILE = path.join(HERE, 'vendor', 'a2ui-agent.mjs');

export const A2UI_LIMITS = {
  // The SDK's parser holds about 400 times the text in memory, so this bounds it.
  expressChars: 64 * 1024,
  components: 60,
  componentsBytes: 96 * 1024,
  dataBytes: 64 * 1024,
  depth: 12,
  eventContextBytes: 1024,
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POINTER_RE = /^\/[A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/;
const EVENT_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Security: @a2ui/agent 0.1.0's Express compiler writes `$/__proto__/x = 1`
// (and `$/constructor/prototype/x = 1`) onto Object.prototype of the running
// process, so such text never reaches it. Bump with the SDK once upstream fixes it.
const UNSAFE_EXPRESS = /__proto__|\$\/?(?:[\w-]+\/)*(?:constructor|prototype)\b/;

let catalogCache;
/** Relay's catalog: component name -> JSON-schema-style definition. */
export function loadCatalog() {
  catalogCache ??= JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  return catalogCache;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Refuses prototype-polluting keys anywhere in a JSON-like value, and runaway nesting. */
export function assertSafeJson(value, where, depth = 0) {
  if (depth > A2UI_LIMITS.depth) throw new CliError(`${where}: nested deeper than ${A2UI_LIMITS.depth} levels.`);
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafeJson(item, where, depth + 1));
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) throw new CliError(`${where}: the key "${key}" is not allowed.`);
      assertSafeJson(value[key], where, depth + 1);
    }
  }
}

/** Size and path checks that run before the SDK sees the text. */
export function guardExpress(text, where) {
  if (typeof text !== 'string' || !text.trim()) throw new CliError(`${where}: "express" must be A2UI Express text with a \`root = ...\` line.`);
  if (text.length > A2UI_LIMITS.expressChars) throw new CliError(`${where}: "express" is over ${A2UI_LIMITS.expressChars} characters.`);
  if (UNSAFE_EXPRESS.test(text)) throw new CliError(`${where}: express cannot use __proto__, or constructor or prototype in a $/path.`);
  return text;
}

/** Agents paste the block with or without its `<a2ui>` tags, and sometimes inside a Markdown fence. */
export function wrapExpress(source) {
  const text = source.trim().replace(/^```[a-z0-9-]*\n/i, '').replace(/\n```$/, '').trim();
  return text.startsWith('<a2ui>') ? text : `<a2ui>\n${text}\n</a2ui>`;
}

let processorPromise;
// Loaded on first use, so a board without Express never reads the 600 KB bundle.
function sdkProcessor() {
  processorPromise ??= import(pathToFileURL(SDK_FILE).href).then((sdk) => {
    const catalog = sdk.CatalogConfig.fromPath(CATALOG_FILE);
    const generator = new sdk.A2uiGenerator([catalog]);
    return generator.createProcessor({ '1.0': { supportedCatalogIds: [catalog.catalog.id] } });
  }).catch((err) => {
    processorPromise = undefined;
    throw new CliError(`a2ui express cannot be compiled right now (${err && err.message ? err.message : err}); send the tree as "components" JSON instead.`, 1);
  });
  return processorPromise;
}

/** Compiles one Express block into flat components (root first) and the data model its `$/path = value` lines set. */
export async function compileExpress(source, where = 'a2ui') {
  guardExpress(source, where);
  const processor = await sdkProcessor();
  let parts;
  try {
    parts = processor.parseResponse(wrapExpress(source));
  } catch (err) {
    throw new CliError(`${where}: express did not compile: ${err && err.message ? err.message : err}`);
  }
  const created = parts.flatMap((part) => part.a2ui ?? []).map((message) => message.createSurface).filter(Boolean);
  if (created.length !== 1) throw new CliError(`${where}: express must hold exactly one \`root = ...\` tree.`);
  const { components, dataModel } = created[0];
  return { components, ...(dataModel && Object.keys(dataModel).length ? { dataModel } : {}) };
}

// ---------- validation against the catalog ----------

const DYNAMIC = {
  DynamicString: (v) => typeof v === 'string',
  DynamicNumber: (v) => typeof v === 'number' && Number.isFinite(v),
  DynamicBoolean: (v) => typeof v === 'boolean',
  DynamicValue: () => true,
};

function checkBinding(value, where) {
  const pointer = value['@path'];
  if (typeof pointer !== 'string' || !POINTER_RE.test(pointer)) throw new CliError(`${where}: "@path" must be a data-model pointer like /jobs.`);
  if (pointer.split('/').some((seg) => UNSAFE_KEYS.has(seg))) throw new CliError(`${where}: "@path" cannot name __proto__, constructor or prototype.`);
}

function checkAction(action, where) {
  if (!isPlainObject(action)) throw new CliError(`${where}: action must be Event("name", {...}) or openUrl("https://...").`);
  if (isPlainObject(action.event)) {
    const { name, context } = action.event;
    if (typeof name !== 'string' || !EVENT_NAME_RE.test(name)) throw new CliError(`${where}: event name must be lowercase letters, digits, - or _ (max 40).`);
    if (context !== undefined) {
      if (!isPlainObject(context)) throw new CliError(`${where}: event context must be a map.`);
      if (JSON.stringify(context).length > A2UI_LIMITS.eventContextBytes) throw new CliError(`${where}: event context is over ${A2UI_LIMITS.eventContextBytes} bytes.`);
    }
    return;
  }
  const call = action.functionCall;
  if (isPlainObject(call) && call['@call'] === 'openUrl' && isPlainObject(call.args)) {
    if (typeof call.args.url !== 'string' || !/^https:\/\//i.test(call.args.url)) throw new CliError(`${where}: openUrl takes an https:// link.`);
    return;
  }
  throw new CliError(`${where}: action must be Event("name", {...}) or openUrl("https://...").`);
}

function checkProp(schema, value, where) {
  const ref = typeof schema.$ref === 'string' ? schema.$ref.split('/').pop() : '';
  if (ref === 'Action') return checkAction(value, where);
  if (ref === 'ChildList') {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !ID_RE.test(id))) {
      throw new CliError(`${where}: children must be a list of component ids.`);
    }
    return undefined;
  }
  if (DYNAMIC[ref]) {
    if (isPlainObject(value) && '@path' in value) return checkBinding(value, where);
    if (!DYNAMIC[ref](value)) throw new CliError(`${where}: expected ${ref.replace('Dynamic', '').toLowerCase()} or a $/path binding.`);
    return undefined;
  }
  return checkPlain(schema, value, where);
}

function checkPlain(schema, value, where) {
  if (schema.const !== undefined) {
    if (value !== schema.const) throw new CliError(`${where}: must be ${JSON.stringify(schema.const)}.`);
    return;
  }
  const type = schema.type;
  if (type === 'string') {
    if (typeof value !== 'string') throw new CliError(`${where}: must be a string.`);
    if (schema.enum && !schema.enum.includes(value)) throw new CliError(`${where}: must be one of ${schema.enum.join(', ')}.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new CliError(`${where}: "${value.slice(0, 40)}" is not allowed here (pattern ${schema.pattern}).`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) throw new CliError(`${where}: must be a ${type}.`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new CliError(`${where}: must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new CliError(`${where}: must be at most ${schema.maximum}.`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new CliError(`${where}: must be true or false.`);
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new CliError(`${where}: must be a list.`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new CliError(`${where}: needs at least ${schema.minItems} items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new CliError(`${where}: takes at most ${schema.maxItems} items.`);
    if (schema.items) value.forEach((item, i) => checkProp(schema.items, item, `${where}[${i}]`));
  } else if (type === 'object') {
    if (!isPlainObject(value)) throw new CliError(`${where}: must be a map.`);
    const props = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (!(key in props)) throw new CliError(`${where}: unknown key "${key}".`);
      checkProp(props[key], value[key], `${where}.${key}`);
    }
    for (const key of schema.required || []) if (!(key in value)) throw new CliError(`${where}: missing "${key}".`);
  }
}

function checkComponent(def, comp, where) {
  const props = def.properties;
  for (const key of Object.keys(comp)) {
    if (key === 'id') continue;
    if (!(key in props)) throw new CliError(`${where}: ${comp.component} has no "${key}" property. Known: ${Object.keys(props).filter((k) => k !== 'component').join(', ') || 'none'}.`);
    checkProp(props[key], comp[key], `${where}.${key}`);
  }
  for (const key of def.required || []) if (!(key in comp)) throw new CliError(`${where}: ${comp.component} needs "${key}".`);
}

/** Every component is reachable from `root`, in one place only, with no cycles. */
function assertTree(byId, where) {
  const seen = new Set();
  const walk = (id, trail) => {
    if (trail.includes(id)) throw new CliError(`${where}: component "${id}" contains itself.`);
    if (seen.has(id)) throw new CliError(`${where}: component "${id}" sits in two parents; give each its own id.`);
    seen.add(id);
    const comp = byId.get(id);
    if (!comp) throw new CliError(`${where}: children name "${id}", which is not defined.`);
    for (const child of Array.isArray(comp.children) ? comp.children : []) walk(child, [...trail, id]);
  };
  walk('root', []);
  const orphan = [...byId.keys()].find((id) => !seen.has(id));
  if (orphan) throw new CliError(`${where}: component "${orphan}" is not reachable from root.`);
}

/**
 * Validates a flat surface against Relay's catalog and returns it as plain data.
 * Throws a CliError worded for the agent that wrote it.
 * @param {{ components: any, dataModel?: any }} surface
 * @param {string} [where]
 */
export function validateSurface({ components, dataModel }, where = 'a2ui') {
  const catalog = loadCatalog().components;
  if (!Array.isArray(components) || !components.length) throw new CliError(`${where}: "components" must be a non-empty list.`);
  if (components.length > A2UI_LIMITS.components) throw new CliError(`${where}: ${components.length} components; the most a board widget takes is ${A2UI_LIMITS.components}.`);
  assertSafeJson(components, where);
  if (JSON.stringify(components).length > A2UI_LIMITS.componentsBytes) throw new CliError(`${where}: components are over ${A2UI_LIMITS.componentsBytes} bytes.`);
  const byId = new Map();
  components.forEach((comp, i) => {
    const at = `${where}.components[${i}]`;
    if (!isPlainObject(comp)) throw new CliError(`${at}: must be an object.`);
    if (typeof comp.id !== 'string' || !ID_RE.test(comp.id)) throw new CliError(`${at}: "id" must be letters, digits, - or _ (max 64).`);
    if (byId.has(comp.id)) throw new CliError(`${at}: duplicate id "${comp.id}".`);
    const def = Object.hasOwn(catalog, comp.component) ? catalog[comp.component] : null;
    if (!def) throw new CliError(`${at}: unknown component "${comp.component}". Known: ${Object.keys(catalog).join(', ')}.`);
    checkComponent(def, comp, `${at} (${comp.id})`);
    byId.set(comp.id, comp);
  });
  const root = byId.get('root');
  if (!root) throw new CliError(`${where}: needs a component with id "root".`);
  if (root.component !== 'Card') throw new CliError(`${where}: the root must be a Card, not ${root.component}.`);
  assertTree(byId, where);
  if (dataModel !== undefined) {
    if (!isPlainObject(dataModel)) throw new CliError(`${where}: "dataModel" must be an object.`);
    assertSafeJson(dataModel, `${where}.dataModel`);
    if (JSON.stringify(dataModel).length > A2UI_LIMITS.dataBytes) throw new CliError(`${where}: dataModel is over ${A2UI_LIMITS.dataBytes} bytes.`);
  }
  return { components, ...(dataModel && Object.keys(dataModel).length ? { dataModel } : {}) };
}

/**
 * Compiles a block's `express` in place into `components` and `dataModel`, then
 * validates the result. Blocks that already hold components are left alone.
 */
export async function resolveA2uiBlock(block, where = 'a2ui') {
  if (typeof block.express !== 'string') return block;
  const compiled = await compileExpress(block.express, where);
  const surface = validateSurface(compiled, where);
  delete block.express;
  block.components = surface.components;
  if (surface.dataModel) block.dataModel = surface.dataModel;
  return block;
}
