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
import { viewSpec } from './media.js';
import { actionInput, aliasInput, assetInput, boardInput, draftInput, helpInput, resultInput, submitInput, viewInput } from './schemas.js';
import { fileStore } from './store.js';
import { boardToken, loadServerKey, tokenValid } from './token.js';

const BOARD_DESCRIPTION = `Show a board inline and collect feedback. Pass {title, blocks?, questions?} or {specFile} for a generated board. Inline blocks and questions append to specFile. Boards without questions are display-only by default.
Questions use {id, type, label, required?, options?}. Types: single multi yesno text textarea scale color rank checklist allocate pick.
Put blocks at the board root, on a question, or in options[].blocks. Use {type:"html", htmlFile, isolated:true} for a live option preview.
Follow the returned next call for feedback. For exact fields call relay_help {schema:"pick"} or {topic:"blocks"}.`;

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
 * @param {(boardId: string, blockId: string) => string} [options.mediaUrl] a URL the host serves a local video or pdf block from, with `serveBoardMedia`; without it those blocks show no media
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

// Boards whose final answers a waiting relay_result call has handed to an agent,
// with the time. Module level because a stateless HTTP host builds a fresh server
// per request. relay_submit reads it to tell the board whether the agent already
// has the answers, so the board can skip the chat message that wakes the agent.
// Hosts such as T3 Code confirm every such message with the person. A wrong
// "delivered" strands the answers, so only a waiter whose request is still open
// counts, and only a pickup made after this submit began.
const pickedUp = new Map();
const PICKUP_GRACE_MS = 2500;
function notePickup(boardId) {
  const now = Date.now();
  for (const [id, at] of pickedUp) if (now - at > 60_000) pickedUp.delete(id);
  pickedUp.set(String(boardId), now);
}
/** Waits briefly for an agent that is blocked in relay_result to collect a board submitted at `since`. */
async function waitForPickup(boardId, since) {
  const picked = () => (pickedUp.get(String(boardId)) ?? -1) >= since;
  const until = Date.now() + PICKUP_GRACE_MS;
  while (Date.now() < until) {
    if (picked()) return true;
    await sleep(100);
  }
  return picked();
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
    description: 'Read answers, notes, comments, and edits as structured data. Use wait_seconds: 50 to wait for Submit. When status is open, any draft is still in progress.',
    inputSchema: resultInput,
    _meta: modelOnly,
  }, async ({ boardId, wait_seconds = 0 }, ctx) => {
    const deadline = Date.now() + Math.min(wait_seconds, MAX_WAIT_SECONDS) * 1000;
    for (;;) {
      const record = await store.get(boardId);
      if (!record) return errorResult(`relay: no board "${boardId}"`);
      const aborted = Boolean(ctx?.mcpReq?.signal?.aborted);
      if (isFinal(record) || Date.now() >= deadline || aborted) {
        const out = resultOf(record);
        // A disconnected client never gets this result (the SDK drops it), and a
        // plain status read is not an agent waiting for the answers.
        if (isFinal(record) && wait_seconds > 0 && !aborted) notePickup(boardId);
        return json(out, out);
      }
      await sleep(500);
    }
  });
}

function registerAppTools({ server, options, store, key }) {
  const appTools = [];
  // App tools run only from the board iframe, on the board its token opens, and
  // only because the person looking at it typed, loaded or pressed Submit there.
  // Hosts such as T3 Code ask before every app call not marked read-only, which
  // turned each autosave into an approval prompt for the person's own typing.
  // The hint says no approval is needed: nothing reaches past this board.
  const APP_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const appTool = (name, config, cb) => appTools.push(registerAppTool(server, name, { ...config, annotations: APP_ANNOTATIONS, _meta: { ui: { visibility: ['app'] } } }, cb));

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
    return json({ boardId: record.id }, { boardId: record.id, spec: viewSpec(record.spec, record.id, options.mediaUrl), draft: record.draft ?? null, finished: Boolean(record.result), vendorUrls });
  });
  appTool(TOOL.draft, { description: 'Saves the answers so far.', inputSchema: draftInput }, onOpenBoard(async (record, args) => {
    await saveDraft(store, record.id, args.draft, record.spec);
    return text('saved');
  }));
  appTool(TOOL.a2uiAction, { description: 'A renderer event: a button click from an a2ui block, or relay.submit and relay.draft from an A2UI board surface.', inputSchema: actionInput }, onOpenBoard(async (record, args) => {
    const outcome = await handleSurfaceAction(store, record, args);
    return outcome.ok ? text('recorded') : errorResult(`relay: ${outcome.error}`);
  }));
  appTool(TOOL.submit, { description: 'Stores the final answers and says whether a waiting agent already collected them.', inputSchema: submitInput }, async (args) => {
    let since = 0;
    const outcome = await oneAtATime(args.boardId, async () => {
      const { record, error } = await guard(args);
      if (error) return { error };
      since = Date.now();
      return submitBoard(store, record, args.payload);
    });
    if (outcome.error && typeof outcome.error === 'object') return outcome.error;
    if (!outcome.ok) return errorResult(`relay: ${outcome.error}`);
    // Outside the board queue, so a relay_result for this board is not held up.
    const delivered = await waitForPickup(args.boardId, since);
    return json({ status: outcome.status, delivered }, { status: outcome.status, delivered });
  });
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
