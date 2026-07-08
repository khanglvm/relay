---
name: relay
description: "Collect user decisions & answers — choice, multi, yes-no, text, scale, rank, checklist, allocate, color — and present plans, data, code, git diffs/conflicts, designs, charts, tables, diagrams, images, PDFs, videos, HTML, palettes, typography, and file views on a browser or inline MCP board. Returns JSON answers/notes/comments/annotations/blockEdits on Submit. Use PROACTIVELY for 2+ questions, visual review, plans, metrics, tables, diffs, git pick/cherry-pick/conflict decisions, markdown files, or anything the terminal cannot render well. Use the most specific component instead of prose. Skip single yes/no."
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

**The core principle — match the surface to the content.** You run inside a
terminal, an IDE side-panel (VS Code / JetBrains / Cursor), or a plain-text chat.
None of those can actually render a markdown file, an image, a chart, a table, a
diagram, or a diff — they degrade to walls of monospace text, or can't show it at
all (a terminal can't draw a PNG). relay opens a real browser board that renders it
properly and reads the user's reply back as JSON. **So whenever what you're about to
output would read better than monospace — or is a file/visual the user should look
at — show it in a relay board instead of printing it.**

| Situation | Use |
|---|---|
| One trivial confirmation ("proceed?") | native tool |
| Show an image / screenshot / mockup / rendered output | **rly** (`image` block — the terminal can't display pixels) |
| 2+ questions, or options that need descriptions | **rly** |
| Choice is easier to make visually (layouts, designs, diagrams) | **rly** (blocks per question) |
| Each OPTION has its own visual (design variants, screenshots, charts) | **rly** (blocks per option) |
| Show metrics / trends / data comparisons | **rly** (chart + table blocks) |
| Present a prototype / demo an idea | **rly show** — never hand-roll an HTML file + server |
| Gather requirements / plan approval / feedback round | **rly** |
| Architecture or flow that benefits from a diagram | **rly** (mermaid block) |
| "Show me the diff" / git diff / code changes / before-after | **rly** (`diff` block — run `git diff`, render it; never dump it in the terminal) |
| Pick/cherry-pick commits or resolve conflict files | **rly git** (`rly git pick`, `rly git cherry-pick --code`, `rly git conflict`) |
| A demo, screen recording or walkthrough | **rly** (`video` block) |
| Point the user at a file to open (log, capture, report) | **rly** (a clickable local file-link in markdown) |
| Let the user read a markdown file (README, plan, report) | **rly view file.md** (or a `markdown` block with `mdFile`) — never dump the file into the terminal |
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

## The full toolbox — reach for the MOST SPECIFIC component

relay ships a purpose-built component for most kinds of content. **Before you
build a board, scan this list and pick the most specific component that fits — do
NOT fall back to a plain `markdown`/prose block (or the terminal) when a dedicated
one renders it better.** A KPI belongs in `kpi`, a before/after in `compare`, a
priority call in a `rank` question — not in paragraphs. Unsure which exists? Run
`rly agent` (full guide) and `rly schema` (every field).

**Blocks** — add under `"blocks": [...]` at the board, a question, or an option:

| Block | Reach for it when you have… |
|---|---|
| `table` | tabular data — sortable, per-cell comments; `rowsFile` (.csv/.json), `filterable`, `exportable` |
| `chart` | numbers / trends / comparisons (bar·line·pie·doughnut·radar·scatter) |
| `kpi` | headline metrics — big-number cards with ↑/↓/flat deltas (no chart needed) |
| `mermaid` | flows, sequences, state machines, architecture (set `editable:true` to co-edit) |
| `graphviz` | precise dependency / call graphs |
| `plantuml` | UML (sequence / class / component) |
| `code` | source / config / command output — highlighted, line numbers, hover-a-line to comment |
| `diff` | code changes — colored unified/split, multi-file (`rly diff` builds the whole board) |
| `git-conflict` | conflict-marker files — side-by-side ours/theirs/base with hunk choices; returns resolved content in `result.blockEdits[blockId]` |
| `image` | screenshots / mockups / renders — zoom+pan; `pins:true` → click-to-drop point comments |
| `compare` | a before/after pair — draggable divider |
| `video` | a demo / screen recording / walkthrough |
| `pdf` | a quote / report / exported document that should render inline |
| `palette` | color schemes — swatch cards, hover-hex, click-to-copy |
| `typography` | type choices — specimens at given size/weight/font |
| `html` | anything bespoke — custom widgets, pixel-perfect mockups |
| `markdown` | prose / context ONLY (not data, metrics, or visuals — those have their own block) |

Any block also takes `"ref":"name"` → a question can link to it with
`[label](#ref:name)` and it opens **in a full-screen modal**, so the user views the
data without scrolling back up.

**Question types** — pick by the shape of the answer you need:

| Type | Reach for it when you need… | Answer JSON |
|---|---|---|
| `single` | one choice (radio; "Other" + a note are on by default) | `"value"` |
| `multi` | several choices | `["a","b"]` |
| `rank` | a **priority order** over options (roadmap, triage) | `["b","a","c"]` |
| `allocate` | a **budget split** across options (tradeoffs, %, points) | `{opt: number}` |
| `checklist` | **per-item sign-off / QA** (Pass·Fail·N·A, or custom) | `{opt: status}` |
| `scale` | a rating on a 1–N scale | number |
| `yesno` | a binary decision | `"yes"`/`"no"` |
| `color` | a color pick — native picker + presets, or a `palette` of labeled swatch cards (each commentable); any CSS color system | color string |
| `text` / `textarea` | short / long free text | string |

**By who you're serving** (don't make a business user read a wall of prose):

- **Business / PM / exec** → `kpi` + `chart` + `table` for the numbers; `rank` to
  prioritize, `allocate` for tradeoffs, `checklist` for sign-off, `scale` for confidence.
- **Designer** → `image` (+`pins` for point feedback), `compare` (before/after),
  `palette`, `typography`; put a visual INSIDE each option so they pick by looking.
- **Engineer** → `diff` (`rly diff`), `code` (line-comments), `mermaid`/`graphviz`
  for architecture, editable mermaid to co-design.
- **Data / analyst** → `table` with `rowsFile`/`filterable`/`exportable`
  (`rly view data.csv`), `chart` for the shape of it.

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

**Codex browser-board pattern.** Codex does not have a normal, user-facing
"wake this agent turn from a browser submit" command. If the Codex turn stops
waiting, a later board submit can leave the user needing to prompt manually.
So in Codex, keep the waiter in the foreground until the user submits:

```sh
rly ask --file spec.json --detach
rly wait b-xxxxx --timeout 1800 --while-active --idle-grace 300
```

If `rly wait` exits with `wait-timeout`, immediately run `rly result <boardId>`.
If it is still open and the user may continue, run `rly wait` again. Do not use
`--on-result` as the primary Codex return path; it can write files or hit
webhooks, but normal Codex CLI sessions do not expose a portable inbound API
that wakes the current agent turn.

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

Types: `single`, `multi`, `yesno`, `text`, `textarea`, `scale`, `color`
(native picker + hex; optional `"presets":["#…"]` or a `"palette"` of labeled,
commentable swatch cards — any CSS color system), `rank`, `checklist`, `allocate`.
Users may submit with unanswered questions (returned in `skipped`) unless
`"allowPartial": false` or per-question `"required": true`.

```jsonc
{ "id": "brand", "type": "color", "label": "Pick a brand color",
  "palette": [{ "value": "#c2674b", "label": "Terracotta" }, { "value": "rgb(77,138,102)", "label": "Forest" }, "rebeccapurple"] }
// clicking a swatch = the answer; hover a swatch to comment on that specific color.
```

The optional per-question note box (`result.notes[id]`) defaults ON for the
**decision types** — `single`, `rank`, `checklist`, `allocate` — so the user can
qualify a pick; `"note": false` hides it, `"note": true` adds it to other types.

`rank` — the user drags (or uses ↑/↓) to order the `options` by priority; the
answer is the **ordered array of option values**, highest first. Needs ≥2
options; always returns a value (an untouched rank submits the authored order),
so it's never `skipped`. Use for roadmap/feature prioritization instead of a
single pick. Options take `description` and per-option `blocks` like single/multi.

```json
{ "id": "roadmap", "type": "rank", "label": "Order these by priority",
  "options": [{ "value": "diff", "label": "rly diff", "description": "git diff → board" }, "rank type", "image pins"] }
```

`checklist` — each `option` gets a per-item status (default **Pass / Fail / N·A**;
override with `"statuses"`). Answer is a map `{optionValue: statusValue}`. For QA
passes and sign-off gates.

```json
{ "id": "qa", "type": "checklist", "label": "Release sign-off", "options": ["login","search","checkout"] }
```

`allocate` — the user distributes a budget (`"total"`, default 100) across the
`options` with sliders + a live running-total bar. Answer is a map
`{optionValue: number}`. Captures intensity/tradeoffs, not just a pick.

```json
{ "id": "spend", "type": "allocate", "label": "Split the quarter", "total": 100, "unit": "pts",
  "options": ["features","tech debt","infra"] }
```

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
{ "type": "markdown", "mdFile": "README.md" }   // render a local .md file (no lib)
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
{ "type": "table",    "rowsFile": "data.csv", "filterable": true, "exportable": true }
// ^ load rows from a local .csv/.tsv/.json; filterable = live filter box,
//   exportable = CSV download. (`rly view data.csv` does all of this for you.)
{ "type": "kpi",      "title": "This quarter", "items": [
  { "label": "Revenue", "value": "$1.2M", "delta": "12%", "dir": "up" },
  { "label": "Churn",   "value": "2.1%",  "delta": "0.4pp", "dir": "down", "sub": "lower=better" } ] }
// ^ big-number metric cards with up/down/flat-tinted deltas — no chart needed.
{ "type": "typography", "font": "Georgia, serif", "specimens": [
  { "label": "Display", "size": "40px", "weight": "600", "text": "Ship faster" },
  { "label": "Body",    "size": "16px", "text": "The quick brown fox…" } ] }
// ^ type specimens at given size/weight/font — react to type like a palette.
{ "type": "compare",  "before": "v1.png", "after": "v2.png", "beforeLabel": "Old", "afterLabel": "New" }
// ^ before/after images with a draggable divider (redesign / before-after fix).
{ "type": "code",     "lang": "js",  "code": "const x = 1;", "filename": "demo.js" }
{ "type": "code",     "codeFile": "src/server.js" }   // load text from a local file
{ "type": "diff",     "lang": "js",  "filename": "src/auth.js", "view": "split",
  "diff": "@@ -1,3 +1,3 @@\n ctx\n-old line\n+new line\n ctx" }
// ^ a unified / `git diff` text rendered as a colored, line-numbered comparison
//   (no git needed — just paste the diff). "view":"split" = side-by-side; the
//   viewer also has a live Unified⇄Split toggle. "diffFile" loads it from a file.
{ "type": "git-conflict", "file": "src/app.js" }
{ "type": "git-conflict", "filename": "app.js", "content": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n" }
// ^ conflict markers rendered as a resolver: choose ours/theirs/both/custom per
//   hunk. User choices + full resolved content return in result.blockEdits[blockId].
{ "type": "video",    "src": "https://youtu.be/dQw4w9WgXcQ", "title": "Demo walkthrough" }
{ "type": "video",    "src": "recordings/demo.mp4", "title": "Local capture", "height": 360 }
// ^ YouTube/Vimeo URL embeds a player; an http(s) media URL or a local video
//   file (mp4/webm/ogv/mov/mkv/m4v) plays inline (local files stream, not embedded).
{ "type": "pdf",      "src": "reports/quote.pdf", "title": "Quote", "height": 900 }
// ^ local .pdf files and http(s) PDF URLs render inline; local files stream, not embedded.
{ "type": "html",     "html": "<p>hi</p>",           "height": 360 }
{ "type": "html",     "htmlFile": "viz.html",         "height": 400 }
{ "type": "image",    "src": "screenshot.png" }       // local file, URL, or data URI
{ "type": "image",    "src": "https://…/mock.png", "alt": "Mockup B", "height": 220 }
// ^ `height` only sets the COMPACT inline preview — every image keeps a full-
//   screen + zoom (⌘/Ctrl+wheel or −/+, up to 8× native) + drag-to-pan viewer,
//   so detail is always reachable regardless of height. Local images embed up
//   to 8 MB; for a huge/high-detail image pass an http(s) URL (streamed, no cap).
{ "type": "palette",  "palettes": [{ "name":"Brand", "colors":["#3B8EA5","#6DBAD1","#1E6278"], "featured": true }] }
// ^ color palettes as swatch cards: hover=hex, click=copy. Shorthand {"type":"palette","colors":[…]}; pair with a `color` question.
```

### View a markdown file quickly

To let the user *read* a `.md` file (README, a plan you wrote, a generated
report), don't paste it into the terminal — render it:

```sh
rly view PLAN.md                 # one file → board titled "PLAN.md", "Done" button
rly view README.md CHANGELOG.md  # several files, each with a filename heading
rly view docs/spec.md --detach   # detached like ask/show; then `rly wait <id>`
```

`rly view` is sugar over `rly show` with `markdown` blocks (`mdFile`). The
built-in renderer is library-free and covers headings, lists, `**/_` emphasis,
code, quotes, GFM pipe tables, remote/data images, and click-to-open local
links. To mix a file into a larger board, use a `markdown` block with
`"mdFile"` alongside questions or other blocks.

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

### Connect a question to a visual shown above (reference modal)

When a board has visuals up top and questions below, the user loses the link
between them. Give any block a stable `"ref"` name, then reference it from a
markdown link — clicking it opens that visual in a full-screen modal **in place**,
no scrolling:

```jsonc
{ "type": "chart", "ref": "velocity", "kind": "line", "labels": [...], "series": [...] }
// then in the intro, a markdown block, or a question's own markdown block:
{ "type": "markdown", "md": "Decide from the [📈 Velocity](#ref:velocity) chart above." }
```

`[label](#ref:name)` opens the block named `name`; `[label](#block:b2)` opens by
id. Use it so every question that depends on data points right at it.

### Pin comments on a mockup (image coordinates)

Add `"pins": true` to an `image` block: the user clicks any point on the image to
drop a comment anchored to that exact spot (Figma-style), returned as an
`{kind:"image-point", x, y}` annotation. Ideal for design/mockup review.

### Show a git diff in one step — `rly diff`

`rly diff [git args…]` runs `git diff` and opens the result as a diff board —
sugar for the "show me the diff" flow. Git args/flags pass straight through; a
multi-file diff renders with a per-file header + a jump bar.

```sh
rly diff --detach              # working-tree diff
rly diff --staged --split      # staged changes, side-by-side
rly diff HEAD~1 HEAD -- src/   # a commit's diff, scoped to a path
```

`code` blocks also support **line-anchored comments**: hover a line number to
comment on that exact line (returned as `{kind:"code-line", line}`).

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
  "target": { "kind": "chart-element | mermaid-node | graphviz-node | table-cell | text | html-element | image | image-point | code-line", "..." },
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

**Don't let your shell truncate the result.** A board with several annotations
prints a large JSON blob, and most agent shell tools cap stdout — so you silently
get only the first few annotations and miss the rest. Two rules:

- **Never pipe `rly wait`/`rly result` through `head`/`tail`/`sed`** (or any
  output cap). That's exactly how annotations get dropped.
- The full result is **always written to a file**, surfaced as the FIRST field
  of the output: `"resultFile": "~/.relay/boards/<id>.result.json"`. If the
  output looks cut off (or to be safe on any board with annotations), **read
  that file with your file tool** instead of trusting stdout — it's the complete,
  untruncated payload.

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
`rly rescue <id>` (re-serve a dropped board on its ORIGINAL port) ·
`rly list` / `rly open` / `rly stop <id>` · `rly rm <id>`.
Multiple boards can run concurrently.

### Continue a board — reconnect, NEVER recreate it

When the user refers to a board that already exists — a URL/port ("the board on
`127.0.0.1:59926`"), "the board from yesterday", "reopen it", "it disconnected"
— do **NOT** run `rly ask`/`rly show`. A fresh board lands on a **new port**,
**strands the user's open tab** on the dead one, and **loses their comments**.
Find the real board and reconnect it:

1. **Identify it** — `rly list` (running) and `rly history` (saved) print each
   board's id, title, and url/port. Match by what the user said (port, title).
2. **Tab still open but "connection lost"** (server died / machine slept) →
   `rly rescue <id>`. Re-serves on the SAME port so that tab reconnects on its
   own and re-flushes any comments it buffered — no new tab, no lost input.
3. **Want a fresh tab** with prior answers prefilled → `rly reopen <id>` (also
   reuses the board's last port, so an old tab still reconnects).
4. `rly reuse <id>` is the ONLY "make a new board from this one" path — use it
   solely for a deliberately blank re-run, never to "continue" or "reconnect".

Rule of thumb: **an existing board is reconnected (`rescue`/`reopen`), never
re-asked.** Only call `rly ask`/`rly show` for a genuinely new question.

### Live mutation — `rly update`

Push a new spec to a running board. The page reloads and prefills answers from the
autosaved draft — answers survive, the user sees a toast "Board updated by the agent".

```sh
rly update <boardId> --file new-spec.json        # replace spec
rly update <boardId> --title T --intro I         # patch fields
rly update <boardId> -q "!Priority::single::p0,p1"  # append question
```

Batch your changes into one call — the page reloads for the user on each update.
