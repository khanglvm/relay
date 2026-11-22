#!/usr/bin/env node
// Writes schema/spec.v1.json from SPEC_SCHEMA in src/spec.js. `--write` updates
// the file; without it the JSON goes to stdout. test/unit/schema.test.mjs fails
// while the file on disk differs from this output.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPEC_SCHEMA } from '../src/spec/index.js';

export const SCHEMA_FILE = fileURLToPath(new URL('../schema/spec.v1.json', import.meta.url));

export function renderSchema() {
  return `${JSON.stringify(SPEC_SCHEMA, null, 2)}\n`;
}

export function schemaOnDisk() {
  return readFileSync(SCHEMA_FILE, 'utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    writeFileSync(SCHEMA_FILE, renderSchema());
    console.log(`wrote ${SCHEMA_FILE}`);
  } else {
    process.stdout.write(renderSchema());
  }
}
