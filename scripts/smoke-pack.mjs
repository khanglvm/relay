#!/usr/bin/env node
// Packs the package, installs the tarball into a temp project, and imports it
// the way a user would: the library entry, the subpath exports and the types.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-pack-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

try {
  const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], ROOT));
  const project = path.join(work, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"smoke","private":true,"type":"module"}');
  run('npm', ['install', '--no-audit', '--no-fund', path.join(work, filename)], project);

  fs.writeFileSync(
    path.join(project, 'check.mjs'),
    `import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileA2ui, createBoard, normalizeSpec, validateSpec } from '@khanglvm/relay';
import { SPEC_SCHEMA } from '@khanglvm/relay/spec';
import { compileExpress } from '@khanglvm/relay/a2ui';
import { registerRelay, runMcp } from '@khanglvm/relay/mcp';
const require = createRequire(import.meta.url);
const pkgDir = new URL('./node_modules/@khanglvm/relay/', import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve('@khanglvm/relay/schema.json'), 'utf8'));
const examples = new URL('skills/relay/examples/', pkgDir);
const files = readdirSync(examples).filter((f) => f.endsWith('.json'));
if (!files.length) throw new Error('no examples in the package');
for (const f of files) {
  const verdict = validateSpec(JSON.parse(readFileSync(new URL(f, examples), 'utf8')), { cwd: examples.pathname });
  if (!verdict.ok) throw new Error(f + ': ' + verdict.errors.join('; '));
}
for (const fn of [compileA2ui, createBoard, normalizeSpec, compileExpress, runMcp, registerRelay]) if (typeof fn !== 'function') throw new Error('missing export');
if (schema.title !== SPEC_SCHEMA.title) throw new Error('schema.json differs from SPEC_SCHEMA');
if (!existsSync(new URL('types/index.d.ts', pkgDir))) throw new Error('types/index.d.ts is not packed');
console.log('import smoke ok: ' + files.length + ' examples validated');
`,
  );
  process.stdout.write(run('node', ['check.mjs'], project));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
