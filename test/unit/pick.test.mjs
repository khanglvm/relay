// The pick question: reading tiles, cleaning answers, and what the schema and lookup say about it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SPEC_SCHEMA, cleanAnswers, cleanPick, lookupSchema, normalizeSpec } from '../../src/spec/index.js';

const pickSpec = (extra = {}, items = ['a', 'b', 'c', 'd']) => ({ questions: [{ id: 'p', type: 'pick', label: 'Which?', items, ...extra }] });
const question = (extra, items) => normalizeSpec(pickSpec(extra, items)).questions[0];

test('tiles: strings and objects normalize, with media and captions kept', () => {
  const q = question({}, ['plain', { id: 'x', title: 'Tile X', caption: 'warm', image: 'https://e.com/x.png', video: 'https://youtu.be/abc', url: 'https://e.com/x' }]);
  assert.deepEqual(q.items[0], { id: 'plain', title: 'plain' });
  assert.equal(q.items[1].title, 'Tile X');
  assert.equal(q.items[1].caption, 'warm');
  assert.equal(q.items[1].video, 'https://youtu.be/abc');
  assert.equal(q.note, false, 'a pick carries its own notes');
});

test('tiles: bad input is refused with a message the agent can fix', () => {
  assert.throws(() => normalizeSpec(pickSpec({}, [])), /needs "items"/);
  assert.throws(() => normalizeSpec(pickSpec({}, ['a', 'a'])), /duplicate item id "a"/);
  assert.throws(() => normalizeSpec(pickSpec({}, [{ id: 'a', video: '/tmp/clip.mp4' }])), /"video" must be an http\(s\) URL/);
  assert.throws(() => normalizeSpec(pickSpec({}, [{ id: 'a', url: 'javascript:alert(1)' }])), /"url" must be an http\(s\) URL/);
  assert.throws(() => normalizeSpec(pickSpec({}, Array.from({ length: 61 }, (_, i) => `t${i}`))), /at most 60/);
});

test('min and max: bounded by the tile count, and a minimum makes the question required', () => {
  assert.deepEqual([question({}).min, question({}).max], [0, 4]);
  const q = question({ min: 2, max: 9 });
  assert.deepEqual([q.min, q.max, q.required], [2, 4, true]);
  assert.equal(question({ max: 1 }).max, 1);
  assert.equal(question({ min: 3, max: 1 }).max, 3, 'max never drops under min');
});

test('cleanPick keeps known ids once each, in order, up to max, with notes trimmed', () => {
  const q = question({ max: 2 });
  const answer = cleanPick(q, { picks: [{ id: 'b', note: '  nice ' }, 'zzz', { id: 'b' }, 'a', { id: 'c' }], overall: ' all good ' });
  assert.deepEqual(answer, { picks: [{ id: 'b', note: 'nice' }, { id: 'a' }], overall: 'all good' });
});

test('cleanPick honours itemNote and overall switches, and an empty answer is skipped', () => {
  const q = question({ itemNote: false, overall: false });
  assert.deepEqual(cleanPick(q, { picks: [{ id: 'a', note: 'x' }], overall: 'y' }), { picks: [{ id: 'a' }] });
  assert.equal(cleanPick(q, { picks: [], overall: 'only text' }), undefined);
  assert.equal(cleanPick(q, 'garbage'), undefined);
  assert.deepEqual(cleanPick(question({}), { picks: [], overall: 'only text' }), { picks: [], overall: 'only text' });
});

test('cleanAnswers cleans picks and leaves other answers as sent', () => {
  const spec = normalizeSpec({ questions: [{ id: 'p', type: 'pick', label: 'P', items: ['a', 'b'] }, { id: 't', type: 'text', label: 'T' }] });
  const out = cleanAnswers(spec, { p: { picks: ['a', 'nope'] }, t: 'hi' });
  assert.deepEqual(out, { p: { picks: [{ id: 'a' }] }, t: 'hi' });
  assert.deepEqual(cleanAnswers(spec, { p: { picks: ['nope'] } }), {});
});

test('the JSON Schema and rly schema know pick', () => {
  const enumValues = SPEC_SCHEMA.properties.questions.items.properties.type.enum;
  assert.ok(enumValues.includes('pick'));
  const found = lookupSchema('pick');
  assert.equal(found.kind, 'question');
  assert.ok(found.fields.items && found.fields.itemNote && found.fields.overall);
});

test('aliases: tiles, gallery and shortlist mean pick', () => {
  for (const alias of ['tiles', 'gallery', 'shortlist']) {
    assert.equal(normalizeSpec({ questions: [{ type: alias, label: 'L', items: ['a'] }] }).questions[0].type, 'pick');
  }
});
