// The public MCP entry (@khanglvm/relay/mcp). runMcp and runMcpHttp load the SDK when a server starts.
export { mcpConfig } from './config.js';
export { runMcp, runMcpHttp } from './serve.js';
export { fileStore } from './store.js';
export { registerRelay } from './tools.js';
