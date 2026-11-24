import { spawn } from 'node:child_process';

// Opens a URL OR a local file/folder path in the OS default handler (browser
// for http(s), the registered app for a file). On success the file opens in
// whatever the user set as default (video player, editor, image viewer, …).
//
// RLY_OPEN_CMD overrides the platform opener with a custom command — the target
// is passed as its sole argument ("$1"). Power users can point it at a chooser;
// the test suite points it at a no-op so opening a file launches nothing.
// Agent hosts the person drives from another device (T3 Code, Sushi). A tab
// opened on this Mac lands on a screen nobody is watching, and the board is
// already in front of the person through the host's own view of it.
const REMOTE_AGENT_HOST_VARS = ['T3CODE_THREAD_ID', 'T3CODE_HOME', 'SUSHI_BOT_ID', 'SUSHI_HOME'];

/**
 * Whether a new board opens in this machine's browser when the caller passed
 * neither --open nor --no-open. RLY_OPEN (1/0, on/off, true/false, yes/no)
 * decides when set; otherwise boards stay closed under a remote agent host.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function autoOpenDefault(env = process.env) {
  const forced = String(env.RLY_OPEN ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(forced)) return true;
  if (['0', 'off', 'false', 'no'].includes(forced)) return false;
  return !REMOTE_AGENT_HOST_VARS.some((name) => env[name]);
}

export function openUrl(url) {
  try {
    const custom = process.env.RLY_OPEN_CMD;
    if (custom && custom.trim()) {
      spawn('/bin/sh', ['-c', `${custom} "$1"`, 'sh', url], { stdio: 'ignore', detached: true }).unref();
      return true;
    }
    const p = process.platform;
    const [cmd, args] =
      p === 'darwin' ? ['open', [url]]
      : p === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}
