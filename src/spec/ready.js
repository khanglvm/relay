// Checks that need async work (mermaid syntax, A2UI Express). They run once,
// before a board opens, and mark the spec as ready.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { resolveA2uiBlock } from '../a2ui/compile.js';
import { CliError } from '../util.js';

const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor');

let mermaidValidatorPromise = null;

function compactError(err) {
  const raw = err && (err.str || err.message) ? (err.str || err.message) : String(err || 'unknown error');
  const msg = String(raw).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? msg.slice(0, 497) + '...' : msg;
}

// A sandbox in which the browser build of mermaid can parse, but not render.
function parserContext() {
  const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const context = {
    console: quietConsole,
    setTimeout,
    clearTimeout,
    // Mermaid 11's langium parsers (pie, gitGraph, packet, architecture, radar)
    // and its link handling call these browser globals, which a vm context lacks.
    TextEncoder,
    TextDecoder,
    structuredClone,
    URL,
  };
  context.globalThis = context;
  // DOMPurify 3 (bundled in mermaid) builds a stub without addHook or sanitize
  // when window has no document, and mermaid calls both while it parses labels.
  // This document is just enough for DOMPurify to build its full API: with no
  // document.implementation it reports isSupported = false, and then sanitize
  // returns its input unchanged. That is safe only because this instance parses
  // and never renders. The document stays on window, not as a global, so
  // mermaid's own code never takes a DOM path.
  context.window = {
    addEventListener() {},
    document: { nodeType: 9, createElement: () => ({}) },
    Element: function Element() {},
  };
  return vm.createContext(context);
}

async function mermaidValidator() {
  if (mermaidValidatorPromise) return mermaidValidatorPromise;
  mermaidValidatorPromise = (async () => {
    const sourcePath = path.join(VENDOR_DIR, 'mermaid.min.js');
    let source;
    try {
      source = fs.readFileSync(sourcePath, 'utf8');
    } catch {
      throw new CliError('mermaid blocks need the vendored parser (vendor/mermaid.min.js is missing).');
    }
    const context = parserContext();
    try {
      vm.runInContext(source, context, { filename: sourcePath });
    } catch (err) {
      throw new CliError(`could not load mermaid parser: ${compactError(err)}`);
    }
    if (!context.mermaid || typeof context.mermaid.parse !== 'function') {
      throw new CliError('could not load mermaid parser: vendor/mermaid.min.js did not expose mermaid.parse.');
    }
    try {
      context.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
      });
    } catch {
      // Some Mermaid versions dislike repeated initialize calls; parse below is
      // the real readiness gate.
    }
    return context.mermaid;
  })();
  return mermaidValidatorPromise;
}

// Names of the errors JavaScript itself throws. The parser throws these when
// its sandbox lacks something (`X is not defined`, `Y is not a function`); a
// diagram with bad syntax makes it throw a plain Error carrying a parse message.
// The sandbox is another realm, so `instanceof` cannot tell them apart.
const ENVIRONMENT_ERROR_NAMES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'EvalError']);

/** True when the error comes from the checker's own environment and says nothing about the diagram. */
export function isCheckerFailure(err) {
  return Boolean(err) && ENVIRONMENT_ERROR_NAMES.has(err.name);
}

async function assertMermaidSyntax(code, where) {
  const mermaid = await mermaidValidator();
  try {
    const parsed = mermaid.parse(code);
    if (parsed && typeof parsed.then === 'function') await parsed;
  } catch (err) {
    if (isCheckerFailure(err)) {
      throw new CliError(`${where}: internal error, the mermaid checker failed and did not check this diagram (${compactError(err)}). The diagram may be fine. Report this to the relay maintainers, or show the diagram as an image or a markdown code block meanwhile.`, 1);
    }
    throw new CliError(`${where}: invalid mermaid syntax. Fix the diagram source: ${compactError(err)}`);
  }
}

function* allBlocks(spec) {
  const boardBlocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  for (let i = 0; i < boardBlocks.length; i++) {
    yield { block: boardBlocks[i], where: `board.blocks[${i}]${boardBlocks[i]?.id ? ` (${boardBlocks[i].id})` : ''}` };
  }
  const questions = Array.isArray(spec.questions) ? spec.questions : [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi] || {};
    const qBlocks = Array.isArray(q.blocks) ? q.blocks : [];
    for (let bi = 0; bi < qBlocks.length; bi++) {
      yield { block: qBlocks[bi], where: `questions[${qi}].blocks[${bi}]${qBlocks[bi]?.id ? ` (${qBlocks[bi].id})` : ''}` };
    }
    const opts = Array.isArray(q.options) ? q.options : [];
    for (let oi = 0; oi < opts.length; oi++) {
      const oBlocks = Array.isArray(opts[oi]?.blocks) ? opts[oi].blocks : [];
      for (let bi = 0; bi < oBlocks.length; bi++) {
        yield {
          block: oBlocks[bi],
          where: `questions[${qi}].options[${oi}].blocks[${bi}]${oBlocks[bi]?.id ? ` (${oBlocks[bi].id})` : ''}`,
        };
      }
    }
  }
}

export async function assertSpecReady(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  if (spec.__relayReady === true) return spec;
  for (const { block, where } of allBlocks(spec)) {
    if (block && block.type === 'mermaid') await assertMermaidSyntax(block.code || '', where);
    if (block && block.type === 'a2ui') await resolveA2uiBlock(block, `${where} (a2ui)`);
  }
  Object.defineProperty(spec, '__relayReady', { value: true, enumerable: false, configurable: true });
  return spec;
}
