// Where the server finds the UI sources and the vendored browser libraries.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');
