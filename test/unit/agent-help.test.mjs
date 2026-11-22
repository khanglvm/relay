// The agent-facing texts: topics cover the whole guide, the skill and the guide
// share one shapes block, and no text names a host. `rly schema <type>` covers every type.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_TOPICS, renderAgentTopic, splitSections } from '../../src/cli/agent-topics.js';
import { BLOCK_TYPES, TYPES } from '../../src/spec/constants.js';
import { BLOCK_FIELDS, lookupSchema, schemaFieldNames } from '../../src/spec/lookup.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const readDoc = (file) => read('docs', file);
const SHAPES = /## Block and question shapes[\s\S]*?\nButtons inside a2ui[^\n]*\n/;

test('every H2 of the agent guide belongs to exactly one topic', () => {
  const { sections } = splitSections(readDoc('AGENT.md'));
  for (const { title } of sections) {
    const owners = Object.entries(AGENT_TOPICS).filter(([, t]) => t.headings?.some((h) => title.startsWith(h)));
    assert.equal(owners.length, 1, `"${title}" is in ${owners.length} topics`);
  }
});

test('a heading inside a code fence does not start a section', () => {
  const { sections } = splitSections('intro\n## A\n```sh\n## not a heading\n```\n## B\ntext');
  assert.deepEqual(sections.map((s) => s.title), ['A', 'B']);
});

test('a topic prints only its own sections; an unknown topic lists the topics', () => {
  const blocks = renderAgentTopic('blocks', readDoc);
  assert.match(blocks, /## Blocks/);
  assert.doesNotMatch(blocks, /## Presence/);
  assert.match(renderAgentTopic('a2ui', readDoc), /A2UI/);
  assert.throws(() => renderAgentTopic('nope', readDoc), /unknown agent topic "nope"[\s\S]*questions/);
});

test('the skill and the agent guide carry the same shapes block', () => {
  const inSkill = read('skills', 'relay', 'SKILL.md').match(SHAPES)?.[0];
  assert.ok(inSkill, 'skill has the shapes block');
  assert.equal(readDoc('AGENT.md').match(SHAPES)?.[0], inSkill);
});

test('agent-facing text names no host or network', () => {
  const texts = [read('skills', 'relay', 'SKILL.md'), readDoc('AGENT.md'), read('src', 'cli', 'skill.js')];
  for (const text of texts) assert.doesNotMatch(text, /devlink|tailscale|cloudflared|tunnel/i);
});

test('every block and question type has a schema lookup', () => {
  for (const type of BLOCK_TYPES) assert.equal(lookupSchema(type)?.kind, 'block', type);
  for (const type of TYPES) assert.equal(lookupSchema(type)?.kind, 'question', type);
  assert.equal(lookupSchema('nope'), null);
});

test('every block property of the schema is listed under a block type', () => {
  const listed = new Set(['type', 'ref', 'height', ...Object.values(BLOCK_FIELDS).flat()]);
  for (const name of schemaFieldNames().block) assert.ok(listed.has(name), `block property "${name}" belongs to no type in lookup.js`);
});

test('rly schema chart prints only the chart fields', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'rly.js'), ...args], { encoding: 'utf8' });
  const chart = JSON.parse(run('schema', 'chart').stdout);
  assert.deepEqual(Object.keys(chart.fields).sort(), ['config', 'height', 'kind', 'labels', 'ref', 'series', 'title', 'type']);
  const bad = run('schema', 'nope');
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /unknown block or question type "nope"/);
  assert.match(run('agent', 'sharing').stdout, /A private URL for other devices/);
});
