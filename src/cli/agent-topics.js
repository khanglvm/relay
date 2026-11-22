// `rly agent <topic>`: prints one part of docs/AGENT.md (or docs/A2UI.md) so an agent loads only what it needs.
import { CliError } from '../util.js';

// Topic -> the H2 headings of docs/AGENT.md it prints, matched by prefix.
// A unit test checks that every H2 of the guide belongs to exactly one topic.
export const AGENT_TOPICS = {
  questions: {
    summary: 'creating boards, the spec fields, question types and answer shapes',
    headings: ['Creating boards', 'Board spec (JSON)'],
  },
  blocks: {
    summary: 'every block shape, option visuals, local file links, sizing, custom html',
    headings: ['Block and question shapes', 'Blocks', 'Custom HTML sizing contract'],
  },
  annotate: {
    summary: 'element comments on images, charts and html; reading annotations; replying; editable diagrams',
    headings: ['Annotations', 'Editable diagrams'],
  },
  lifecycle: {
    summary: 'reading results, wait and result, timeouts, presence, update, reopen, rescue',
    headings: ['Two execution patterns', 'Presence', 'Waiting and push-wake', 'Managing boards', 'Live board mutation', 'Tips for agents'],
    preamble: true,
  },
  sharing: {
    summary: 'opening a board on another device: share links, public url, link provider',
    headings: ['Same-Wi-Fi sharing', 'A private URL for other devices'],
  },
  mcp: {
    summary: 'relay as an MCP server: inline boards, tools, hosting',
    headings: ['Inline mode'],
  },
  a2ui: {
    summary: 'A2UI widget grammar: live status, numbers, buttons',
    file: 'A2UI.md',
  },
};

/** Splits a markdown guide into its text before the first H2 and its H2 sections. Headings inside code fences are text. */
export function splitSections(md) {
  const sections = [];
  let preamble = [];
  let current = null;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^## (.+)$/.exec(line);
    if (heading) {
      current = { title: heading[1].trim(), lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })),
  };
}

/** The topic list `rly agent` prints for an unknown topic. */
export function topicIndex() {
  const rows = Object.entries(AGENT_TOPICS).map(([name, t]) => `  ${name.padEnd(10)} ${t.summary}`);
  return ['rly agent <topic> prints one part of the guide:', ...rows, '  all        the whole guide (same as `rly agent`)'].join('\n');
}

/**
 * The text of one topic. `readDoc(file)` returns a docs/ file as text; the
 * caller owns the filesystem so this stays testable.
 */
export function renderAgentTopic(topic, readDoc) {
  const def = AGENT_TOPICS[topic];
  if (!def) throw new CliError(`unknown agent topic "${topic}".\n${topicIndex()}`, 4);
  if (def.file) return readDoc(def.file);
  const { preamble, sections } = splitSections(readDoc('AGENT.md'));
  const parts = def.preamble ? [preamble] : [];
  for (const prefix of def.headings) {
    const hits = sections.filter((s) => s.title.startsWith(prefix));
    if (!hits.length) throw new CliError(`agent topic "${topic}": the guide has no section "${prefix}".`, 1);
    parts.push(...hits.map((s) => s.text));
  }
  return parts.join('\n\n');
}
