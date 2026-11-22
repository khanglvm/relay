// Forgiving normalization: spellings agents reach for read as the field or type we mean.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpec } from '../../src/spec/index.js';
import { isCheckerFailure } from '../../src/spec/ready.js';
import vm from 'node:vm';

const chartBlock = (block) => normalizeSpec({ blocks: [block] }).blocks[0];
const DATA = { labels: ['a', 'b'], series: [{ label: 's', data: [1, 2] }] };

test('a chart kind may be the block type, chartType or chart_type', () => {
  for (const block of [{ type: 'bar', ...DATA }, { type: 'chart', chartType: 'bar', ...DATA }, { type: 'chart', chart_type: 'bar', ...DATA }]) {
    const out = chartBlock(block);
    assert.equal(out.type, 'chart');
    assert.equal(out.kind, 'bar');
  }
});

test('Chart.js datasets read as series, and an explicit kind wins over a type alias', () => {
  const out = chartBlock({ type: 'line', kind: 'pie', labels: ['a'], datasets: [{ label: 's', data: [1] }] });
  assert.equal(out.kind, 'pie');
  assert.deepEqual(out.series, [{ label: 's', data: [1] }]);
});

test('block type aliases map to the block', () => {
  assert.equal(chartBlock({ type: 'md', md: 'hi' }).type, 'markdown');
  assert.equal(chartBlock({ type: 'metrics', items: [{ label: 'a', value: '1' }] }).type, 'kpi');
});

test('question choices read as options', () => {
  const q = normalizeSpec({ questions: [{ type: 'single', label: 'x', choices: ['a', 'b'] }] }).questions[0];
  assert.deepEqual(q.options.map((o) => o.value), ['a', 'b']);
});

test('error text says how to fix the problem', () => {
  assert.throws(() => chartBlock({ type: 'chart', title: 'x' }), /"kind".*"labels".*"series".*rly schema chart/);
  assert.throws(() => chartBlock({ type: 'nope' }), /Use one of:.*rly schema <type>/);
  assert.throws(
    () => normalizeSpec({ responseRequired: false, questions: [{ label: 'x' }] }),
    /Remove "responseRequired" to collect answers, or remove "questions"/,
  );
});

test('only the engine\'s own errors count as a checker failure', () => {
  const realm = (code) => vm.runInNewContext(code);
  for (const code of ['new TypeError("x.addHook is not a function")', 'new ReferenceError("TextEncoder is not defined")']) {
    assert.equal(isCheckerFailure(realm(code)), true, code);
  }
  assert.equal(isCheckerFailure(realm('new Error("Parse error on line 2")')), false);
  assert.equal(isCheckerFailure(undefined), false);
});
