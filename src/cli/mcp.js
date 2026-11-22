// rly mcp: run the MCP server, or print and write its client config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envFileRoots, expandHome } from '../file-access.js';
import { mcpConfig } from '../mcp/config.js';
import { CliError } from '../util.js';
import { parseArgs } from './args.js';
import { printJson } from './io.js';

// `rly mcp` — run relay as an MCP App server, or print/write the host config.
//   rly mcp                      serve over stdio (what a local desktop host launches)
//   rly mcp --http [--port N]    serve over Streamable HTTP (web/mobile/remote hosts)
//   rly mcp config [--print]     show setup for Claude / Codex / generic hosts
//   rly mcp install --target claude|codex   write it into that host's config
export async function cmdMcp(rest) {
  const sub = rest[0];
  if (sub === 'config' || sub === 'setup' || sub === 'install' || sub === 'add') {
    return cmdMcpConfig(parseArgs(rest.slice(1)), sub);
  }
  const args = parseArgs(rest);
  if (args.http) {
    // Port precedence: --port flag, then PaaS-injected $PORT / $RLY_MCP_PORT,
    // then the default. PaaS hosts (Render, Railway, Fly, mcpdeploy, …) set $PORT.
    const envPort = process.env.PORT || process.env.RLY_MCP_PORT;
    const { runMcpHttp } = await import('../mcp/serve.js');
    return runMcpHttp({
      fileRoots: mcpFileRoots(args, []),
      port: args.port ? Number(args.port) : (envPort ? Number(envPort) : undefined),
      host: typeof args.host === 'string' ? args.host : (process.env.RLY_MCP_HOST || '127.0.0.1'),
      token: resolveToken(args),
      allowOrigin: typeof args.allowOrigin === 'string' ? args.allowOrigin : (process.env.RLY_MCP_ALLOW_ORIGIN || ''),
    });
  }
  // Default: be the stdio server. main() never resolves this, so the CLI's
  // post-run exit timer never arms — the server lives until stdin closes.
  const { runMcp } = await import('../mcp/serve.js');
  return runMcp({ fileRoots: mcpFileRoots(args, [process.cwd()]) });
}

/**
 * Where a spec may read local files. A local stdio host gets the working
 * directory; an HTTP server gets nothing unless the operator passes `--root` or
 * `$RLY_FILE_ROOTS`, because its clients are remote.
 */
function mcpFileRoots(args, defaults) {
  return [...defaults, ...args.root, ...envFileRoots()].map((p) => path.resolve(expandHome(p)));
}

/**
 * The bearer token for --http. `--token` shows up in `ps`, so prefer `--token-file PATH`
 * or $RLY_MCP_TOKEN; the flag keeps working. A file that cannot be read is an error,
 * never an open endpoint.
 */
function resolveToken(args) {
  if (typeof args.tokenFile === 'string') {
    try {
      const token = fs.readFileSync(args.tokenFile, 'utf8').trim();
      if (token) return token;
    } catch (e) {
      throw new CliError(`cannot read --token-file ${args.tokenFile}: ${e.message}`);
    }
    throw new CliError(`--token-file ${args.tokenFile} is empty`);
  }
  return typeof args.token === 'string' ? args.token : (process.env.RLY_MCP_TOKEN || '');
}

// Resolve Claude Desktop's config path for this platform.
function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function cmdMcpConfig(args, sub) {
  const cfg = mcpConfig({ command: 'rly' });
  const target = String(args.target || '').toLowerCase();
  const wantInstall = (sub === 'install' || sub === 'add') && args.print !== true;

  // --print, or `config`/`setup` with no writable target: show every option.
  if (!wantInstall || !target) {
    const claudePath = claudeDesktopConfigPath();
    const codexPath = path.join(os.homedir(), '.codex', 'config.toml');
    printJson({
      note: 'Register relay as an MCP App server, then call relay_board from inside the host.',
      claudeCode: 'claude mcp add relay -- rly mcp',
      claudeDesktop: { file: claudePath, add: cfg.json },
      codex: { file: codexPath, add: cfg.toml },
      generic: { add: cfg.json },
      webMobile: cfg.http,
      install: 'rly mcp install --target claude   |   rly mcp install --target codex',
    });
    return 0;
  }

  if (target === 'claude' || target === 'claude-desktop') {
    const file = claudeDesktopConfigPath();
    /** @type {Record<string, any>} */
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = {}; }
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    existing.mcpServers = existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {};
    existing.mcpServers.relay = { command: cfg.command, args: cfg.args };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
    printJson({ installed: 'claude-desktop', file, server: 'relay', note: 'restart Claude Desktop to load it' });
    return 0;
  }
  if (target === 'codex') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { body = ''; }
    if (/\[mcp_servers\.relay\]/.test(body)) {
      printJson({ installed: 'codex', file, server: 'relay', note: 'already present — left as-is' });
      return 0;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sep = body && !body.endsWith('\n') ? '\n\n' : body ? '\n' : '';
    fs.writeFileSync(file, body + sep + cfg.toml);
    printJson({ installed: 'codex', file, server: 'relay', note: 'restart Codex to load it' });
    return 0;
  }
  throw new CliError(`unknown --target "${target}". Use claude or codex (or \`rly mcp config\` to print all).`, 4);
}
