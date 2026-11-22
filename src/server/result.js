// Artifact checks and the on-result hook that runs when a board finishes.
import { spawn } from 'node:child_process';

export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
export const ARTIFACT_MIMES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function artifactBytesMatch(mime, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return false;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

// Push-wake: run the agent's own local shell command after a board finishes.
// The full result JSON is written to the command's stdin; RLY_BOARD_ID /
// RLY_STATUS / RLY_URL are exported. Failures are swallowed (best effort) —
// only a stderr note when not quiet. A 30s kill timer prevents a hung command
// from keeping the process alive.
export function runOnResult(cmd, result, { quiet = false } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return;
  try {
    const child = spawn('/bin/sh', ['-c', cmd], {
      env: {
        ...process.env,
        RLY_BOARD_ID: result.boardId || '',
        RLY_STATUS: result.status || '',
        RLY_URL: result.url || '',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {
      if (!quiet) process.stderr.write(`[relay] --on-result command failed to spawn\n`);
    });
    try {
      child.stdin.write(JSON.stringify(result));
      child.stdin.end();
    } catch {
      // best effort — stdin may already be gone
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 30000);
    killTimer.unref();
    child.on('close', () => clearTimeout(killTimer));
    child.unref();
  } catch {
    if (!quiet) process.stderr.write(`[relay] --on-result command failed to run\n`);
  }
}
