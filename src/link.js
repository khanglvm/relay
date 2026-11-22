// Where a board can be opened from other devices. By default a board lives on a
// loopback port. A link setting turns that into a URL a phone or another Mac can
// reach: through `devlink` (private HTTPS over Tailscale) when it is installed,
// or through a URL template for any reverse proxy or tunnel the user runs.
// Nothing here is required; with no setting Relay behaves as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CliError } from './util.js';

const DEVLINK_TIMEOUT_MS = 30_000;
export const LINK_MODES = ['off', 'auto', 'devlink'];

const LOOPBACK_HOST = /^(localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?::1?\]?)$/i;

export const isLoopbackHost = (host) => LOOPBACK_HOST.test(String(host || ''));

/** 'devlink' | 'auto' | 'off' | an http(s) URL template -> a normalized setting. */
export function parseLinkValue(raw, where = 'link') {
  const value = String(raw ?? '').trim();
  const lower = value.toLowerCase();
  if (lower === 'off' || lower === 'local') return { mode: 'off' };
  if (lower === 'auto' || lower === 'devlink') return { mode: lower };
  if (/^http:\/\//i.test(value)) throw new CliError(`${where}: use https://, because the board's share token travels in the URL.`);
  if (/^https:\/\//i.test(value)) {
    let host;
    try { host = new URL(value.replace('{port}', '1')).hostname; } catch { throw new CliError(`${where}: "${value}" is not a valid URL.`); }
    if (isLoopbackHost(host)) throw new CliError(`${where}: ${host} only works on this machine. Use a host other devices can reach.`);
    return { mode: 'url', template: value.replace(/\/+$/, '') };
  }
  throw new CliError(`${where}: use off, auto, devlink, or an https:// URL (with {port} for the board port).`);
}

/**
 * Picks the link setting. Highest first: --no-devlink, --devlink, --public-url,
 * RLY_PUBLIC_URL, RLY_LINK, the saved config, then off.
 */
export function linkSetting({ args = {}, env = process.env, config = {} } = {}) {
  if (args.noDevlink === true) return { mode: 'off' };
  if (args.devlink === true) return { mode: 'devlink' };
  if (typeof args.publicUrl === 'string') return parseLinkValue(args.publicUrl, '--public-url');
  if (env.RLY_PUBLIC_URL) return parseLinkValue(env.RLY_PUBLIC_URL, 'RLY_PUBLIC_URL');
  if (env.RLY_LINK) return parseLinkValue(env.RLY_LINK, 'RLY_LINK');
  if (config.link) return parseLinkValue(config.link, 'config link');
  return { mode: 'off' };
}

/** The setting in the one-string form `__serve` takes on its command line. */
export const serializeLink = (s) => (s.mode === 'url' ? s.template : s.mode);

/** devlink's own binary: RLY_DEVLINK_BIN, then PATH, then its usual install folder. */
export function findDevlink({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.RLY_DEVLINK_BIN) return env.RLY_DEVLINK_BIN;
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  return dirs.map((d) => path.join(d, 'devlink')).find((f) => exists(f)) || null;
}

/** The verified private https URL out of `devlink --json internal PORT` output. */
export function pickDevlinkUrl(stdout) {
  let records;
  try { records = JSON.parse(stdout).records; } catch { throw new CliError('devlink printed something that is not JSON.', 1); }
  const url = Array.isArray(records) ? records.map((r) => r && r.url).find((u) => typeof u === 'string') : null;
  if (!url) throw new CliError('devlink returned no URL for this board.', 1);
  let parsed;
  try { parsed = new URL(url); } catch { throw new CliError(`devlink returned "${url}", which is not a URL.`, 1); }
  if (parsed.protocol !== 'https:' || isLoopbackHost(parsed.hostname)) throw new CliError(`devlink returned ${url}, which is not a private https URL.`, 1);
  return parsed.origin;
}

const runFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: DEVLINK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr }));
    else resolve({ stdout });
  });
});

/**
 * Turns a setting and the board's listening port into a shareable origin, or
 * null when the board stays local (mode off, or auto without devlink). Returns
 * `{kind, origin, release}`; call `release()` when the board closes.
 * `deps` lets tests replace the filesystem and the devlink process.
 */
export async function resolveLink(setting, port, { env = process.env, exec = runFile, exists = fs.existsSync } = {}) {
  if (setting.mode === 'off') return null;
  if (setting.mode === 'url') {
    const origin = new URL(setting.template.replace('{port}', String(port))).origin;
    return { kind: 'url', origin, release: () => {} };
  }
  const bin = findDevlink({ env, exists });
  if (!bin) {
    if (setting.mode === 'auto') return null;
    throw new CliError('--devlink needs the devlink command, and it is not on PATH. Install it, set RLY_DEVLINK_BIN, or drop --devlink.', 1);
  }
  let out;
  try {
    out = await exec(bin, ['--json', 'internal', String(port)]);
  } catch (err) {
    const detail = String((err && (err.stderr || err.message)) || err).trim().split('\n').pop();
    throw new CliError(`devlink could not publish port ${port}: ${detail}`, 1);
  }
  const origin = pickDevlinkUrl(out.stdout);
  const release = () => { exec(bin, ['forget', String(port)]).catch(() => {}); };
  return { kind: 'devlink', origin, release };
}

const configPath = (home) => path.join(home, 'config.json');

export function loadConfig(home) {
  try { return JSON.parse(fs.readFileSync(configPath(home), 'utf8')); } catch { return {}; }
}

export function saveConfig(home, patch) {
  fs.mkdirSync(home, { recursive: true });
  const next = { ...loadConfig(home), ...patch };
  for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
  fs.writeFileSync(configPath(home), JSON.stringify(next, null, 2));
  return next;
}
