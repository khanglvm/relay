// The per-board token an iframe presents to the app-only tools.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../store.js';

const KEY_FILE = path.join(HOME, 'mcp-key');

/** The server's HMAC key: a random value kept in the relay home, created on first use. */
export function loadServerKey(file = KEY_FILE) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first run: create it below
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

export const boardToken = (key, boardId) => crypto.createHmac('sha256', key).update(String(boardId)).digest('hex');

/** Constant-time comparison, so a wrong token leaks nothing about the right one. */
export function tokenValid(key, boardId, token) {
  if (typeof token !== 'string') return false;
  const want = Buffer.from(boardToken(key, boardId));
  const got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
