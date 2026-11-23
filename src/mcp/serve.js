// Runs the relay MCP server over stdio or Streamable HTTP. The SDK is imported here, on demand, so the plain CLI stays light.
import crypto from 'node:crypto';
import http from 'node:http';
import { DEFAULT_HTTP_PORT, HTTP_PATH } from './constants.js';
import { loadServerKey } from './token.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Serves MCP over this process's stdin and stdout until the host closes stdin.
 * @param {{ fileRoots?: string[], retentionDays?: string | number }} [options]
 */
export async function runMcp({ fileRoots = [], retentionDays } = {}) {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const { createRelayServer } = await import('./server.js');
  const tokenKey = loadServerKey();
  const handle = serveStdio(() => createRelayServer({ tokenKey, fileRoots, retentionDays }), { onerror: (e) => process.stderr.write(`relay mcp: ${e.message}\n`) });
  // Resolves only once the host disconnects, so the CLI's exit timer never fires.
  return new Promise((resolve) => {
    const finish = () => handle.close().finally(() => resolve(0));
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
}

const corsHeaders = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'Mcp-Session-Id',
  'access-control-max-age': '86400',
  vary: 'Origin',
});

/** A browser Origin is trusted when it is local or the one the operator allowed. A client with no Origin is not a browser. */
export function originAllowed(origin, allowOrigin) {
  if (!origin) return true;
  if (allowOrigin === '*' || (allowOrigin && origin === allowOrigin)) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Constant-time string comparison for the bearer token. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const healthPage = (endpoint) =>
  '<!doctype html><meta charset="utf-8"><title>relay MCP</title>' +
  '<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:14vh auto;padding:0 20px;color:#1c1b19;background:#fcfbf9}code{background:#f1efe8;padding:2px 6px;border-radius:5px;font-size:13px}</style>' +
  '<h1>relay MCP server</h1><p>Point an MCP client at <code>' + escapeHtml(endpoint) + '</code> and call <code>relay_board</code>.</p>';

/** The node request listener: CORS, origin and bearer checks, then the MCP handler. */
function requestListener({ serve, token, allowOrigin, endpoint }) {
  return (req, res) => {
    const origin = req.headers.origin || '';
    const url = (req.url || '/').split('?')[0];
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') {
      if (!originAllowed(origin, allowOrigin)) { res.writeHead(403); return res.end(); }
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(healthPage(endpoint));
    }
    if (url !== HTTP_PATH) { res.writeHead(404, cors); return res.end('not found'); }
    if (!originAllowed(origin, allowOrigin)) { res.writeHead(403, cors); return res.end('origin not allowed'); }
    if (token && !bearerOk(req.headers.authorization, token)) {
      res.writeHead(401, { ...cors, 'www-authenticate': 'Bearer' });
      return res.end('unauthorized');
    }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    serve(req, res).catch((e) => {
      process.stderr.write(`relay mcp: ${e.message}\n`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}

const bearerOk = (header = '', token) => /^bearer /i.test(header) && safeEqual(header.slice(7), token);

/**
 * Serves MCP over Streamable HTTP. Localhost by default; a bearer token and an
 * allowed Origin are the controls for anything wider.
 * @param {{ port?: number, host?: string, token?: string, allowOrigin?: string, fileRoots?: string[], retentionDays?: string | number }} [options]
 */
export async function runMcpHttp({ port = DEFAULT_HTTP_PORT, host = '127.0.0.1', token = '', allowOrigin = '', fileRoots = [], retentionDays } = {}) {
  const { createMcpHandler } = await import('@modelcontextprotocol/server');
  const { toNodeHandler } = await import('@modelcontextprotocol/node');
  const { createRelayServer } = await import('./server.js');
  const tokenKey = loadServerKey();
  const handler = createMcpHandler(() => createRelayServer({ tokenKey, fileRoots, retentionDays }), { onerror: (e) => process.stderr.write(`relay mcp: ${e.message}\n`) });
  const serve = toNodeHandler(handler, { onerror: (e) => process.stderr.write(`relay mcp: ${e.message}\n`) });

  const server = http.createServer(requestListener({ serve, token, allowOrigin, endpoint: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${HTTP_PATH}` }));

  return new Promise((resolve) => {
    server.on('error', (e) => { process.stderr.write(`relay mcp http error: ${e.message}\n`); resolve(1); });
    server.listen(port, host, () => {
      const shown = host === '0.0.0.0' ? 'localhost' : host;
      process.stderr.write(`relay MCP (Streamable HTTP) listening on http://${shown}:${port}${HTTP_PATH}\n`);
      if (!token && host !== '127.0.0.1' && host !== 'localhost') {
        process.stderr.write('  warning: bound to a non-local interface with no --token. Anyone who can reach this port can drive relay.\n');
      }
    });
    const stop = () => { server.close(); handler.close().finally(() => resolve(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
