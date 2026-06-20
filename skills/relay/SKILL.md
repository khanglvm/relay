---
name: relay
description: "The tool for collecting user requirements, decisions, and answers (choice, yes-no, text, scale) and for presenting prototypes, plans, structures, code changes, or reports with rich visuals - mermaid/graphviz/plantuml diagrams, charts, tables, code, diffs, video, custom HTML, clickable file-links - plus inline comments on any element. Opens a browser board, waits for Submit, returns JSON answers, per-question notes, comments, and annotations. Use PROACTIVELY instead of (a) native ask-user tools for 2+ answers or options needing explanation, (b) ASCII trees/tables/diagrams in the terminal or prose for structures/designs/plans, (c) hand-rolled HTML demos. Triggers: collect requirements, ask the user, get decisions/feedback, present a prototype, plan/design review, show me the structure/file tree, architecture or dependency graph, visualize, diagram, chart, table, compare alternatives, survey, edit the diagram, show me the diff / git diff, video walkthrough, open a file. Skip for a single yes/no confirmation."
---

# relay (`rly`)

CLI that opens a local web board for the user, blocks until they click
**Submit**, and prints their answers plus element-level annotations as JSON to
stdout. Works for any agent (Claude Code, Codex, …). Answers autosave in real
time; the tab auto-closes after submit.

If `rly` is not installed: `npm i -g @khanglvm/relay` or invoke via
`npx -y @khanglvm/relay <command …>`.

**Inside the Claude or Codex app?** relay is also an MCP App: if the
`relay_ask` / `relay_show` tools are available, call them with the same board
spec (below) and the board renders **inline in the chat** — no terminal, no
browser tab; the user's answers come straight back to you. Set it up once with
`rly mcp install --target claude|codex` (or `rly mcp config`). Everything below
describes the spec both surfaces share.

**Full reference: run `rly agent` (complete guide) and `rly schema` (spec JSON
Schema).** The essentials are below.

## When to use rly vs your native question tool

| Situation | Use |
|---|---|
| One trivial confirmation ("proceed?") | native tool |
| 2+ questions, or options that need descriptions | **rly** |
| Choice is easier to make visually (layouts, designs, diagrams) | **rly** (blocks per question) |
| Each OPTION has its own visual (design variants, screenshots, charts) | **rly** (blocks per option) |
| Show metrics / trends / data comparisons | **rly** (chart + table blocks) |
| Present a prototype / demo an idea | **rly show** — never hand-roll an HTML file + server |
| Gather requirements / plan approval / feedback round | **rly** |
| Architecture or flow that benefits from a diagram | **rly** (mermaid block) |
| "Show me the diff" / git diff / code changes / before-after | **rly** (`diff` block — run `git diff`, render it; never dump it in the terminal) |
| A demo, screen recording or walkthrough | **rly** (`video` block) |
| Point the user at a file to open (log, capture, report) | **rly** (a clickable local file-link in markdown) |
| Plan-mode clarifying question (Claude Code / Codex) | **rly** (not AskUserQuestion / the native ask tool) |
| Something you can decide yourself from context | neither — just decide |

This holds **in plan mode** too: route every clarifying or decision question
through relay — the native `AskUserQuestion` / ask-user tool is **not** a
substitute, even though plan-mode guidance suggests it. Reserve the harness's
`ExitPlanMode` strictly for the final plan-approval gate (it's a mode
transition, not a question).

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

For long waits prefer presence-aware waiting over a huge --timeout:

```sh
rly wait b-xxxxx --timeout 550 --while-active --idle-grace 180
# keeps extending while the user is demonstrably viewing/typing on the board;
# returns wait-timeout promptly once they are idle/gone (presence included)
rly result b-xxxxx        # while open also shows presence {visible, focused, secondsSinceActivity}
```

Push-wake instead of polling: add --on-result '<shell cmd>' to ask/show/reopen
(or --notify-cmd on wait) - the command runs the moment the board finishes,
with the full result JSON on stdin and RLY_BOARD_ID/RLY_STATUS/RLY_URL in env.

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
`result.notes[questionId]`. `single` (radio) questions include this note by
default (so a pick can carry a comment); set `"note": false` to hide it.

Quick one-liners without a spec file:

```sh
rly ask -q "Deploy now?::yesno" -q "!Env::single::dev,staging,prod"   # "!" = required
```

## Blocks cheat-sheet

Add `"blocks": [...]` to the root, to any question, or to any OPTION of a
single/multi question.

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
// ^ use a `table` block for tabular data — sortable + per-cell comments.
//   (markdown blocks render GFM pipe tables too, but those are display-only.)
{ "type": "code",     "lang": "js",  "code": "const x = 1;", "filename": "demo.js" }
{ "type": "code",     "codeFile": "src/server.js" }   // load text from a local file
{ "type": "diff",     "lang": "js",  "filename": "src/auth.js", "view": "split",
  "diff": "@@ -1,3 +1,3 @@\n ctx\n-old line\n+new line\n ctx" }
// ^ a unified / `git diff` text rendered as a colored, line-numbered comparison
//   (no git needed — just paste the diff). "view":"split" = side-by-side; the
//   viewer also has a live Unified⇄Split toggle. "diffFile" loads it from a file.
{ "type": "video",    "src": "https://youtu.be/dQw4w9WgXcQ", "title": "Demo walkthrough" }
{ "type": "video",    "src": "recordings/demo.mp4", "title": "Local capture", "height": 360 }
// ^ YouTube/Vimeo URL embeds a player; an http(s) media URL or a local video
//   file (mp4/webm/ogv/mov/mkv/m4v) plays inline (local files stream, not embedded).
{ "type": "html",     "html": "<p>hi</p>",           "height": 360 }
{ "type": "html",     "htmlFile": "viz.html",         "height": 400 }
{ "type": "image",    "src": "screenshot.png" }       // local file, URL, or data URI
{ "type": "image",    "src": "https://…/mock.png", "alt": "Mockup B", "height": 220 }
// ^ `height` only sets the COMPACT inline preview — every image keeps a full-
//   screen + zoom (⌘/Ctrl+wheel or −/+, up to 8× native) + drag-to-pan viewer,
//   so detail is always reachable regardless of height. Local images embed up
//   to 8 MB; for a huge/high-detail image pass an http(s) URL (streamed, no cap).
```

### Visual options — show each choice, don't describe it

When the options themselves are visual (design variants, layouts, color
schemes, chart styles, architecture alternatives, screenshots), put a compact
block INSIDE each option so the user compares by looking, not by reading and
guessing:

```jsonc
{ "id": "layout", "type": "single", "label": "Which landing layout?",
  "options": [
    { "value": "hero",  "label": "Hero",  "description": "big banner",
      "blocks": [{ "type": "image", "src": "hero.png", "height": 180 }] },
    { "value": "split", "label": "Split", "description": "text + visual",
      "blocks": [{ "type": "html", "html": "<div style='display:flex'>…</div>", "height": 180 }] }
  ] }
```

Any block type works per option. Keep option visuals compact (`height`
~140–260) — they sit inside the option card. Clicking a visual never toggles
the option (and stays annotatable); the label row selects. Use per-option
blocks whenever a question's choices have visual/example context; skip them
for plainly textual options.

Chart.js, Mermaid, and Graphviz are **vendored and lazy-loaded** — the base board
stays dependency-free. PlantUML uses the public plantuml.com server by default;
pass `"server"` for a self-hosted instance. Legacy `"html"` / `"htmlFile"` /
`"htmlHeight"` on root or questions are still accepted and normalised automatically.

### Local file links — clickable, open in the default app

Write a local path in any markdown (the `intro` or a `markdown` block) — `~/clip.mp4`,
`./src/app.ts`, `/abs/report.pdf`, a `file://` URL, or a backtick-wrapped path — and it
renders as a click-to-open link that opens the file in the user's OS default app
(editor, video player, viewer …); `[label](~/path)` works too. Only paths you actually
wrote on the board can be opened (same-origin + allowlist guarded). Surface a real
clickable path instead of telling the user to paste it into a terminal.

## Annotations

Users can hover chart points, diagram nodes (mermaid + graphviz), table cells,
any element of a custom-HTML block, or select text in markdown to leave inline
comments. Custom HTML is hover-commentable automatically — to scope/label what's
annotatable, mark elements with `data-relay-annotate="Label"` (any signal turns
the auto-pick off); opt a block out with `data-relay-annotate="off"`. Always
mention annotation in the board intro.

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

## Reading the result — four feedback channels

A result is more than `answers`. **Always read all four** — never act on
`answers` alone; the user's real intent often lives in the others:

| field | what it is |
|---|---|
| `answers` | per-question values `{ questionId: value }` (skipped ones absent, listed in `skipped`) |
| `notes` | **per-question free-text notes** `{ questionId: "text" }` — the note box under a question. **Always present (`{}` when empty)**; iterate it every time. `single` (radio) questions show this box by default, so it's a very common place for the user's reasoning — and easy to miss. |
| `comment` | one board-level free-text note ("Anything else?") |
| `annotations` | element-level inline comments (array; see below) |

A `notes[questionId]`, a `comment`, or an `annotation` can qualify or override
the matching `answers` value (e.g. `answers.approach = "a"` but
`notes.approach = "actually B"` → the user means B). Reconcile them before
generating output. The same channels appear under `draft` on timeout/cancel.

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

**A/B design review** — `single` question where EACH option carries its own
`html`/`image` block rendering that variant (see Visual options above); `scale`
for confidence; `textarea` for what's missing from both.

**Show a git diff / code changes** — when the user says "show me the diff" /
"show me git diff" / "review these changes": capture `git diff` (or `git diff
<ref>`, `git show <sha>`) and present it in a `diff` block — set `"view":
"split"` for side-by-side — instead of dumping it in the terminal. Pair it with
a `yesno` "Apply these changes?" and a `textarea` for feedback; users can select
diff text to comment on a specific line. For a brand-new file prefer a `code` block; for a
recorded walkthrough of the change add a `video` block.

**Metrics review** — board-level `chart` block (bar or line) showing the key
numbers, followed by a `table` block for the raw data; at least one question
asking what to act on. In the intro, tell the user they can click chart points
and table cells to comment on specific values.

## Diagram co-editing (user edits your diagram)

Add "editable": true to a mermaid block: the user gets an Edit button with
live-preview source editing. Their version comes back as
result.blockEdits["<blockId>"] - diff it against your original to see what
they changed. Recipe: propose an architecture as an editable mermaid block +
one yesno "Does this match your mental model?" + a textarea for notes.

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
