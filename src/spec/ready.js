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
    const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const context = {
      console: quietConsole,
      setTimeout,
      clearTimeout,
    };
    context.globalThis = context;
    context.window = { addEventListener() {} };
    vm.createContext(context);
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

async function assertMermaidSyntax(code, where) {
  const mermaid = await mermaidValidator();
  try {
    const parsed = mermaid.parse(code);
    if (parsed && typeof parsed.then === 'function') await parsed;
  } catch (err) {
    throw new CliError(`${where}: invalid mermaid syntax — ${compactError(err)}`);
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
