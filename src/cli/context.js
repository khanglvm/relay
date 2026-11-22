// Package facts the commands share: version, bin path and default timeouts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.join(__dirname, '..', '..');
export const BIN = path.join(PKG_ROOT, 'bin', 'rly.js');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
export const VERSION = PKG_JSON.version;
export const PKG_NAME = PKG_JSON.name; // e.g. "@khanglvm/relay" — the global package to upgrade
export const DEFAULT_BOARD_TIMEOUT_SEC = 86400;
export const DEFAULT_WAIT_TIMEOUT_SEC = 86400;
