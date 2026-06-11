import { spawn } from 'node:child_process';

export function openUrl(url) {
  try {
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
