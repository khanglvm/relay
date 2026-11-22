// Builds an McpServer with the relay tools registered.
import { McpServer } from '@modelcontextprotocol/server';
import { UI_EXT, UI_MIME } from './constants.js';
import { PKG } from './page.js';
import { registerRelay } from './tools.js';

const INSTRUCTIONS = 'Relay shows boards inline. Call relay_board with a spec; the person answers in the board, then read it with relay_result. relay_help gives exact field shapes.';

const clientRendersBoards = (capabilities) => Boolean(capabilities?.extensions?.[UI_EXT]);

/** @param {Parameters<typeof registerRelay>[1]} [options] */
export function createRelayServer(options = {}) {
  const server = new McpServer(
    { name: 'relay', version: PKG.version },
    { instructions: INSTRUCTIONS, capabilities: { extensions: { [UI_EXT]: { mimeTypes: [UI_MIME] } } } },
  );
  const appTools = registerRelay(server, options);
  // The iframe tools only matter to a host that renders the board; others never see them.
  server.server.oninitialized = () => {
    if (!clientRendersBoards(server.server.getClientCapabilities())) for (const tool of appTools) tool.disable();
  };
  return server;
}
