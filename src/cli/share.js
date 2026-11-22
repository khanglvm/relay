// rly share: turn the share links of a running board on or off.
import { controlUrl, isAlive, loadRunning } from '../store.js';
import { CliError } from '../util.js';
import { mustLoad, printJson } from './io.js';

export async function cmdShare(args) {
  const record = mustLoad(args._[0]);
  const running = loadRunning(record.id);
  if (!running || !isAlive(running.pid)) {
    throw new CliError(`board "${record.id}" is not running. Use \`rly reopen ${record.id} --detach\` first.`, 5);
  }
  let role = args.all ? 'all' : args.role;
  if (role === 'readonly' || role === 'read-only') role = 'read';
  if (role !== undefined && !['collab', 'review', 'read', 'all'].includes(role)) {
    throw new CliError('--role must be collab, review, or read.', 4);
  }
  const shareUrl = new URL('/api/share', controlUrl(running));
  const headers = { 'content-type': 'application/json', 'x-relay-token': running.token || '' };
  let res;
  try {
    if (args.revoke) {
      res = await fetch(shareUrl, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ role: role || 'all' }),
      });
    } else if (role && role !== 'all') {
      res = await fetch(shareUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role }),
      });
    } else {
      res = await fetch(shareUrl, { method: 'GET', headers });
    }
  } catch (err) {
    throw new CliError(`could not reach board "${record.id}" at ${running.url}: ${String((err && err.message) || err)}`, 5);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new CliError((body && body.error) || `share request failed with HTTP ${res.status}`, res.status === 400 ? 4 : 5);
  }
  printJson({ status: args.revoke ? 'revoked' : role && role !== 'all' ? 'active' : 'shares', boardId: record.id, ...body });
  return 0;
}
