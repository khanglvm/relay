#!/usr/bin/env node
/**
 * update-vendor.mjs
 * Zero-dep Node script that vendors chart.js, mermaid, and @viz-js/viz into vendor/
 *
 * Usage: node scripts/update-vendor.mjs
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const VENDOR_DIR = join(PKG_ROOT, 'vendor');

// ── helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(msg + '\n');
}

function bytes(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' MB';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' KB';
  return n + ' B';
}

function readVersion(pkgDir) {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  return pkgJson.version;
}

function assertNonEmpty(filePath, minBytes = 10_000) {
  const sz = statSync(filePath).size;
  if (sz < minBytes) {
    throw new Error(`${filePath} looks too small (${bytes(sz)}); something went wrong.`);
  }
  // Sanity: must NOT start with <!DOCTYPE (HTML error page)
  const head = readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 200);
  if (/^\s*<!doctype/i.test(head) || /^\s*<html/i.test(head)) {
    throw new Error(`${filePath} appears to be an HTML page, not a JS bundle.`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), 'relay-vendor-'));
log(`Temp dir: ${tmpDir}`);

try {
  mkdirSync(VENDOR_DIR, { recursive: true });
  // Install chart.js, mermaid, and @viz-js/viz into temp dir
  log('\nInstalling chart.js@4, mermaid@11, and @viz-js/viz …');
  execSync(
    'npm install chart.js@4 mermaid@11 @viz-js/viz --no-save --prefix ' + tmpDir,
    { stdio: 'inherit', cwd: tmpDir }
  );

  const nmDir = join(tmpDir, 'node_modules');

  // ── chart.js ────────────────────────────────────────────────────────────
  const chartSrc = join(nmDir, 'chart.js', 'dist', 'chart.umd.js');
  if (!existsSync(chartSrc)) {
    throw new Error(`chart.umd.js not found at ${chartSrc}`);
  }
  const chartDest = join(VENDOR_DIR, 'chart.umd.js');
  copyFileSync(chartSrc, chartDest);
  const chartVersion = readVersion(join(nmDir, 'chart.js'));
  const chartSize = statSync(chartDest).size;
  assertNonEmpty(chartDest, 50_000); // chart.js UMD is ~200 KB
  log(`\nchart.js  ${chartVersion}  →  vendor/chart.umd.js  (${bytes(chartSize)})`);

  // ── mermaid ─────────────────────────────────────────────────────────────
  const mermaidDistDir = join(nmDir, 'mermaid', 'dist');
  const mermaidCandidates = ['mermaid.min.js', 'mermaid.js'];
  let mermaidSrc = null;
  for (const candidate of mermaidCandidates) {
    const p = join(mermaidDistDir, candidate);
    if (existsSync(p)) {
      mermaidSrc = p;
      log(`Using mermaid bundle: ${candidate}`);
      break;
    }
  }
  if (!mermaidSrc) {
    // List dist dir for diagnosis
    const distContents = execSync(`ls "${mermaidDistDir}" 2>&1 || true`).toString().trim();
    throw new Error(
      `Could not find mermaid.min.js or mermaid.js in ${mermaidDistDir}.\n` +
      `Contents: ${distContents}`
    );
  }
  const mermaidDest = join(VENDOR_DIR, 'mermaid.min.js');
  copyFileSync(mermaidSrc, mermaidDest);
  const mermaidVersion = readVersion(join(nmDir, 'mermaid'));
  const mermaidSize = statSync(mermaidDest).size;
  assertNonEmpty(mermaidDest, 200_000); // mermaid bundle is ~2 MB
  log(`mermaid   ${mermaidVersion}  →  vendor/mermaid.min.js  (${bytes(mermaidSize)})`);

  // ── @viz-js/viz ─────────────────────────────────────────────────────────
  // viz-global.js is the UMD/IIFE standalone bundle that assigns the module's
  // named exports (instance, graphvizVersion, formats, engines) onto
  // globalThis.Viz via the pattern:
  //   v((A = "undefined"!=typeof globalThis ? globalThis : A||self).Viz = {})
  // So after loading via <script src>, window.Viz.instance() is available.
  const vizDistDir = join(nmDir, '@viz-js', 'viz', 'dist');
  const vizSrc = join(vizDistDir, 'viz-global.js');
  if (!existsSync(vizSrc)) {
    const distContents = execSync(`ls "${vizDistDir}" 2>&1 || true`).toString().trim();
    throw new Error(
      `Could not find viz-global.js in ${vizDistDir}.\n` +
      `Contents: ${distContents}`
    );
  }
  const vizDest = join(VENDOR_DIR, 'viz-standalone.js');
  copyFileSync(vizSrc, vizDest);
  const vizVersion = readVersion(join(nmDir, '@viz-js', 'viz'));
  const vizSize = statSync(vizDest).size;
  assertNonEmpty(vizDest, 500_000); // viz-global.js includes WASM payload, ~1.3 MB
  log(`@viz-js/viz  ${vizVersion}  →  vendor/viz-standalone.js  (${bytes(vizSize)})`);

  // ── VERSIONS.json ────────────────────────────────────────────────────────
  const versionsData = {
    'chart.js': chartVersion,
    'mermaid': mermaidVersion,
    '@viz-js/viz': vizVersion,
    'updatedAt': new Date().toISOString(),
  };
  writeFileSync(join(VENDOR_DIR, 'VERSIONS.json'), JSON.stringify(versionsData, null, 2) + '\n');
  log('\nWrote vendor/VERSIONS.json');

  log('\n✓ Vendor update complete.');
  log(`  chart.js     ${chartVersion}  ${bytes(chartSize)}`);
  log(`  mermaid      ${mermaidVersion}  ${bytes(mermaidSize)}`);
  log(`  @viz-js/viz  ${vizVersion}  ${bytes(vizSize)}`);

} finally {
  // Always clean up temp dir
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    log(`\nCleaned up temp dir: ${tmpDir}`);
  } catch (e) {
    log(`Warning: failed to clean up temp dir ${tmpDir}: ${e.message}`);
  }
}
