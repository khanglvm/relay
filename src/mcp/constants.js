// Names and limits shared by the MCP server modules and the board page.
import { A2UI_ACTION_TOOL } from '../a2ui/board-constants.js';

export const UI_EXT = 'io.modelcontextprotocol/ui';
export const UI_MIME = 'text/html;profile=mcp-app';
export const BOARD_URI = 'ui://relay/board';
export const VENDOR_URI_PREFIX = 'ui://relay/vendor/';
export const HTTP_PATH = '/mcp';
export const DEFAULT_HTTP_PORT = 4319;

// A relay_asset chunk is at most this many raw bytes, so one tool result stays
// well under the size a host will pass to an iframe.
export const VENDOR_CHUNK_BYTES = 768 * 1024;

// The longest relay_result may block. A host's own tool timeout is usually
// shorter, so the person polls again instead of the call hanging.
export const MAX_WAIT_SECONDS = 600;

// relay_board results stay under this size so a model reading it pays for a summary, not the spec.
export const RESULT_BUDGET_BYTES = 2048;

export const TOOL = {
  board: 'relay_board',
  help: 'relay_help',
  result: 'relay_result',
  view: 'relay_view',
  draft: 'relay_draft',
  submit: 'relay_submit',
  asset: 'relay_asset',
  a2uiAction: A2UI_ACTION_TOOL,
  ask: 'relay_ask',
  show: 'relay_show',
};
