// Local video and PDF blocks in MCP boards. The stored spec keeps each file's path on the server; the
// board iframe gets a URL the host serves instead, and the host streams the bytes with `serveBoardMedia`.
// Without a host URL the iframe has no way to reach a local file, so the block would render empty.
import { findBlock } from '../server/sanitize.js';
import { recordFileAccess, streamFile } from '../server/files.js';
import { sendJson } from '../server/http.js';
import { openReadable } from '../file-access.js';
import { fileStore } from './store.js';

/** Block types whose local `file` is streamed rather than embedded in the spec. */
const STREAMED = new Set(['video', 'pdf']);
const DEFAULT_MIME = { video: 'application/octet-stream', pdf: 'application/pdf' };

/** @typedef {(boardId: string, blockId: string) => string} MediaUrl */

/** A local media block as the iframe sees it: a host URL in `src`, never the server path. */
function viewBlock(block, boardId, mediaUrl) {
  if (!block || !STREAMED.has(block.type) || typeof block.file !== 'string') return block;
  const { file: _path, ...rest } = block;
  return mediaUrl ? { ...rest, src: mediaUrl(boardId, block.id) } : rest;
}

/**
 * The spec relay_view hands the board iframe: every local video and pdf block, on the board, on a
 * question or on an option, points at `mediaUrl` and drops its server path.
 * @param {Record<string, any>} spec the stored, normalized spec
 * @param {string} boardId
 * @param {MediaUrl} [mediaUrl] without one the block keeps no source, since the iframe cannot read the disk
 */
export function viewSpec(spec, boardId, mediaUrl) {
  const blocks = (list) => (Array.isArray(list) ? list.map((b) => viewBlock(b, boardId, mediaUrl)) : list);
  const option = (o) => (o && Array.isArray(o.blocks) ? { ...o, blocks: blocks(o.blocks) } : o);
  return {
    ...spec,
    blocks: blocks(spec.blocks),
    questions: (spec.questions ?? []).map((q) => ({ ...q, blocks: blocks(q.blocks), ...(Array.isArray(q.options) ? { options: q.options.map(option) } : {}) })),
  };
}

/** The local media block `blockId` of a stored board, or undefined. */
function mediaBlock(record, blockId) {
  for (const type of STREAMED) {
    const block = findBlock(record.spec, blockId, type);
    if (block && typeof block.file === 'string') return block;
  }
  return undefined;
}

/**
 * Answers a GET or HEAD for one local video or pdf block, Range-streamed so a <video> can seek.
 * The file comes only from the stored board and is read under the roots the board was made with;
 * the caller checks that the request may open this board. Every refusal is the same 404.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ boardId: string, blockId: string, store?: import('./store.js').RelayStore }} target
 */
export async function serveBoardMedia(req, res, { boardId, blockId, store = fileStore() }) {
  const record = await store.get(boardId);
  const block = record ? mediaBlock(record, blockId) : undefined;
  const opened = block ? openReadable(recordFileAccess(record), block.file) : { ok: false };
  if (!block || !opened.ok || opened.fd == null) return sendJson(res, 404, { error: 'no such media' });
  res.setHeader('x-content-type-options', 'nosniff');
  streamFile(req, res, opened, block.mime || DEFAULT_MIME[block.type]);
}
