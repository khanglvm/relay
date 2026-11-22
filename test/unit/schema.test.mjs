// schema/spec.v1.json is generated from SPEC_SCHEMA; this fails while they differ.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSchema, schemaOnDisk } from '../../scripts/gen-schema.mjs';

test('schema/spec.v1.json matches SPEC_SCHEMA (run `npm run gen:schema` after a change)', () => {
  assert.equal(schemaOnDisk(), renderSchema());
});
