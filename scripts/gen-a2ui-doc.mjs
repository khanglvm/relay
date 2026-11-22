#!/usr/bin/env node
// Writes docs/A2UI.md: Relay's own guide (src/a2ui/guide.md) followed by the Express
// grammar, component signatures and examples that the A2UI agent SDK generates from
// the catalog. `--write` updates the file; without it the text goes to stdout.
// test/a2ui.test.mjs fails while docs/A2UI.md is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const SDK_FILE = here('../src/a2ui/vendor/a2ui-agent.mjs');
const CATALOG_FILE = here('../src/a2ui/catalog.json');
const EXAMPLES_FILE = here('../src/a2ui/examples.json');
const GUIDE_FILE = here('../src/a2ui/guide.md');
export const DOC_FILE = here('../docs/A2UI.md');

/** Each example as a caption and a fenced A2UI JSON block, which the SDK rewrites in Express. */
function examplesMarkdown() {
  const examples = JSON.parse(readFileSync(EXAMPLES_FILE, 'utf8'));
  return Object.entries(examples)
    .map(([caption, messages]) => `${caption}\n\n\`\`\`json\n${JSON.stringify(messages)}\n\`\`\``)
    .join('\n\n');
}

export async function renderA2uiDoc() {
  const sdk = await import(pathToFileURL(SDK_FILE).href);
  const catalog = sdk.CatalogConfig.fromPath(CATALOG_FILE);
  const format = new sdk.ExpressFormatFactory().createFormat([catalog.catalog], { [catalog.catalog.id]: examplesMarkdown() });
  const reference = [...new sdk.SkillGenerator(format).generateSkillSet()].map(([, skill]) => skill.content.trim());
  return `${readFileSync(GUIDE_FILE, 'utf8').trim()}\n\n${reference.join('\n\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await renderA2uiDoc();
  if (process.argv.includes('--write')) writeFileSync(DOC_FILE, text);
  else process.stdout.write(text);
  process.stderr.write(`docs/A2UI.md: ${text.length} characters\n`);
}
