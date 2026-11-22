// The setup snippets `rly mcp config` prints.
import { DEFAULT_HTTP_PORT, HTTP_PATH } from './constants.js';

/** Setup for each host: a JSON entry, a Codex TOML block, and how to run the HTTP transport. */
export function mcpConfig({ command = 'rly', httpPort = DEFAULT_HTTP_PORT } = {}) {
  const url = `http://127.0.0.1:${httpPort}${HTTP_PATH}`;
  return {
    command,
    args: ['mcp'],
    httpPort,
    httpUrl: url,
    json: { mcpServers: { relay: { command, args: ['mcp'] } } },
    toml: `[mcp_servers.relay]\ncommand = "${command}"\nargs = ["mcp"]\n`,
    http: {
      run: `${command} mcp --http --port ${httpPort}`,
      url,
      note: 'Set RLY_MCP_TOKEN for a bearer-protected endpoint, and RLY_MCP_ALLOW_ORIGIN for a browser host on another origin. Boards live in the relay home of the machine that runs the server.',
    },
  };
}
