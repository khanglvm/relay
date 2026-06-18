import { spawn } from 'node:child_process';

// Opens a URL OR a local file/folder path in the OS default handler (browser
// for http(s), the registered app for a file). On success the file opens in
// whatever the user set as default (video player, editor, image viewer, …).
//
// RLY_OPEN_CMD overrides the platform opener with a custom command — the target
// is passed as its sole argument ("$1"). Power users can point it at a chooser;
// the test suite points it at a no-op so opening a file launches nothing.
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
