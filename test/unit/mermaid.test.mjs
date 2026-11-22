// Mermaid blocks are checked in Node before a board opens: every diagram type the
// vendored mermaid knows must pass, and a broken diagram must be refused with the
// parser's own message and the block's location.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSpecReady, normalizeSpec } from '../../src/spec/index.js';

// One valid diagram per type. Together they reach the label sanitizer
// (DOMPurify), the langium parsers (TextEncoder, structuredClone) and link
// handling (URL), each of which needs something a bare vm context lacks.
const VALID = {
  flowchartWithLabels: 'graph TD\n  A["<b>x</b> & y"]-->|go|B{Ok?}\n  click A "https://example.com" "tip"',
  markdownLabel: 'graph TD\n  A["`**bold** text`"]-->B',
  initDirective: '%%{init: {"theme":"dark"}}%%\ngraph TD\n  A-->B',
  sequence: 'sequenceDiagram\n  Alice->>Bob: Hi <br/> there',
  class: 'classDiagram\n  class Animal{\n    +int age\n    +eat()\n  }\n  Animal <|-- Duck',
  state: 'stateDiagram-v2\n  [*] --> S1\n  S1 --> [*]',
  er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  gantt: 'gantt\n  dateFormat YYYY-MM-DD\n  section S\n  A :a1, 2024-01-01, 3d',
  pie: 'pie title P\n  "a": 1\n  "b": 2',
  journey: 'journey\n  title J\n  section S\n    Do: 5: Me',
  gitGraph: 'gitGraph\n  commit\n  branch dev\n  commit',
  mindmap: 'mindmap\n  root((r))\n    A\n    B',
  timeline: 'timeline\n  title T\n  2020 : a',
  quadrant: 'quadrantChart\n  x-axis L --> H\n  y-axis L --> H\n  A: [0.3, 0.6]',
  xychart: 'xychart-beta\n  x-axis [a, b]\n  y-axis 0 --> 10\n  bar [1, 5]',
  sankey: 'sankey-beta\n\nA,B,10',
  packet: 'packet-beta\n  0-15: "Src"',
  architecture: 'architecture-beta\n  service db(database)[DB]',
  kanban: 'kanban\n  todo[Todo]\n    t1[Task]',
  c4: 'C4Context\n  Person(a, "A")',
  radar: 'radar-beta\n  axis a, b, c\n  curve x{1,2,3}',
};

const BROKEN = {
  flowchart: 'graph TD\n  A-->',
  class: 'classDiagram\n  class {',
  pie: 'pie\n  "a": x',
};

function mermaidSpec(code) {
  return normalizeSpec({ title: 'mermaid', blocks: [{ type: 'mermaid', code }] });
}

for (const [kind, code] of Object.entries(VALID)) {
  test(`a valid ${kind} diagram passes the mermaid check`, async () => {
    await assertSpecReady(mermaidSpec(code));
  });
}

for (const [kind, code] of Object.entries(BROKEN)) {
  test(`a broken ${kind} diagram is refused with the parser's message`, async () => {
    await assert.rejects(assertSpecReady(mermaidSpec(code)), (err) => {
      assert.match(err.message, /^board\.blocks\[0\].*: invalid mermaid syntax — /);
      assert.match(err.message, /Parse error|Parsing failed/);
      return true;
    });
  });
}
