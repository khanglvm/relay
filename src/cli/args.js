// Command-line argument parsing.
import { CliError } from '../util.js';

const VALUED_FLAGS = new Set([
  'file', 'html', 'html-file', 'title', 'intro', 'timeout', 'port',
  'submit-label', 'height', 'limit', 'target', 'id', 'replies',
  'on-result', 'notify-cmd', 'idle-grace', 'scope', 'range',
  'host', 'token', 'allow-origin', 'role', 'public-url', 'link',
]);

function camel(key) {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const args = { _: [], q: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-q' || t === '--question') {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${t} needs a value.`);
      args.q.push(v);
    } else if (t === '-') {
      args.stdin = true;
    } else if (t.startsWith('--')) {
      let key = t.slice(2);
      let val = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (VALUED_FLAGS.has(key)) {
        val = argv[++i];
        if (val === undefined) throw new CliError(`--${key} needs a value.`);
      }
      if (key === 'no-open') {
        args.open = false;
      } else {
        args[camel(key)] = val;
      }
    } else {
      args._.push(t);
    }
  }
  return args;
}
