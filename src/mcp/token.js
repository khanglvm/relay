// The per-board token an iframe presents to the app-only tools.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../store.js';

const KEY_FILE = path.join(HOME, 'mcp-key');

const readKey = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * The server's HMAC key: a random value kept in the relay home, created on first use.
 * Two servers starting together both try to create it; the exclusive create lets one
 * win and the other read what the winner wrote, so they never hold different keys.
 */
export function loadServerKey(file = KEY_FILE) {
  const existing = readKey(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  try {
    // link() fails when the key already exists and never exposes a half-written file.
    fs.linkSync(tmp, file);
    return key;
  } catch (e) {
    if (e.code === 'EEXIST') return readKey(file) || key;
    // A filesystem without hard links: fall back to an exclusive create.
    try {
      fs.writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (again) {
      if (again.code !== 'EEXIST') throw again;
      return readKey(file) || key;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const boardToken = (key, boardId) => crypto.createHmac('sha256', key).update(String(boardId)).digest('hex');

/** Constant-time comparison, so a wrong token leaks nothing about the right one. */
export function tokenValid(key, boardId, token) {
  if (typeof token !== 'string') return false;
  const want = Buffer.from(boardToken(key, boardId));
  const got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
