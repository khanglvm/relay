# relay

**The relay between AI agents and humans — boards, blocks, and element-level comments.**

`rly` lets an AI agent (Claude Code, Codex, or anything that can run a CLI) ask
its user structured questions in a clean browser page — single/multi choice,
yes-no, free text, rating scales — and/or present rich content blocks (markdown,
charts, diagrams, tables, code, custom HTML), then **block until the user clicks
Submit** and read the answers as JSON. No more "type *done* in the terminal",
no more hand-rolled HTML + throwaway servers.

Users can **hover chart points, diagram nodes, table cells, or select text to
leave inline comments** — returned alongside answers as `result.annotations`.

- Zero runtime dependencies — plain Node ≥ 18, vanilla HTML/CSS/JS UI
- Light/dark theme (auto + manual toggle), responsive, content-focused
- Real-time answer autosave (drafts survive timeout/cancel)
- Auto-closes the tab after submit and unblocks the CLI
- Native content blocks: markdown, mermaid diagrams, Chart.js charts, tables, code, sandboxed HTML
- Chart.js and Mermaid are **vendored and lazy-loaded** only when a board uses them — the base board stays dependency-free and as fast as before
- Element-level annotations: users comment on chart points, diagram nodes, table cells, text, or custom HTML elements; returned as `result.annotations`
- Multiple boards at once, local history: reuse / modify / reopen / remove
- Agent-first: JSON on stdout, logs on stderr, `--detach` + `wait` for shell tools with execution time limits, built-in agent guide & skill

## Install

```sh
npm i -g @khanglvm/relay     # provides `rly` (and `relay`)
# or per-invocation:
npx -y @khanglvm/relay help
```

## Quick start

```sh
# Quick inline questions ("!" = required, label::type::options)
rly ask -q "Deploy to prod?::yesno" -q "!Environment::single::dev,staging,prod"

# Full board from a spec
rly ask --file spec.json --timeout 1800

# Visualization-only (prototype/idea); submit button = "Acknowledge"
rly show --html-file prototype.html --title "Dashboard concept" --height 600

# Non-blocking pattern (for agent tools with exec timeouts)
rly ask --file spec.json --detach   # → {"boardId":"b-…","url":"http://127.0.0.1:…"}
rly wait b-xxxxx                    # blocks until submit, prints result JSON
```

The browser opens automatically; the user answers and clicks **Submit**; the
CLI prints something like:

```json
{
  "status": "submitted",
  "boardId": "b-k3x9q2",
  "answers": { "q1": "yes", "q2": "staging" },
  "skipped": [],
  "comment": "ship it",
  "annotations": [],
  "durationMs": 23000
}
```

## Board spec

```jsonc
{
  "title": "Feature direction",
  "intro": "Context shown under the title.",
  "blocks": [
    { "type": "markdown", "md": "## Background\nUse this context when deciding." }
  ],
  "allowPartial": true,        // user may submit with gaps (returned in "skipped")
  "note": true,                // optional free-text box → result "comment"
  "autoClose": true,           // tab closes itself after submit
  "questions": [
    { "id": "approach", "type": "single", "label": "Which approach?", "required": true,
      "options": [{ "value": "a", "label": "A", "description": "fast" }, "B"], "other": true },
    { "id": "scope",  "type": "multi",    "label": "Include?", "options": ["api", "ui", "docs"] },
    { "id": "ship",   "type": "yesno",    "label": "Ship this week?" },
    { "id": "name",   "type": "text",     "label": "Codename?", "placeholder": "falcon" },
    { "id": "notes",  "type": "textarea", "label": "Constraints?" },
    { "id": "conf",   "type": "scale",    "label": "Confidence?", "min": 1, "max": 5,
      "minLabel": "low", "maxLabel": "high",
      "blocks": [{ "type": "markdown", "md": "Rate your confidence in the chosen approach." }] }
  ]
}
```

`rly schema` prints the full JSON Schema; `rly agent` prints the complete
agent-oriented guide (answer shapes, block reference, annotation shape, patterns).

## Content blocks

Blocks can appear at the board level (`"blocks": [...]` on the root) or per question
(`"blocks": [...]` on a question object). Legacy `"html"` / `"htmlFile"` fields are
still accepted and normalised into a single `html` block automatically.

### Markdown

```json
{ "type": "markdown", "md": "## Section\nAny **CommonMark** prose." }
```

Built-in mini renderer — no library loaded.

### Mermaid diagram

```json
{ "type": "mermaid", "code": "graph TD; A-->B; B-->C", "height": 400 }
```

Lazy-loads the vendored Mermaid bundle only when used. `height` clamps to
100–2400 px (default: natural flow, max 1200 px with scroll).

### Chart — shorthand

```json
{
  "type": "chart",
  "kind": "bar",
  "title": "Q1 velocity",
  "labels": ["Jan", "Feb", "Mar"],
  "series": [
    { "label": "Shipped", "data": [12, 19, 14], "color": "#4d8a66" },
    { "label": "Planned", "data": [15, 15, 15] }
  ],
  "height": 320
}
```

`kind`: `bar` | `line` | `pie` | `doughnut` | `radar` | `scatter`.
Omit `color` to use the built-in palette.

### Chart — full Chart.js config

```json
{
  "type": "chart",
  "config": {
    "type": "bar",
    "data": { "labels": ["A", "B"], "datasets": [{ "label": "x", "data": [1, 2] }] },
    "options": { "plugins": { "legend": { "display": false } } }
  },
  "height": 280
}
```

Pass any valid Chart.js v4 config object to `config`. Lazy-loads the vendored
Chart.js bundle.

### Table

```json
{
  "type": "table",
  "columns": [
    { "key": "name", "label": "Name" },
    { "key": "status", "label": "Status", "align": "center" },
    { "key": "score", "label": "Score", "align": "right" }
  ],
  "rows": [
    { "name": "Alpha", "status": "done", "score": 92 },
    { "name": "Beta",  "status": "wip",  "score": 71 }
  ],
  "sortable": true
}
```

`columns` may also be a plain `["A", "B", "C"]` string array, with `rows` as
parallel arrays: `[[val, val, val], ...]`. Users can click column headers to
sort when `"sortable": true`.

### Code

```json
{ "type": "code", "lang": "js", "code": "const x = 1 + 2;" }
```

Rendered in a styled pre/code block. `lang` is optional.

### HTML (sandboxed iframe)

```json
{ "type": "html", "html": "<h1>Hello</h1>", "height": 360 }
```

or reference a file:

```json
{ "type": "html", "htmlFile": "viz.html", "height": 400 }
```

Rendered in a **sandboxed iframe** (`allow-scripts`, no parent access).
Width: always 100% of the content column — ~820 px max on desktop, ~300 px min
on phones. Height: 100–2400 px, default 360. Fragments (no `<html>` tag) are
auto-wrapped to match the current theme; full documents receive a
`?theme=light|dark` query param.

## Annotations

Users can leave inline comments on any annotatable element — chart data points,
mermaid nodes, table cells, text selections inside markdown, and labelled
elements inside custom HTML. A small pin icon appears on hover; clicking opens a
comment popover. Comments are autosaved with the draft and returned in the final
result.

### result.annotations shape

```json
{
  "status": "submitted",
  "boardId": "b-k3x9q2",
  "answers": { "approach": "a" },
  "annotations": [
    {
      "id": "a1",
      "questionId": null,
      "blockId": "b2",
      "target": {
        "kind": "chart-element",
        "datasetIndex": 0,
        "index": 1,
        "label": "Feb",
        "value": 19
      },
      "text": "Feb spike was due to the onboarding push — not repeatable.",
      "createdAt": "2026-06-11T10:23:00.000Z"
    }
  ],
  "durationMs": 58000
}
```

### Annotation target kinds

| kind | what the user clicked |
|---|---|
| `chart-element` | a bar, point, or pie slice — includes `datasetIndex`, `index`, `label`, `value` |
| `mermaid-node` | a node in a diagram — includes `nodeId`, `text` |
| `table-cell` | a cell — includes `row` (0-based), `col` (column key), `value` |
| `text` | a text selection inside a markdown block — includes `quote`, `prefix`, `suffix` |
| `html-element` | a labelled element inside custom HTML (via `kit.js`) — includes `label`, optional `detail` |

### kit.js — annotatable custom HTML

Inside a custom HTML iframe, load `/kit.js` to make elements commentable:

```html
<script src="/kit.js"></script>
<script>
  // Make any element commentable — users see a hover outline + click to comment
  relayKit.commentable(document.getElementById('revenue-chart'), 'Revenue chart', 'Q1 2026');
  relayKit.commentable(document.getElementById('cta-button'), 'CTA button');
</script>
```

`relayKit.commentable(el, label, detail?)` — outlines `el` on hover; clicking
opens the annotation popover in the parent page anchored to that element.
`label` is shown in the annotation summary; `detail` is optional extra context.

## Commands

| Command | What it does |
|---|---|
| `rly ask [--file spec.json \| --file - \| -q "…"]` | Create board, open browser, block until submit, print answers JSON |
| `rly ask … --detach` | Don't block — print `{boardId,url}` immediately |
| `rly show --html-file viz.html` | Visualization-only board (acknowledge) |
| `rly wait <id> [--timeout s]` | Block until board finishes, print result |
| `rly result <id>` | Result/status now — includes **live autosaved draft** while open |
| `rly list [--json]` | Running boards |
| `rly open [id]` | Re-open the browser tab of a running board |
| `rly reopen <id>` | Serve a saved board again, **prefilled with saved answers** |
| `rly reuse <id> [--dump]` | Re-run a past board as a new one (blank) |
| `rly stop <id> \| --all` | Stop running board(s) — draft preserved |
| `rly history [--limit n] [--json]` | Saved boards |
| `rly spec <id>` | Print a saved spec (edit → `rly ask --file`) |
| `rly rm <id> \| --all` | Delete saved board(s) |
| `rly schema` | JSON Schema of the spec |
| `rly agent` | Full guide for AI agents |
| `rly skill [install\|path]` | Bundled universal agent skill |

Common flags: `--title --intro --html-file --height --submit-label
--timeout <sec> --port <n> --no-open --detach`.

Exit codes: `0` submitted/acknowledged · `2` timeout · `3` cancelled ·
`4` usage · `5` not found.

Storage: `~/.relay` (override with `RLY_HOME`). Boards bind to `127.0.0.1` only.

## Agent skill (Claude Code, Codex, …)

A universal [SKILL.md](skills/relay/SKILL.md) is bundled:

```sh
rly skill install                  # auto-installs into ~/.claude/skills and ~/.codex/skills
rly skill install --target claude  # or codex | both | <custom dir>
npx skills add khanglvm/relay      # via the skills installer, straight from this repo
```

`rly help` and `rly agent` also point agents at the skill, so an agent that
merely has the CLI installed can discover and self-install it.

## Development

```sh
npm test     # zero-dep smoke tests (spawns real servers, fake-submits)
```

## Migration from quest-board

relay was formerly published as `@khanglvm/quest-board` (CLI: `qbd`). That
package is deprecated; install `@khanglvm/relay` instead.

- Storage moved from `~/.quest-board` to `~/.relay`. Override with `RLY_HOME`.
  There is no automatic migration — copy boards manually if needed.
- The old `QUEST_BOARD_HOME` env var is still read as a fallback during the
  transition period.
- Legacy `"html"` / `"htmlFile"` / `"htmlHeight"` fields in specs continue to
  work and are silently normalised into an html block.

## License

[MIT](LICENSE) © Le Vu Minh Khang
