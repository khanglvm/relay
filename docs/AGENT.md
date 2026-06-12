# relay (`rly`) — agent guide

Purpose: ask the human structured questions in a browser tab and/or show them
rich content blocks (markdown, charts, diagrams, tables, code, custom HTML),
then **wait for them to click Submit** and read the answers as JSON from stdout.
No "type 'done' in the terminal", no hand-rolled HTML+server.

**Tell the user** at the start of your intro text that they can hover chart
points, diagram nodes, and table cells to leave comments, and select text in
markdown blocks to annotate — their comments come back in `result.annotations`
alongside their answers. Treat annotations as first-class feedback.

Everything machine-relevant is on **stdout as JSON**; human-facing logs go to
stderr. Exit codes: `0` submitted/acknowledged · `2` timeout · `3` cancelled ·
`4` usage error · `5` not found.

## Two execution patterns

**1. Blocking (simplest).** The command blocks until the user submits, then
prints the result JSON:

```sh
rly ask --file spec.json --timeout 1800
```

**2. Detached (recommended when your shell tool has an execution time limit).**
Returns immediately with the board URL; collect later:

```sh
rly ask --file spec.json --detach     # → {"status":"open","boardId":"b-…","url":"…"}
rly wait b-xxxxx --timeout 3500       # blocks until submit, prints result JSON
rly result b-xxxxx                    # non-blocking peek; while open it includes
                                      # the live autosaved draft of the user's answers
```

Answers **autosave in real time** as the user fills the board — a page reload
restores them, and a draft survives timeouts/cancellation (included in those
results), so partial input is never lost.

## Creating boards

From a JSON spec file (`--file spec.json`), stdin (`--file -`), or quick
inline questions:

```sh
rly ask -q "Deploy to prod now?::yesno" -q "!Environment::single::dev,staging,prod"
#         label::type::comma,separated,options          leading "!" = required
```

Visualization-only (no questions; submit button reads "Acknowledge"):

```sh
rly show --html-file prototype.html --title "Dashboard concept" --height 600
```

## Board spec (JSON)

```jsonc
{
  "title": "Feature direction",
  "intro": "Pick what we build next. Lines are preserved.",
  "blocks": [
    { "type": "markdown", "md": "## Background\nContext here." }
  ],
  "allowPartial": true,             // default true: user may submit with gaps -> "skipped"
  "note": true,                     // default true: optional free-text box -> result "comment"
  "autoClose": true,                // default true: tab tries to close itself after submit
  "submitLabel": "Submit",
  "questions": [
    { "id": "approach", "type": "single", "label": "Which approach?", "required": true,
      "options": [
        { "value": "a", "label": "Approach A", "description": "fast, less flexible" },
        "Approach B"                                    // plain strings work too
      ],
      "other": true },                                  // adds a free-text "Other" option
    { "id": "scope", "type": "multi", "label": "Include which parts?", "options": ["api", "ui", "docs"],
      "note": true },                                   // optional free-text under the question
                                                        //   → returned as result.notes.scope
    { "id": "ship", "type": "yesno", "label": "Ship this week?" },
    { "id": "name", "type": "text", "label": "Project codename?", "placeholder": "e.g. falcon" },
    { "id": "notes", "type": "textarea", "label": "Any constraints?" },
    { "id": "confidence", "type": "scale", "label": "Confidence?", "min": 1, "max": 5,
      "minLabel": "low", "maxLabel": "high" },
    { "id": "layout", "type": "single", "label": "Which layout?", "options": ["left", "right"],
      "blocks": [{ "type": "markdown", "md": "Compare the two options above." }] },
    { "id": "variant", "type": "single", "label": "Which design variant?",
      "options": [                                      // blocks INSIDE an option = visual choice
        { "value": "hero", "label": "Hero", "blocks": [
          { "type": "image", "src": "hero-mock.png", "height": 180 } ] },
        { "value": "split", "label": "Split", "blocks": [
          { "type": "html", "html": "<div style='display:flex'>…</div>", "height": 180 } ] }
      ] }
  ]
}
```

`rly schema` prints the full JSON Schema.

### Question types → answer shapes

| type       | answer value in result              |
|------------|-------------------------------------|
| `single`   | `"value"` (Other → its text verbatim) |
| `multi`    | `["a","b"]` (Other text appended)   |
| `yesno`    | `"yes"` \| `"no"`                   |
| `text`     | `"string"`                          |
| `textarea` | `"string"`                          |
| `scale`    | number (`min`…`max`, default 1–5)   |

Aliases accepted: radio/choice/select→single, checkbox→multi,
boolean/bool/yn→yesno, input→text, longtext→textarea, rating/likert→scale.

### Result JSON (stdout)

```json
{
  "status": "submitted",
  "boardId": "b-xxxxx",
  "answers": { "approach": "a", "scope": ["api", "ui"], "ship": "yes", "confidence": 4 },
  "skipped": ["name"],
  "comment": "free-text note from the user",
  "notes": { "scope": "docs can wait until the API settles" },
  "annotations": [
    {
      "id": "a1",
      "questionId": null,
      "blockId": "b2",
      "target": { "kind": "chart-element", "datasetIndex": 0, "index": 1, "label": "Feb", "value": 19 },
      "text": "Feb spike was from the onboarding push — not repeatable.",
      "createdAt": "2026-06-11T10:23:00.000Z"
    }
  ],
  "finishedAt": "2026-06-11T03:00:00.000Z",
  "durationMs": 42000
}
```

Unanswered questions are absent from `answers` and listed in `skipped`.
Questions with `"note": true` show a small optional free-text field; non-empty
notes come back in `notes` keyed by question id. On `timeout`/`cancelled`, a
`draft` field carries the autosaved partial answers and any annotations written
so far.

## Blocks

Every visual block (mermaid / graphviz / plantuml / chart / table / html /
image) automatically gets a full-screen button (4-corner expand icon, Esc
closes); diagrams and images also zoom with cmd/ctrl+wheel. Don't shrink large
diagrams to make them fit — the user can always expand and zoom; annotations
keep working at any zoom and inside full-screen.

Blocks can appear at the board level (`"blocks": [...]` on the root object),
per question (`"blocks": [...]` on a question object), or per OPTION of a
single/multi question (`"blocks": [...]` on an option object). Heights clamp
to 100–2400 px.

### Option-level visuals — show each choice

When a question's options are inherently visual — design variants, layouts,
screenshots, palette/chart-style alternatives, competing architectures — give
EACH option a compact block so the user picks by looking instead of reading a
description and guessing:

```jsonc
{ "id": "scheme", "type": "single", "label": "Color scheme?",
  "options": [
    { "value": "warm", "label": "Warm", "description": "terracotta accent",
      "blocks": [{ "type": "html", "html": "<div style='background:#C2674B;height:100%'></div>", "height": 140 }] },
    { "value": "cool", "label": "Cool", "description": "slate accent",
      "blocks": [{ "type": "image", "src": "cool-preview.png", "height": 140 }] }
  ] }
```

Rules of thumb:

- Any block type works inside an option (image, html, chart, mermaid,
  graphviz, plantuml, table, code, markdown).
- Keep option visuals **compact** — `"height"` ~140–260. They render inside the
  option card, under the label/description.
- Interacting with the visual (zoom, annotate, chart hover) never toggles the
  option; the label row is what selects. Option visuals stay fully annotatable.
- Use this whenever the choice has visual/example context; skip it for plainly
  textual options. It beats one big side-by-side comparison block because the
  selected visual is unambiguous.

### All block shapes

```jsonc
// Markdown — built-in mini renderer, no library
{ "type": "markdown", "md": "## Heading\nAny **CommonMark** prose." }

// Mermaid diagram — vendored, lazy-loaded; natural height, max 1200 px + scroll
{ "type": "mermaid", "code": "graph TD; A-->B; B-->C", "height": 400 }

// Graphviz diagram — vendored viz-standalone.js (Graphviz-WASM), fully offline
// Nodes (g.node) and edges (g.edge) are individually annotatable
{ "type": "graphviz", "dot": "digraph { a -> b -> c }", "height": 300 }

// PlantUML diagram — rendered via a PlantUML server (default: plantuml.com)
// Source is deflate-encoded client-side; only an img URL is sent to the server.
// Use "server" for a self-hosted instance to avoid leaking sensitive diagrams.
{ "type": "plantuml", "code": "@startuml\nA -> B: request\n@enduml", "height": 340 }
{ "type": "plantuml", "code": "...", "server": "https://plantuml.example.com", "height": 300 }

// Chart — shorthand (lazy-loads vendored Chart.js; default height 320)
{
  "type": "chart",
  "kind": "bar",             // bar | line | pie | doughnut | radar | scatter
  "title": "Velocity",
  "labels": ["Jan", "Feb", "Mar"],
  "series": [
    { "label": "Shipped", "data": [12, 19, 14], "color": "#4d8a66" },
    { "label": "Planned", "data": [15, 15, 15] }
  ],
  "height": 320
}

// Chart — full Chart.js v4 config
{
  "type": "chart",
  "config": {
    "type": "bar",
    "data": { "labels": ["A", "B"], "datasets": [{ "label": "x", "data": [1, 2] }] },
    "options": { "plugins": { "legend": { "display": false } } }
  },
  "height": 280
}

// Table — sortable, annotatable cells
{
  "type": "table",
  "columns": [
    { "key": "name", "label": "Name" },
    { "key": "status", "label": "Status", "align": "center" },
    { "key": "score",  "label": "Score",  "align": "right" }
  ],
  "rows": [
    { "name": "Alpha", "status": "done", "score": 92 },
    { "name": "Beta",  "status": "wip",  "score": 71 }
  ],
  "sortable": true
}
// columns may also be plain string array; rows may be parallel arrays [[val,val],...]

// Code — styled pre/code block
{ "type": "code", "lang": "js", "code": "const x = 1 + 2;" }

// HTML — sandboxed iframe; default height 360
{ "type": "html", "html": "<h1>Hello</h1>", "height": 360 }
{ "type": "html", "htmlFile": "viz.html",   "height": 400 }

// Image — local file path (embedded at spec time, works offline), http(s) URL,
// or data URI. "height" caps the displayed height; zoom/full-screen included.
{ "type": "image", "src": "screenshots/variant-a.png", "alt": "Variant A", "height": 220 }
{ "type": "image", "src": "https://example.com/mock.png" }
```

### When to use which block

| Block | Best for |
|---|---|
| `mermaid` | flows, state machines, architecture overviews, sequence diagrams |
| `graphviz` | precise dependency graphs, call graphs, state machines when Mermaid's auto-layout falls short; individually annotatable nodes and edges |
| `plantuml` | UML diagrams (sequence, class, component) via server rendering; great for detailed interface contracts |
| `chart` | numbers, trends, comparisons, metrics |
| `table` | structured comparisons, option matrices, data grids |
| `markdown` | prose context, background, instructions, section headings |
| `code` | code snippets, config examples, command output |
| `image` | screenshots, mockup exports, photos — local files embed and work offline |
| `html` | anything else — pixel-perfect mockups, custom widgets, embeds |

### Height rules

- `markdown`, `code`: natural flow (no fixed height).
- `mermaid`: natural flow, max-height 1200 px with internal scroll. Override with `"height"`.
- `chart`: default 320 px. Override with `"height"`.
- `html`: default 360 px. Override with `"height"`.
- `image`: natural size (never upscaled), max-height 1200 px with scroll. `"height"` caps it.
- `table`: natural flow.
- All heights clamp to 100–2400 px.
- Inside OPTION cards, always set a compact `"height"` (~140–260) on
  chart/html/image blocks — the per-scope defaults are tuned for full-width use.

## Custom HTML sizing contract

- Rendered in a **sandboxed iframe** (`allow-scripts allow-forms allow-popups
  allow-modals`, **no** same-origin/parent access). Ship a self-contained HTML
  document: inline your CSS/JS; external CDN resources do load, but offline-safe
  inline is better.
- **Width: always 100% of the content column — up to ~820 px on desktop, as
  narrow as ~300 px on phones. Design responsively; don't assume fixed width.**
- **Height: fixed per block via `height` (px, 100–2400). Default 360.**
  Content taller than that scrolls inside the iframe.
- **Fragments** (no `<html>` tag) are auto-wrapped in a minimal document whose
  background/text match the user's current theme. **Full documents** are served
  verbatim and receive a `?theme=light|dark` query param on theme toggle.

### kit.js — make iframe elements annotatable

Load `/kit.js` inside your custom HTML iframe to let users comment on specific
elements:

```html
<script src="/kit.js"></script>
<script>
  relayKit.commentable(document.getElementById('chart'), 'Revenue chart', 'Q1 2026');
  relayKit.commentable(document.getElementById('hero-cta'), 'CTA button');
</script>
```

`relayKit.commentable(el, label, detail?)` — outlines `el` on hover; a click
opens the annotation popover in the parent page anchored to the element.
Annotations come back in `result.annotations` with `target.kind = "html-element"`,
`target.label`, and (if provided) `target.detail`.

## Annotations

Users can comment on any annotatable element. Tell them about it in your board
intro. Annotations are autosaved with the draft and returned in the final result.

### result.annotations shape

```json
"annotations": [
  {
    "id": "a1",
    "questionId": "q-id or null for board-level",
    "blockId": "b2",
    "target": { "kind": "chart-element", "datasetIndex": 0, "index": 1, "label": "Feb", "value": 19 },
    "text": "Feb spike was from the onboarding push — not repeatable.",
    "author": "user",
    "createdAt": "2026-06-11T10:23:00.000Z",
    "replies": [
      { "author": "agent", "text": "Confirmed — excluded from the trend line.", "createdAt": "2026-06-11T11:00:00.000Z" }
    ]
  }
]
```

`author` is `"user"` (default, when absent) or `"agent"`. `replies` is an array of
`{author, text, createdAt}` objects, capped at 50 per annotation.

### All target kinds

| kind | Fields | Triggered by |
|---|---|---|
| `chart-element` | `datasetIndex`, `index`, `label`, `value` | clicking a bar, point, or pie slice |
| `mermaid-node` | `nodeId`, `text` | clicking a diagram node |
| `graphviz-node` | `nodeId`, `text` | clicking a Graphviz node or edge |
| `table-cell` | `row` (0-based), `col` (column key), `value` | clicking a table cell |
| `text` | `quote`, `prefix` (≤30 chars before), `suffix` (≤30 after) | selecting text in a markdown block |
| `html-element` | `label`, `detail?` | clicking a `relayKit.commentable()` element |
| `image` | `label` | clicking a PlantUML diagram or an image block |

Read annotations as first-class feedback — they often carry the sharpest insight
(e.g. a user circling the one data point that concerns them, or quoting the exact
sentence they disagree with).

### Threaded replies — `rly reopen --replies`

After reading `result.annotations`, an agent can reply to specific comments and
reopen the board as a conversation:

```sh
rly reopen <id> --replies replies.json
```

`replies.json` is an array of `{"annotationId": "a1", "text": "..."}` objects.
The server seeds the draft from the saved result, appends each reply with
`author: "agent"` and `createdAt: now`, then serves the board prefilled. Unknown
annotation IDs cause a `CliError` (exit 4) listing valid IDs.

The UI shows agent and user replies as a thread under each comment — agent replies
use an accent chip, user replies use a muted chip.

## Presence — is the user still there?

While a board is open, the page reports activity (visibility, focus, idle
time). Use it instead of guessing timeouts:

```sh
rly result b-xxxxx     # open board → includes "presence":
                       #   {open, seen, visible, focused, secondsSinceActivity, secondsSincePing}
rly wait b-xxxxx --timeout 550 --while-active --idle-grace 180
```

`--while-active` keeps extending the wait as long as the user is demonstrably
active (page visible/focused and interaction within `--idle-grace` seconds,
default 180); once they go idle it returns the normal `wait-timeout` JSON,
with `presence` attached so you can decide what to do next. Prefer this over
raising `--timeout`.

## Push-wake — get notified instead of polling

```sh
rly ask --file spec.json --detach --on-result 'curl -s -X POST localhost:9999/wake -d @-'
rly wait b-xxxxx --notify-cmd 'touch /tmp/board-done'
```

`--on-result` (on ask/show/reopen/reuse) runs your shell command the moment
the board reaches a terminal status — submitted, acknowledged, timeout, or
cancelled — with the full result JSON piped to stdin and `RLY_BOARD_ID`,
`RLY_STATUS`, `RLY_URL` in the environment. `--notify-cmd` does the same from
a `wait` that obtains a terminal result. Write a file your harness watches,
hit a webhook — whatever wakes you.

## Editable diagrams — let the user redraw your mermaid

Add `"editable": true` to any mermaid block. The user gets an "Edit diagram"
button with live-preview source editing (syntax errors shown inline without
destroying the last good render; Reset restores your original). Their edited
source returns in the result:

```json
"blockEdits": { "b2": "graph TD; A-->B; B-->C[their new step]" }
```

Diff it against your original to see exactly what the user changed. Recipe:
propose an architecture as an editable mermaid block + a `yesno` "Does this
match your mental model?" + a `textarea` for anything the diagram can't say.
Edits autosave with the draft, so they survive reloads and timeouts too.

## Managing boards

```sh
rly list [--json]        # running boards (id, url, pid)
rly open [id]            # re-open the browser tab of a running board
rly reopen <id>          # serve a SAVED board again, prefilled with its saved
                         #   answers/draft; user can edit and resubmit
rly reopen <id> --replies replies.json
                         # reopen with agent replies (see Threaded replies above)
rly reuse <id>           # re-run a past board as a NEW board (blank answers)
rly spec <id>            # print a saved spec — edit it, then `rly ask --file`
rly history [--json]     # saved boards with statuses
rly stop <id> | --all    # stop running board(s) → status "cancelled", draft kept
rly rm <id> | --all      # delete saved board(s)
```

Multiple boards can run at once (each gets its own port on 127.0.0.1).
Storage lives in `~/.relay` (override with `RLY_HOME`).

## Live board mutation — `rly update`

Push a new spec to an already-open board without stopping it:

```sh
rly update <boardId> --file new-spec.json   # replace the full spec
rly update <boardId> --title "New title"    # patch just the title
rly update <boardId> --intro "New intro"    # patch just the intro
rly update <boardId> -q "!Priority::single::p0,p1,p2"  # append a question
```

The page **reloads** for the user and prefills their previous answers from the
autosaved draft — answers for question IDs that no longer exist are silently
ignored. A small toast "Board updated by the agent" appears for 4 seconds.

Stdout: `{"status":"updated","boardId":"…","rev":2,"url":"…"}`.

**Caution:** the page reloads for the user. Batch your changes into one `rly update`
call rather than calling it repeatedly in a loop.

## Tips for agents

- Prefer `--detach` + `rly wait` if your shell tool kills long commands.
- Don't pass `--no-open` for real users — the browser tab opening *is* the
  notification. Use it only in tests.
- Quote JSON carefully; prefer writing a spec file or piping via `--file -`.
- Use stable `id`s on questions so your follow-up logic reads clean keys.
- `rly result <id>` while a board is open returns the live draft — useful to
  check whether the user has started answering.
- In the board `intro`, tell users they can hover chart points / select text to
  leave inline comments — they won't discover it otherwise.
- Check `result.annotations` before generating your next output; a comment on a
  specific data point or a quoted sentence often overrides the checkbox answer.
- Use `rly reopen <id> --replies replies.json` to answer the user's element
  comments and reopen the board as a conversation thread.
- Use `rly update <id>` to push spec changes to a running board — the page
  reloads and answers survive via draft autosave. Batch updates; do not spam.
- For sensitive PlantUML diagrams, set `"server": "https://your-server"` to avoid
  sending source to the public plantuml.com server.
- Bundled universal skill (Claude Code, Codex, any SKILL.md-aware agent):
  `rly skill install` — or `npx skills add khanglvm/relay`.
