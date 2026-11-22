#!/usr/bin/env node
// Captures what must not change while files move: normalizeSpec output for every
// example spec, and the two assembled board pages (the web board and the MCP
// App page) as the real CLI and `rly mcp` serve them. `--write` stores the
// result in test/golden/; without it the JSON goes to stdout. test/e2e/golden.test.mjs
// compares a fresh capture with the stored one.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'rly.js');
export const GOLDEN_DIR = path.join(ROOT, 'test', 'golden');
const PAGE_SPEC = path.join(ROOT, 'skills', 'relay', 'examples', 'feature-feedback.json');

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function exampleSpecFiles() {
  const files = [path.join(ROOT, 'spec.json')];
  for (const dir of ['examples', path.join('skills', 'relay', 'examples')]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) if (name.endsWith('.json')) files.push(path.join(ROOT, dir, name));
  }
  return files;
}

/** normalizeSpec output for each example, keyed by repo-relative path. */
export async function captureSpecs() {
  const { normalizeSpec } = await import('../src/index.js');
  const out = {};
  for (const file of exampleSpecFiles()) {
    out[rel(file)] = normalizeSpec(JSON.parse(fs.readFileSync(file, 'utf8')), { cwd: path.dirname(file) });
  }
  return out;
}

/** The scripts and styles of a page, so a change shows which one moved. */
function pageSummary(html) {
  const take = (re) => [...html.matchAll(re)].map((m) => ({ bytes: Buffer.byteLength(m[1]), sha256: sha(m[1]), head: m[1].trim().slice(0, 60) }));
  return {
    bytes: Buffer.byteLength(html),
    sha256: sha(html),
    scripts: take(/<script[^>]*>([\s\S]*?)<\/script>/g),
    styles: take(/<style[^>]*>([\s\S]*?)<\/style>/g),
  };
}

// Replaces what differs per run (board id, revision counters) so two runs agree.
function stableBoot(html) {
  const boot = /(<script id="boot" type="application\/json">)([\s\S]*?)(<\/script>)/;
  return html.replace(boot, (_, open, json, close) => {
    const data = JSON.parse(json);
    for (const key of ['boardId', 'rev', 'draftRev']) if (key in data) data[key] = '(varies)';
    return `${open}${JSON.stringify(data)}${close}`;
  });
}

async function webPage(home) {
  const env = { ...process.env, HOME: home, RLY_HOME: home };
  const run = spawnSync(process.execPath, [BIN, 'ask', '--file', PAGE_SPEC, '--detach'], { env, encoding: 'utf8' });
  const info = JSON.parse(run.stdout);
  try {
    const res = await fetch(info.url);
    return stableBoot(await res.text());
  } finally {
    spawnSync(process.execPath, [BIN, 'stop', info.boardId], { env });
  }
}

function mcpPage(home) {
  const env = { ...process.env, HOME: home, RLY_HOME: home };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { env });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        child.kill();
        resolve(message.result.contents[0].text.replace(/"boardId":"mcp-[a-z0-9]+"/, '"boardId":"mcp-(varies)"'));
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'golden', version: '0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ui://relay/board' } })}\n`);
  });
}

/** Both assembled pages, as full text plus per-script and per-style hashes. */
export async function capturePages() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-golden-'));
  try {
    const web = await webPage(home);
    const mcp = await mcpPage(home);
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    return { web: pageSummary(web), mcp: pageSummary(mcp.replaceAll(version, '(version)')) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const specs = await captureSpecs();
  const pages = await capturePages();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(path.join(GOLDEN_DIR, 'specs.json'), `${JSON.stringify(specs, null, 2)}\n`);
    fs.writeFileSync(path.join(GOLDEN_DIR, 'pages.json'), `${JSON.stringify(pages, null, 2)}\n`);
    console.log(`wrote ${GOLDEN_DIR}`);
  } else {
    console.log(JSON.stringify({ specs, pages }, null, 2));
  }
}
