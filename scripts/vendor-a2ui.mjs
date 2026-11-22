#!/usr/bin/env node
// Rebuilds src/a2ui/vendor from the pinned npm release of A2UI's agent SDK. Relay has
// no runtime dependencies, so the SDK ships as one bundled file instead.
// Usage: node scripts/vendor-a2ui.mjs [version]   (default: the version in src/a2ui/vendor/VERSION)
// Needs esbuild on PATH (or RLY_ESBUILD); work happens in a temp dir under RLY_VENDOR_TMP or the OS temp dir.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../src/a2ui/vendor/', import.meta.url));
const version = process.argv[2] || readFileSync(join(OUT, 'VERSION'), 'utf8').trim();
const work = mkdtempSync(join(process.env.RLY_VENDOR_TMP || tmpdir(), 'a2ui-vendor-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: ['ignore', 'inherit', 'inherit'] });

try {
  run('npm', ['init', '-y']);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@a2ui/agent@${version}`]);
  writeFileSync(join(work, 'entry.mjs'), "export { A2uiGenerator, CatalogConfig, ExpressFormatFactory, SkillGenerator, A2uiError } from '@a2ui/agent';\n");
  const bundle = join(OUT, 'a2ui-agent.mjs');
  run(process.env.RLY_ESBUILD || 'esbuild', ['entry.mjs', '--bundle', '--minify', '--platform=node', '--format=esm', '--target=node18', '--legal-comments=eof', '--log-level=warning', `--outfile=${bundle}`]);
  copyFileSync(join(work, 'node_modules/@a2ui/agent/LICENSE'), join(OUT, 'LICENSE'));
  copyFileSync(join(work, 'node_modules/antlr4ng/LICENSE.txt'), join(OUT, 'antlr4ng-LICENSE.txt'));
  writeFileSync(join(OUT, 'VERSION'), `${version}\n`);
  console.log(`@a2ui/agent ${version} -> ${bundle} (${statSync(bundle).size} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
