// Builds an McpServer with the relay tools registered.
import { McpServer } from '@modelcontextprotocol/server';
import { capabilitiesDeclareBoardCatalog } from '../a2ui/negotiate.js';
import { UI_EXT, UI_MIME } from './constants.js';
import { PKG } from './page.js';
import { registerRelay } from './tools.js';

const INSTRUCTIONS = 'Relay shows boards inline. Call relay_board with a spec; the person answers in the board, then read it with relay_result. relay_help gives exact field shapes.';

const clientRendersBoards = (capabilities) => Boolean(capabilities?.extensions?.[UI_EXT]) || capabilitiesDeclareBoardCatalog(capabilities);

/** @param {Parameters<typeof registerRelay>[1]} [options] */
export function createRelayServer(options = {}) {
  const server = new McpServer(
    { name: 'relay', version: PKG.version },
    { instructions: INSTRUCTIONS, capabilities: { extensions: { [UI_EXT]: { mimeTypes: [UI_MIME] } } } },
  );
  const appTools = registerRelay(server, options);
  // MCP Apps (spec 2026-01-26, "Resource Discovery > Visibility") makes the host drop
  // app-only tools from the model's tool list (MUST NOT include them), and only
  // asks servers to check client capabilities (SHOULD). A server that learns the
  // client at initialize (stdio) hides the tools here; a stateless HTTP request
  // carries no initialize, so those tools stay listed and the host filters them.
  server.server.oninitialized = () => {
    if (!clientRendersBoards(server.server.getClientCapabilities())) for (const tool of appTools) tool.disable();
  };
  return server;
}
