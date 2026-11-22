// Small commands: config, a2ui, agent and the internal detached server.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, parseLinkValue, saveConfig, serializeLink } from '../link.js';
import { BLOCK_TYPES, SPEC_SCHEMA, TYPES } from '../spec/index.js';
import { lookupSchema } from '../spec/lookup.js';
import { runBoard } from '../server/index.js';
import { HOME } from '../store.js';
import { CliError } from '../util.js';
import { DEFAULT_BOARD_TIMEOUT_SEC, PKG_ROOT } from './context.js';
import { renderAgentTopic } from './agent-topics.js';
import { printJson } from './io.js';

export function cmdA2ui() {
  console.log(fs.readFileSync(path.join(PKG_ROOT, 'docs', 'A2UI.md'), 'utf8'));
  return 0;
}

const readDoc = (file) => fs.readFileSync(path.join(PKG_ROOT, 'docs', file), 'utf8');

// `rly agent` prints the whole guide; `rly agent <topic>` prints one part of it.
export function cmdAgent(topic) {
  if (topic === undefined || topic === 'all') {
    console.log(readDoc('AGENT.md'));
    return 0;
  }
  console.log(renderAgentTopic(topic, readDoc));
  return 0;
}

// `rly schema` prints the whole board schema; `rly schema <name>` prints one block or question type.
export function cmdSchema(name) {
  if (name === undefined) {
    console.log(JSON.stringify(SPEC_SCHEMA, null, 2));
    return 0;
  }
  const found = lookupSchema(name);
  if (!found) {
    throw new CliError(`unknown block or question type "${name}". Blocks: ${BLOCK_TYPES.join(', ')}. Questions: ${TYPES.join(', ')}.`, 4);
  }
  console.log(JSON.stringify(found, null, 2));
  return 0;
}

// `rly config [link [off|auto|devlink|command:CMD|<url>]]` — the saved link default, so
// every board prints a cross-device URL without a flag.
export function cmdConfig(args) {
  const [key, value] = args._;
  if (key === undefined) {
    printJson(loadConfig(HOME));
    return 0;
  }
  if (key !== 'link') throw new CliError(`unknown config key "${key}". Use: link.`, 4);
  if (value === undefined) {
    printJson({ link: loadConfig(HOME).link ?? 'off' });
    return 0;
  }
  const setting = parseLinkValue(value, 'link');
  const next = saveConfig(HOME, { link: setting.mode === 'off' ? null : serializeLink(setting) });
  printJson({ status: 'saved', link: next.link ?? 'off' });
  return 0;
}

export async function cmdServeInternal(args) {
  const id = args.id;
  if (!id) throw new CliError('__serve: missing --id');
  const { done } = await runBoard({
    id,
    port: args.port !== undefined ? Number.parseInt(args.port, 10) || 0 : 0,
    open: args.open !== false,
    timeoutSec: args.timeout !== undefined ? Math.max(0, Number.parseInt(args.timeout, 10) || 0) : DEFAULT_BOARD_TIMEOUT_SEC,
    quiet: true,
    // Detached board: timeout hands back to the agent but keeps the same
    // URL/port serving until Submit or explicit stop.
    keepAliveOnTimeout: true,
    link: args.link !== undefined ? parseLinkValue(args.link, '--link') : { mode: 'off' },
  });
  await done;
  return 0;
}
