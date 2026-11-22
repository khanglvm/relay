// The board page served as the ui:// resource, and the vendor libraries it loads on demand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillPage, SRC_DIR } from '../ui/manifest.js';
import { VENDOR_CHUNK_BYTES } from './constants.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');

/** The vendored libraries a board may load, by file name. Nothing else under vendor/ is served. */
export const VENDOR_FILES = ['chart.umd.js', 'mermaid.min.js', 'viz-standalone.js'];

export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
export const DOCS_DIR = path.join(PKG_ROOT, 'docs');

const cache = new Map();
const readSrc = (file) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(SRC_DIR, file), 'utf8'));
  return cache.get(file);
};

/** The single self-contained page: styles, block renderer and the MCP client, inlined. Built once per process. */
export function boardPage() {
  if (!cache.has('page')) {
    const boot = JSON.stringify({ version: PKG.version }).replace(/</g, '\\u003c');
    cache.set('page', fillPage(readSrc('mcp-ui/index.html'), { title: 'Relay', bootJson: boot, entry: 'board' }, readSrc));
  }
  return cache.get('page');
}

/** The text of one vendor file, or null when the name is not on the allowlist. */
export function vendorText(name) {
  if (!VENDOR_FILES.includes(name)) return null;
  return fs.readFileSync(path.join(VENDOR_DIR, name), 'utf8');
}

/**
 * One base64 chunk of a vendor file, for hosts that refuse resources/read.
 * @returns {{ name: string, index: number, count: number, data: string } | null}
 */
export function vendorChunk(name, index) {
  if (!VENDOR_FILES.includes(name)) return null;
  const bytes = fs.readFileSync(path.join(VENDOR_DIR, name));
  const count = Math.ceil(bytes.length / VENDOR_CHUNK_BYTES);
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  const slice = bytes.subarray(index * VENDOR_CHUNK_BYTES, (index + 1) * VENDOR_CHUNK_BYTES);
  return { name, index, count, data: slice.toString('base64') };
}

/** The resource metadata hosts read to build the iframe's CSP. */
export const BOARD_RESOURCE_META = {
  prefersBorder: false,
  csp: {
    connectDomains: [],
    resourceDomains: ['https://*', 'data:', 'blob:'],
    frameDomains: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'blob:', 'data:'],
  },
};
