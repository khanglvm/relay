// mcp.js — relay as an MCP App (SEP-1865, extension "io.modelcontextprotocol/ui").
//
// `rly mcp` starts a zero-dependency MCP server over stdio. Register it with a
// host that supports MCP Apps (Claude desktop/mobile, Codex, …) and relay's
// boards render INLINE in the conversation instead of opening a browser tab:
//
//   • the server declares a UI resource  ui://relay/board  (text/html;profile=mcp-app)
//   • the tools `relay_ask` / `relay_show` link to it via _meta.ui.resourceUri
//   • calling a tool returns the (normalized) board spec as structuredContent;
//     the host renders the resource in a sandboxed iframe and forwards the spec
//   • the iframe collects the user's answers and sends them back to the model
//     via `ui/update-model-context`
//
// Framing is the MCP stdio transport: newline-delimited JSON-RPC, one message
// per line, never embedded newlines. stdout carries ONLY protocol messages;
// everything else goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpec, SPEC_SCHEMA } from './spec.js';
import { CliError } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');
const MCP_UI_DIR = path.join(__dirname, 'mcp-ui');
const PKG_ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

const UI_EXT = 'io.modelcontextprotocol/ui';
const UI_MIME = 'text/html;profile=mcp-app';
const BOARD_URI = 'ui://relay/board';
const VENDOR_PREFIX = 'ui://relay/vendor/';
// Echoed back to the client when it doesn't pin a version we recognize.
const DEFAULT_PROTOCOL = '2025-06-18';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- UI asset assembly (cached for the process lifetime) ----------
const _cache = new Map();
function readAsset(dir, name) {
  const key = dir + '\0' + name;
  if (_cache.has(key)) return _cache.get(key);
  let content = '';
  try { content = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { content = ''; }
  _cache.set(key, content);
  return content;
}

// The single self-contained board page served as the ui:// resource: the shared
// stylesheet + block renderer + the MCP-app client, all inlined (no /vendor or
// /api routes exist in the sandbox; vendors load over the bridge on demand).
function buildBoardPage() {
  if (_cache.has('__page__')) return _cache.get('__page__');
  const html = readAsset(MCP_UI_DIR, 'index.html');
  const boot = { version: PKG.version, boardId: 'mcp-' + Date.now().toString(36) };
  const page = html
    .split('__TITLE__').join('Relay')
    .split('/*__CSS__*/').join(readAsset(UI_DIR, 'style.css'))
    .split('/*__BLOCKS_CSS__*/').join(readAsset(UI_DIR, 'blocks.css'))
    .split('/*__BLOCKS_JS__*/').join(readAsset(UI_DIR, 'blocks.js'))
    .split('/*__BOARD_JS__*/').join(readAsset(MCP_UI_DIR, 'board.js'))
    .split('__BOOT_JSON__').join(JSON.stringify(boot).replace(/</g, '\\u003c'));
  _cache.set('__page__', page);
  return page;
}

function vendorText(name) {
  // No traversal: only a bare filename inside VENDOR_DIR.
  if (!/^[\w.-]+$/.test(name)) return null;
  const target = path.join(VENDOR_DIR, name);
  if (target !== VENDOR_DIR && !target.startsWith(VENDOR_DIR + path.sep)) return null;
  try { return fs.readFileSync(target, 'utf8'); } catch { return null; }
}

// ---------- tool + resource descriptors ----------
// The board spec, as the tool input schema: SPEC_SCHEMA minus the result-only
// fields (annotations / blockEdits are returned, never supplied).
function inputSchema() {
  const props = { ...SPEC_SCHEMA.properties };
  delete props.annotations;
  delete props.blockEdits;
  return { type: 'object', properties: props, anyOf: SPEC_SCHEMA.anyOf };
}

// _meta linking a tool to the UI resource. We emit the field under several keys
// for cross-host compatibility: the spec's `_meta.ui`, the extension-id key, and
// OpenAI's `openai/outputTemplate` (ChatGPT / Codex Apps SDK).
function uiToolMeta() {
  const ui = { resourceUri: BOARD_URI, visibility: ['model', 'app'] };
  return { ui, [UI_EXT]: ui, 'openai/outputTemplate': BOARD_URI };
}

function tools() {
  const schema = inputSchema();
  return [
    {
      name: 'relay_ask',
      description:
        'Ask the user structured questions on an interactive board rendered inline in this app — real form controls (single/multi choice, yes/no, scale, text) plus rich blocks (markdown, code, diff, table, chart, mermaid, graphviz, image, html). Use this instead of asking questions in plain text whenever you need decisions, requirements, or feedback. The user fills it in and submits; their answers come back to you. Pass a board spec (see inputSchema).',
      inputSchema: schema,
      _meta: uiToolMeta(),
    },
    {
      name: 'relay_show',
      description:
        'Present work to the user on an inline board WITHOUT necessarily asking questions — a plan, an architecture diagram, data, a diff, a prototype — using rich blocks (markdown, mermaid, graphviz, chart, table, code, diff, image, html). The board shows a Submit/Acknowledge button. Same spec as relay_ask; typically blocks-only.',
      inputSchema: schema,
      _meta: uiToolMeta(),
    },
  ];
}

function resources() {
  return [
    {
      uri: BOARD_URI,
      name: 'Relay board',
      description: 'The interactive relay board UI (rendered inline by relay_ask / relay_show).',
      mimeType: UI_MIME,
      _meta: { ui: resourceMeta() },
    },
  ];
}

// Per-resource UI hints (CSP / framing). Hosts that ignore these still work; the
// frame allowances cover YouTube/Vimeo `video` blocks and blob: html previews.
function resourceMeta() {
  return {
    prefersBorder: false,
    csp: {
      connectDomains: [],
      resourceDomains: ['https://*', 'data:', 'blob:'],
      frameDomains: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'blob:', 'data:'],
    },
  };
}

// ---------- request routing ----------
function buildResult(method, params, clientProtocol) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          experimental: {},
          extensions: { [UI_EXT]: { mimeTypes: [UI_MIME] } },
        },
        serverInfo: { name: 'relay', version: PKG.version },
        instructions:
          'relay renders interactive boards inline. Call relay_ask to collect decisions/feedback with real form controls, or relay_show to present plans/diagrams/data — instead of asking in plain text. Read the user\'s answers from the structuredContent that returns after they submit.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: tools() };
    case 'resources/list':
      return { resources: resources() };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    case 'resources/read':
      return readResource(params);
    case 'tools/call':
      return callTool(params);
    default: {
      const err = new Error('method not found: ' + method);
      err.code = -32601;
      throw err;
    }
  }
}

function readResource(params) {
  const uri = params && params.uri;
  if (uri === BOARD_URI) {
    return { contents: [{ uri: BOARD_URI, mimeType: UI_MIME, text: buildBoardPage(), _meta: { ui: resourceMeta() } }] };
  }
  if (typeof uri === 'string' && uri.startsWith(VENDOR_PREFIX)) {
    const name = uri.slice(VENDOR_PREFIX.length);
    const text = vendorText(name);
    if (text == null) { const e = new Error('vendor not found: ' + name); e.code = -32002; throw e; }
    return { contents: [{ uri, mimeType: 'application/javascript', text }] };
  }
  const e = new Error('resource not found: ' + uri);
  e.code = -32002;
  throw e;
}

// A tool call: normalize the spec and hand it to the host as structuredContent.
// The host renders ui://relay/board and forwards this spec to the iframe, which
// collects the answers and returns them via ui/update-model-context. Spec errors
// come back as an isError tool result (not a protocol error) so the model can
// see and fix them.
function callTool(params) {
  const name = params && params.name;
  if (name !== 'relay_ask' && name !== 'relay_show') {
    return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
  }
  const args = (params && params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
  let spec;
  try {
    spec = normalizeSpec(args);
  } catch (err) {
    const msg = err instanceof CliError ? err.message : String((err && err.message) || err);
    return { content: [{ type: 'text', text: 'relay: invalid board spec — ' + msg }], isError: true };
  }
  const nQ = spec.questions.length;
  const summary = nQ
    ? `Relay board "${spec.title}" is now displayed to the user (${nQ} question${nQ === 1 ? '' : 's'}). They will fill it in and submit; their answers will be delivered back to you. Do NOT re-ask these questions in plain text — wait for the submission.`
    : `Relay board "${spec.title}" is now displayed to the user. They can review it and acknowledge; any feedback will be delivered back to you.`;
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { spec, mode: name === 'relay_show' ? 'show' : 'ask' },
    _meta: { ui: { resourceUri: BOARD_URI }, [UI_EXT]: { resourceUri: BOARD_URI } },
  };
}

// ---------- stdio loop ----------
export function runMcp() {
  // The peer closing stdout (EPIPE) is the only reason to stop writing — NOT a
  // `false` return from write(), which just signals backpressure (the 145KB
  // board page reliably triggers it). Honoring backpressure as "stop" would
  // silently drop every response after a large one.
  let stdoutOpen = true;
  process.stdout.on('error', () => { stdoutOpen = false; });
  const send = (obj) => {
    if (!stdoutOpen) return;
    try { process.stdout.write(JSON.stringify(obj) + '\n'); }
    catch { stdoutOpen = false; }
  };

  function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const messages = Array.isArray(msg) ? msg : [msg];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const isRequest = m.id !== undefined && m.id !== null && typeof m.method === 'string';
      if (typeof m.method !== 'string') continue; // a response to us — we issue none
      let result;
      try {
        result = buildResult(m.method, m.params || {});
      } catch (err) {
        if (isRequest) {
          send({ jsonrpc: '2.0', id: m.id, error: { code: err.code || -32603, message: err.message || String(err) } });
        }
        continue;
      }
      if (isRequest) send({ jsonrpc: '2.0', id: m.id, result });
    }
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed) handleLine(trimmed);
    }
  });

  // Resolve only when the input stream closes (host disconnected). Returning a
  // promise that stays pending keeps the CLI's post-run exit timer from firing.
  return new Promise((resolve) => {
    const finish = () => resolve(0);
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
}

// The setup snippet printed by `rly mcp config` / `rly mcp install --print`.
// Returns { json, toml, paths } so the CLI can present per-host instructions.
export function mcpConfig({ command = 'rly' } = {}) {
  return {
    command,
    args: ['mcp'],
    // Claude Desktop / generic MCP JSON config (claude_desktop_config.json,
    // .mcp.json, VS Code mcp.json, …).
    json: {
      mcpServers: {
        relay: { command, args: ['mcp'] },
      },
    },
    // Codex CLI (~/.codex/config.toml).
    toml: `[mcp_servers.relay]\ncommand = "${command}"\nargs = ["mcp"]\n`,
  };
}
