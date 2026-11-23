// The board store behind the MCP tools. registerRelay takes any object with this shape.
import { createBoard, loadBoard, saveBoard, saveResultFile } from '../store.js';

/**
 * @typedef {object} BoardRecord
 * @property {string} id
 * @property {any} spec the normalized board spec
 * @property {any} [draft] the person's answers so far
 * @property {any} [result] set once the person submits
 * @property {any[]} [events] a2ui button clicks, newest last
 */

/**
 * @typedef {object} RelayStore
 * @property {(spec: any, options?: { fileRoots?: string[] }) => BoardRecord | Promise<BoardRecord>} create
 * @property {(id: string) => BoardRecord | null | Promise<BoardRecord | null>} get
 * @property {(id: string, patch: Partial<BoardRecord>) => BoardRecord | null | Promise<BoardRecord | null>} update
 */

/**
 * The default store: one JSON file per board under the relay home, shared with the CLI.
 * @param {{ retentionDays?: number | string | boolean }} [options] how long old boards stay; see `resolveRetentionDays`
 */
export function fileStore({ retentionDays } = {}) {
  const get = (id) => (/^b-[a-z0-9]+$/i.test(String(id)) ? loadBoard(id) : null);
  return {
    create: (spec, options) => createBoard(spec, { ...options, retentionDays }),
    get,
    update(id, patch) {
      const record = get(id);
      if (!record) return null;
      Object.assign(record, patch);
      saveBoard(record);
      if (patch.result) saveResultFile(id, patch.result);
      return record;
    },
  };
}
