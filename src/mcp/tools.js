// registerRelay: the relay tools and the board resource on any MCP server.
import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import fs from 'node:fs';
import path from 'node:path';
import { A2UI_MIME, BOARD_CATALOG_ID } from '../a2ui/board-constants.js';
import { wantsA2ui } from '../a2ui/negotiate.js';
import { toA2ui } from '../a2ui/to-a2ui.js';
import { renderAgentTopic, topicIndex } from '../cli/agent-topics.js';
import { lookupSchema } from '../spec/index.js';
import { sleep } from '../util.js';
import {
  boardResult, createMcpBoard, errorResult, handleSurfaceAction, isFinal, resultOf, saveDraft, specError, submitBoard,
} from './boards.js';
import { BOARD_URI, MAX_WAIT_SECONDS, TOOL, UI_MIME, VENDOR_URI_PREFIX } from './constants.js';
import { BOARD_RESOURCE_META, boardPage, DOCS_DIR, vendorChunk, vendorText, VENDOR_FILES } from './page.js';
import { actionInput, aliasInput, assetInput, boardInput, draftInput, helpInput, resultInput, submitInput, viewInput } from './schemas.js';
import { fileStore } from './store.js';
import { boardToken, loadServerKey, tokenValid } from './token.js';

const BOARD_DESCRIPTION = `Put a board in front of the person and collect their answers. It renders inline; the result is a summary with the boardId. Read the outcome with relay_result.
Spec: {title, intro?, blocks?:[...], questions?:[...]}. With no questions the board is display-only and needs no reply.
Question: {id,type,label,required?,options?:[{value,label,description?,blocks?}|"text"]}. Types: single multi yesno text textarea scale(min,max) color rank checklist allocate(total).
Blocks: markdown(md|mdFile) code(code|codeFile) diff(diffFile) image(src,alt?,pins?) compare(before,after) chart(kind,labels,series:[{label,data}]) table(columns,rows) kpi(items) mermaid(code) graphviz(dot) html palette video pdf a2ui(express). Local files take absolute paths; inline boards cannot open local links, so embed file content.
Blocks go on the board, on a question, or on an option. Use ids that stay stable.
For exact fields call relay_help {topic: questions|blocks|annotate|lifecycle|a2ui|sharing|mcp} or {schema:"chart"}.`;

const readDoc = (file) => fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
/** @returns {import('./boards.js').ToolResult} */
const text = (t) => ({ content: [{ type: 'text', text: t }] });
/** @returns {import('./boards.js').ToolResult} */
const json = (value, structured) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(structured ? { structuredContent: structured } : {}) });

/**
 * Adds the relay tools and the board resource to `server`.
 *
 * @param {any} server an McpServer
 * @param {object} [options]
 * @param {import('./store.js').RelayStore} [options.store] where boards live; defaults to the relay home on disk
 * @param {number | string | boolean} [options.retentionDays] with the default store, boards unchanged for this many days are removed when a new board is made (default 30; `0`, `false` or "off" keeps every board). `RLY_RETENTION_DAYS` sets it when the option is absent. A custom `store` does its own cleanup
 * @param {string[]} [options.fileRoots] folders a spec may read local files from (`codeFile`, images, `rowsFile`...); none by default, so a remote client cannot read the server's disk
 * @param {string | Buffer} [options.tokenKey] the secret behind board tokens; defaults to a key file in the relay home
 * @param {(name: string) => string} [options.assetUrl] URL of a vendor file, for hosts that can fetch it
 * @param {(boardId: string) => string} [options.linkUrl] a URL where a person can open the board outside the host
 * @returns the app-only tools, so a server can hide them from a client that cannot render the board
 */
export function registerRelay(server, options = {}) {
  const ctx = { server, options, store: options.store ?? fileStore({ retentionDays: options.retentionDays }), key: options.tokenKey ?? loadServerKey() };
  registerBoardTools(ctx);
  registerReadTools(ctx);
  const appTools = registerAppTools(ctx);
  registerResources(server);
  return appTools;
}

// Every app call reads a board and writes it back whole. Two clicks forwarded at once,
// or a draft racing the submit, would otherwise drop one write. The queue is per
// process, not per server, because the HTTP transport builds a server per request.
const boardQueues = new Map();
function oneAtATime(boardId, task) {
  const key = String(boardId);
  const run = (boardQueues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  boardQueues.set(key, tail);
  tail.then(() => { if (boardQueues.get(key) === tail) boardQueues.delete(key); });
  return run;
}

const appMeta = (visibility) => ({ ui: { resourceUri: BOARD_URI, visibility } });
const modelMeta = { ...appMeta(['model', 'app']), 'openai/outputTemplate': BOARD_URI };

function registerBoardTools({ server, options, store, key }) {
  const openBoard = (displayOnly) => async (args) => {
    let made;
    try {
      made = await createMcpBoard(store, args, { displayOnly, fileRoots: options.fileRoots });
    } catch (err) {
      return specError(err);
    }
    const result = boardResult(made.record, made.spec, made.mode);
    if (options.linkUrl) result.structuredContent = { .../** @type {object} */ (result.structuredContent), url: options.linkUrl(made.record.id) };
    result._meta = { ...appMeta(['model', 'app']), relay: { token: boardToken(key, made.record.id) }, 'relay/a2ui': { catalogIds: [BOARD_CATALOG_ID] } };
    return result;
  };
  registerAppTool(server, TOOL.board, { title: 'Relay board', description: BOARD_DESCRIPTION, inputSchema: boardInput, _meta: modelMeta }, openBoard(false));
  registerAppTool(server, TOOL.ask, { description: 'Deprecated alias of relay_board.', inputSchema: aliasInput, _meta: modelMeta }, openBoard(false));
  registerAppTool(server, TOOL.show, { description: 'Deprecated alias of relay_board for a display-only board.', inputSchema: aliasInput, _meta: modelMeta }, openBoard(true));
}

function registerReadTools({ server, store }) {
  const modelOnly = { ui: { visibility: ['model'] } };
  registerAppTool(server, TOOL.help, {
    description: 'Exact Relay field shapes. topic: questions, blocks, annotate, lifecycle, a2ui, sharing, mcp. schema: one block or question type.',
    inputSchema: helpInput,
    _meta: modelOnly,
  }, ({ topic, schema }) => {
    if (schema) {
      const found = lookupSchema(schema);
      return found ? json(found) : errorResult(`relay: no block or question type "${schema}". ${topicIndex()}`);
    }
    return text(topic ? renderAgentTopic(topic, readDoc) : topicIndex());
  });

  registerAppTool(server, TOOL.result, {
    description: 'The answers on a board (answers, notes, comment, annotations, blockEdits), or its draft while the person is still filling it in. Pass wait_seconds to block until they submit.',
    inputSchema: resultInput,
    _meta: modelOnly,
  }, async ({ boardId, wait_seconds = 0 }, ctx) => {
    const deadline = Date.now() + Math.min(wait_seconds, MAX_WAIT_SECONDS) * 1000;
    for (;;) {
      const record = await store.get(boardId);
      if (!record) return errorResult(`relay: no board "${boardId}"`);
      if (isFinal(record) || Date.now() >= deadline || ctx?.mcpReq?.signal?.aborted) {
        const out = resultOf(record);
        return json(out, { boardId, status: out.status });
      }
      await sleep(500);
    }
  });
}

function registerAppTools({ server, options, store, key }) {
  const appTools = [];
  const appTool = (name, config, cb) => appTools.push(registerAppTool(server, name, { ...config, _meta: { ui: { visibility: ['app'] } } }, cb));

  /** The board a valid token opens, or an error result. */
  const guard = async (args) => {
    if (!tokenValid(key, args.boardId, args.token)) return { error: errorResult('relay: board token mismatch') };
    const record = await store.get(args.boardId);
    return record ? { record } : { error: errorResult('relay: board not found') };
  };
  /** An app tool that acts on one unfinished board. */
  const onOpenBoard = (act) => (args) => oneAtATime(args.boardId, async () => {
    const { record, error } = await guard(args);
    if (error) return error;
    if (isFinal(record)) return errorResult('relay: board is finished');
    return act(record, args);
  });

  appTool(TOOL.view, { description: 'The board, for the board iframe; for a host that declared the board catalog, A2UI messages.', inputSchema: viewInput }, async (args, ctx) => {
    const { record, error } = await guard(args);
    if (error) return error;
    const caller = { capabilities: server.server.getClientCapabilities(), meta: ctx?.mcpReq?._meta };
    if (wantsA2ui(caller)) {
      const messages = toA2ui(record.spec, { surfaceId: `relay-${record.id}`, draft: record.draft });
      return { content: [{ type: 'resource', resource: { uri: `a2ui://relay/board/${record.id}`, mimeType: A2UI_MIME, text: JSON.stringify(messages) } }] };
    }
    const vendorUrls = options.assetUrl ? Object.fromEntries(VENDOR_FILES.map((f) => [f, options.assetUrl(f)])) : undefined;
    return json({ boardId: record.id }, { boardId: record.id, spec: record.spec, draft: record.draft ?? null, finished: Boolean(record.result), vendorUrls });
  });
  appTool(TOOL.draft, { description: 'Saves the answers so far.', inputSchema: draftInput }, onOpenBoard(async (record, args) => {
    await saveDraft(store, record.id, args.draft, record.spec);
    return text('saved');
  }));
  appTool(TOOL.a2uiAction, { description: 'A renderer event: a button click from an a2ui block, or relay.submit and relay.draft from an A2UI board surface.', inputSchema: actionInput }, onOpenBoard(async (record, args) => {
    const outcome = await handleSurfaceAction(store, record, args);
    return outcome.ok ? text('recorded') : errorResult(`relay: ${outcome.error}`);
  }));
  appTool(TOOL.submit, { description: 'Stores the final answers.', inputSchema: submitInput }, (args) => oneAtATime(args.boardId, async () => {
    const { record, error } = await guard(args);
    if (error) return error;
    const outcome = await submitBoard(store, record, args.payload);
    return outcome.ok ? json({ status: outcome.status }) : errorResult(`relay: ${outcome.error}`);
  }));
  appTool(TOOL.asset, { description: 'One chunk of a vendored library, for hosts that refuse resources/read.', inputSchema: assetInput }, ({ name, index }) => {
    const chunk = vendorChunk(name, index);
    return chunk ? json({ name, index, count: chunk.count }, chunk) : errorResult(`relay: no asset "${name}" chunk ${index}`);
  });
  return appTools;
}

function registerResources(server) {
  registerAppResource(server, 'Relay board', BOARD_URI, { mimeType: UI_MIME, description: 'The interactive board shown by relay_board.', _meta: { ui: BOARD_RESOURCE_META } }, () => ({
    contents: [{ uri: BOARD_URI, mimeType: UI_MIME, text: boardPage(), _meta: { ui: BOARD_RESOURCE_META } }],
  }));
  for (const file of VENDOR_FILES) {
    const uri = VENDOR_URI_PREFIX + file;
    server.registerResource(`vendor ${file}`, uri, { mimeType: 'application/javascript' }, () => ({
      contents: [{ uri, mimeType: 'application/javascript', text: vendorText(file) }],
    }));
  }
}
