---
name: relay
description: Ask the user interactive questions in a browser board (single/multi choice, yes-no, free text, scale) and/or present rich content blocks (markdown, mermaid diagrams, graphviz, plantuml, uml, charts, interactive tables, code, sandboxed HTML), then wait for Submit and read JSON answers plus element-level annotations. PROACTIVELY use whenever you would otherwise (a) call a native ask-user/question tool with 2+ questions or options that need explanation, (b) describe a UI/design/plan/architecture in prose that a visual would show better — draft diagrams (mermaid, graphviz, plantuml), charts, and interactive tables as native blocks, or (c) hand-roll an HTML file or local server to demo an idea - relay replaces all three. Triggers - clarify requirements before ambiguous work, choose between approaches, plan approval, design/UX feedback, mockup or prototype review, compare alternatives, survey, metrics review, "ask the user", "show the user", "which do you prefer", "get feedback", diagram, chart, data table, architecture overview, metrics, dependency graph, sequence diagram, class diagram, uml, graphviz, plantuml. Skip only for a single trivial yes/no confirmation.
---

# relay (`rly`)

CLI that opens a local web board for the user, blocks until they click
**Submit**, and prints their answers plus element-level annotations as JSON to
stdout. Works for any agent (Claude Code, Codex, …). Answers autosave in real
time; the tab auto-closes after submit.

If `rly` is not installed: `npm i -g @khanglvm/relay` or invoke via
`npx -y @khanglvm/relay <command …>`.

**Full reference: run `rly agent` (complete guide) and `rly schema` (spec JSON
Schema).** The essentials are below.

## When to use rly vs your native question tool

| Situation | Use |
|---|---|
| One trivial confirmation ("proceed?") | native tool |
| 2+ questions, or options that need descriptions | **rly** |
| Choice is easier to make visually (layouts, designs, diagrams) | **rly** (blocks per question) |
| Show metrics / trends / data comparisons | **rly** (chart + table blocks) |
| Present a prototype / demo an idea | **rly show** — never hand-roll an HTML file + server |
| Gather requirements / plan approval / feedback round | **rly** |
| Architecture or flow that benefits from a diagram | **rly** (mermaid block) |
| Something you can decide yourself from context | neither — just decide |

Once the user has answered one board in a session, prefer boards for later
question rounds too — they've shown they engage with them. Batch related
questions into ONE board rather than opening several in a row.

## Choose a pattern

**DEFAULT: detached.** Most agent shell tools kill long-running commands, and a
blocking `rly ask` that gets killed cancels the board. Always prefer:

```sh
rly ask --file spec.json --detach    # returns {"boardId":"b-…","url":…} immediately
rly wait b-xxxxx --timeout 550       # blocks until submit, prints result JSON
                                     # (on exit 2 "wait-timeout" just run wait again)
rly result b-xxxxx                   # non-blocking peek (includes live draft)
```

Blocking mode (`rly ask --file spec.json --timeout 1800`, no --detach) is fine
ONLY when your shell tool has no execution time limit.

Useful flags: `--no-open` (don't auto-open the browser — for tests/CI; real
users need the tab, so omit it normally) · `--title` · `--timeout <sec>`.

Exit codes: 0 submitted · 2 timeout · 3 cancelled · 5 not found. On
timeout/cancel the result still contains the autosaved `draft` of partial
answers and any annotations written so far.

## Minimal spec

```json
{
  "title": "Pick the approach",
  "intro": "Context for the user. Hover chart points or select text to leave comments.",
  "questions": [
    { "id": "approach", "type": "single", "label": "Which one?", "required": true,
      "options": [{ "value": "a", "label": "A", "description": "fast" }, "B"], "other": true },
    { "id": "parts", "type": "multi", "label": "Include?", "options": ["api", "ui"], "note": true },
    { "id": "ship", "type": "yesno", "label": "Ship now?" },
    { "id": "why", "type": "textarea", "label": "Reasoning?" },
    { "id": "conf", "type": "scale", "label": "Confidence", "min": 1, "max": 5,
      "minLabel": "low", "maxLabel": "high" }
  ]
}
```

Types: `single`, `multi`, `yesno`, `text`, `textarea`, `scale`. Users may
submit with unanswered questions (returned in `skipped`) unless
`"allowPartial": false` or per-question `"required": true`.

Set `"note": true` on a question to add a small optional free-text field under
it — use when the user may want to qualify their choice. Returned as
`result.notes[questionId]`.

Quick one-liners without a spec file:

```sh
rly ask -q "Deploy now?::yesno" -q "!Env::single::dev,staging,prod"   # "!" = required
```

## Blocks cheat-sheet

Add `"blocks": [...]` to the root or to any question.

```jsonc
{ "type": "markdown", "md": "## Section\n**prose**" }
{ "type": "mermaid",  "code": "graph TD; A-->B",     "height": 400 }
{ "type": "graphviz", "dot": "digraph { a -> b }",   "height": 300 }
{ "type": "plantuml", "code": "@startuml\nA->B\n@enduml", "height": 300 }
{ "type": "plantuml", "code": "...", "server": "https://plantuml.example.com" }
{ "type": "chart",    "kind": "bar",  "title": "...",
  "labels": ["Jan","Feb"], "series": [{"label":"x","data":[1,2]}], "height": 320 }
{ "type": "chart",    "config": { /* full Chart.js v4 config */ }, "height": 300 }
{ "type": "table",    "columns": ["A","B"], "rows": [["x","y"]], "sortable": true }
{ "type": "code",     "lang": "js",  "code": "const x = 1;" }
{ "type": "html",     "html": "<p>hi</p>",           "height": 360 }
{ "type": "html",     "htmlFile": "viz.html",         "height": 400 }
```

Chart.js, Mermaid, and Graphviz are **vendored and lazy-loaded** — the base board
stays dependency-free. PlantUML uses the public plantuml.com server by default;
pass `"server"` for a self-hosted instance. Legacy `"html"` / `"htmlFile"` /
`"htmlHeight"` on root or questions are still accepted and normalised automatically.

## Annotations

Users can hover chart points, diagram nodes (mermaid + graphviz), table cells, or
select text in markdown to leave inline comments. Always mention this in the board intro.

`result.annotations` is an array of:

```json
{
  "id": "a1",
  "questionId": "q-id or null",
  "blockId": "b2",
  "target": { "kind": "chart-element | mermaid-node | graphviz-node | table-cell | text | html-element | image", "..." },
  "text": "user comment",
  "author": "user",
  "createdAt": "ISO",
  "replies": [{ "author": "agent", "text": "acknowledged", "createdAt": "ISO" }]
}
```

Read annotations before generating your next output — a comment on a specific
data point often carries sharper signal than a checkbox answer.

### Reply to annotations (agent → user conversation)

```sh
# 1. Read result from a previous board
rly result <id>   # or rly wait <id>

# 2. Build replies file
# replies.json: [{"annotationId":"a1","text":"Good catch — fixed."}]

# 3. Reopen as a conversation
rly reopen <id> --replies replies.json
```

Unknown annotation IDs cause an error listing valid IDs (exit 4).

## Recipes

**Plan approval** — board-level `markdown` block rendering the plan, one `yesno`
"Approve this plan?", one `multi` "Which parts should change?" (`"note": true`),
one `textarea` for concerns.

**Requirements gathering** — one board with: `single` for the core approach
(options with `description`s + `"other": true`), `multi` for scope, `scale` for
urgency, `textarea` for constraints.

**A/B design review** — `single` question with a `blocks` array containing an
`html` block showing both options side by side; options `["A", "B"]`; `scale`
for confidence; `textarea` for what's missing from both.

**Metrics review** — board-level `chart` block (bar or line) showing the key
numbers, followed by a `table` block for the raw data; at least one question
asking what to act on. In the intro, tell the user they can click chart points
and table cells to comment on specific values.

## Reuse & management

`rly history` (saved boards) · `rly spec <id>` (print spec to modify) ·
`rly reuse <id>` (re-run blank) · `rly reopen <id>` (re-open with saved
answers prefilled) · `rly reopen <id> --replies file.json` (add agent replies) ·
`rly list` / `rly open` / `rly stop <id>` · `rly rm <id>`.
Multiple boards can run concurrently.

### Live mutation — `rly update`

Push a new spec to a running board. The page reloads and prefills answers from the
autosaved draft — answers survive, the user sees a toast "Board updated by the agent".

```sh
rly update <boardId> --file new-spec.json        # replace spec
rly update <boardId> --title T --intro I         # patch fields
rly update <boardId> -q "!Priority::single::p0,p1"  # append question
```

Batch your changes into one call — the page reloads for the user on each update.
