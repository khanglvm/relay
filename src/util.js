export class CliError extends Error {
  constructor(message, code = 4) {
    super(message);
    this.code = code;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pollFor(fn, timeoutMs, intervalMs = 150) {
  const end = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}
