// The browser files of each page, in the order they run. The web board
// (src/server/page.js) and the MCP App page (src/mcp.js) both assemble their
// scripts and styles from this list, so a file added here reaches both pages.
//
// Browser scripts share one scope per page. A bundle part holds files that read
// as one script; `open` and `close` wrap them (the IIFE the files sit inside),
// and parts are joined by a newline. The files never run on their own.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory that the file paths below are relative to (the package's src/). */
export const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const IIFE_CLOSE = '})();\n';

const BLOCKS_OPEN = "// blocks.js — window.RelayBlocks: renders normalized \"blocks\" (markdown,\n// table, code, chart, mermaid, html) into a container. Zero runtime deps;\n// vanilla DOM. Chart.js / Mermaid are vendored and lazy-loaded on demand.\n// XSS-safe: all source text is HTML-escaped before any markdown transform.\n(() => {\n  'use strict';\n\n";

const ANNOTATE_OPEN = "/* relay annotate — element-level comments (window.RelayAnnotate).\n   Self-contained vanilla JS: hover pin, count badges, comment popover,\n   text-selection capture, and an editable summary list. Zero dependencies.\n   Load order: blocks.js, annotate.js, app.js (all inlined by the server). */\n(() => {\n  'use strict';\n\n";

const APP_OPEN = "(() => {\n  'use strict';\n\n";

const BOARD_OPEN = "// board.js — the relay board as an MCP App (SEP-1865 \"io.modelcontextprotocol/ui\").\n//\n// This is the same board relay opens in a browser, but rendered INSIDE the\n// host app (Claude desktop/mobile, Codex, …) as a sandboxed inline iframe.\n// There is no local HTTP server here: every exchange with the host travels over\n// JSON-RPC on window.postMessage — the spec arrives as the tool result, the\n// user's final submission goes back as a `ui/message` user turn, and vendored\n// libraries (Chart.js / Mermaid / Viz.js) are pulled through the host's\n// `resources/read`.\n//\n// Rich blocks are rendered by the SAME window.RelayBlocks as the browser board\n// (markdown, code, diff, table, chart, mermaid, graphviz, image, html), so the\n// two surfaces stay in lockstep. Annotations / autosave / heartbeat are\n// browser-server concepts and intentionally absent; per-question notes and the\n// overall comment carry structured feedback back to the agent.\n(() => {\n  'use strict';\n\n";

const plain = (file) => ({ open: '', files: [file], close: '' });
const iife = (open, files) => ({ open, files, close: IIFE_CLOSE });

export const STYLE_PARTS = [plain('ui/style.css')];
export const BLOCKS_STYLE_PARTS = [plain('ui/blocks.css'), plain('ui/a2ui.css')];
export const ANNOTATE_STYLE_PARTS = [plain('ui/annotate.css')];

export const BLOCKS_SCRIPT_PARTS = [
  plain('ui/a2ui-state.js'),
  plain('ui/a2ui.js'),
  iife(BLOCKS_OPEN, [
    'ui/blocks/core.js',
    'ui/blocks/markdown.js',
    'ui/blocks/code.js',
    'ui/blocks/diff.js',
    'ui/blocks/git-conflict.js',
    'ui/blocks/video.js',
    'ui/blocks/pdf.js',
    'ui/blocks/table.js',
    'ui/blocks/vendor.js',
    'ui/blocks/chart.js',
    'ui/blocks/mermaid.js',
    'ui/blocks/graphviz.js',
    'ui/blocks/plantuml.js',
    'ui/blocks/image.js',
    'ui/blocks/palette.js',
    'ui/blocks/kpi.js',
    'ui/blocks/typography.js',
    'ui/blocks/compare.js',
    'ui/blocks/viewer-fullscreen.js',
    'ui/blocks/viewer.js',
    'ui/blocks/html.js',
    'ui/blocks/dispatch.js',
    'ui/blocks/file-links.js',
    'ui/blocks/api.js',
  ]),
];

export const ANNOTATE_SCRIPT_PARTS = [
  iife(ANNOTATE_OPEN, [
    'ui/annotate/core.js',
    'ui/annotate/highlights.js',
    'ui/annotate/chrome.js',
    'ui/annotate/badges.js',
    'ui/annotate/popover.js',
    'ui/annotate/mutations.js',
    'ui/annotate/summary.js',
    'ui/annotate/api.js',
  ]),
];

/** The web board's own script. */
export const APP_SCRIPT_PARTS = [
  iife(APP_OPEN, [
    'ui/app/core.js',
    'ui/app/theme.js',
    'ui/app/drafts.js',
    'ui/app/persistence.js',
    'ui/app/autosave.js',
    'ui/app/presence.js',
    'ui/app/annotations.js',
    'ui/app/questions.js',
    'ui/app/question-color.js',
    'ui/app/render.js',
    'ui/app/share.js',
    'ui/app/submit.js',
    'ui/app/prefilled.js',
    'ui/app/iframe-bridge.js',
    'ui/app/heartbeat.js',
  ]),
];

/** The MCP App page's own script. */
export const BOARD_SCRIPT_PARTS = [
  iife(BOARD_OPEN, [
    'mcp-ui/board/core.js',
    'mcp-ui/board/bridge.js',
    'mcp-ui/board/normalize.js',
    'mcp-ui/board/vendors.js',
    'mcp-ui/board/block-ctx.js',
    'mcp-ui/board/state.js',
    'mcp-ui/board/controls.js',
    'mcp-ui/board/render.js',
    'mcp-ui/board/lifecycle.js',
  ]),
];

/**
 * Joins the parts of one bundle into its text.
 * @param {Array<{ open: string, files: string[], close: string }>} parts
 * @param {(file: string) => string} read Returns a file's text relative to SRC_DIR, or '' when it is missing.
 */
export function assemble(parts, read) {
  return parts.map((part) => part.open + part.files.map(read).join('') + part.close).join('\n');
}

/**
 * Fills a page template (src/ui/index.html or src/mcp-ui/index.html).
 * `entry` picks the page script: 'app' for the web board, 'board' for the MCP App.
 * The boot JSON is filled last, so inlined text is never rescanned for placeholders.
 * @param {string} html
 * @param {{ title: string, bootJson: string, entry: 'app' | 'board' }} fields `title` must already be HTML-escaped.
 * @param {(file: string) => string} read
 */
export function fillPage(html, { title, bootJson, entry }, read) {
  const entryParts = entry === 'app' ? APP_SCRIPT_PARTS : BOARD_SCRIPT_PARTS;
  const entryMarker = entry === 'app' ? '/*__APP_JS__*/' : '/*__BOARD_JS__*/';
  return html
    .split('__TITLE__').join(title)
    .split('/*__CSS__*/').join(assemble(STYLE_PARTS, read))
    .split('/*__BLOCKS_CSS__*/').join(assemble(BLOCKS_STYLE_PARTS, read))
    .split('/*__ANNOTATE_CSS__*/').join(assemble(ANNOTATE_STYLE_PARTS, read))
    .split('/*__BLOCKS_JS__*/').join(assemble(BLOCKS_SCRIPT_PARTS, read))
    .split('/*__ANNOTATE_JS__*/').join(assemble(ANNOTATE_SCRIPT_PARTS, read))
    .split(entryMarker).join(assemble(entryParts, read))
    .split('__BOOT_JSON__').join(bootJson);
}
