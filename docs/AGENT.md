# relay (`rly`) — agent guide

Use Relay to present files, visuals, substantial plans, diffs, and related user
questions. Choose purpose-built blocks so users can inspect the content and
leave precise feedback. Keep short answers and progress updates in chat.
Respect the user’s existing authorization; boards do not add approval gates.
If your host app has its own way to ask the user or show results (native question cards, forms, pickers), use that for those. Use Relay for what the host can't show: line comments on a diff, Mermaid or Graphviz diagrams, element comments on an HTML prototype, rich multi-block review boards.
For a concise workflow, read the bundled skill (`rly skill path`). This guide is
a reference for fields and less common operations. Load one part with
`rly agent <topic>` (`questions`, `blocks`, `annotate`, `lifecycle`, `sharing`,
`mcp`, `a2ui`), and one block or question type with `rly schema <type>`.

Use `rly show --file spec.json --display-only` when no response is needed. Use
`rly ask --file spec.json --detach` and a waiter for answers or comments.
Fast paths include `rly view`, `rly diff`, and `rly git`.

**Tell the user** at the start of your intro text that they can hover chart
points, diagram nodes, table cells, and any element of a custom-HTML block to
leave comments, and select text in markdown blocks to annotate — their comments
come back in `result.annotations` alongside their answers. Treat annotations as
first-class feedback.

**Read ALL four feedback channels, not just `answers`.** A result carries the
user's input across **four** places, each first-class — never act on `answers`
alone:

- `answers` — the per-question values (what they picked/typed).
- `notes` — per-question free-text notes (`result.notes[questionId]`): the small
  note box under a question, where users qualify or override a pick. **Single
  (radio) questions show this box by default**, so it is a very common place for
  the real reasoning to land. Easy to miss because empty notes are omitted —
  **always inspect `result.notes`.**
- `comment` — one board-level free-text note ("Anything else?").
- `annotations` — element-level inline comments on specific blocks/data points.

If any of `notes`, `comment`, or `annotations` is non-empty, it can override or
contradict an `answers` value — reconcile them before generating output.

Everything machine-relevant is on **stdout as JSON**; human-facing logs go to
stderr. Exit codes: `0` submitted/acknowledged · `2` timeout · `3` cancelled ·
`4` usage error · `5` not found.

## Block and question shapes (copy, then adapt)
```jsonc
{"type":"chart","kind":"bar","title":"Deploys vs incidents","labels":["W1","W2"],"series":[{"label":"Deploys","data":[12,19]},{"label":"Incidents","data":[1,0]}]}   // kind: bar|line|pie|doughnut|radar|scatter
{"type":"kpi","items":[{"label":"Deploys","value":"67","delta":"+12%","dir":"up"}]}
{"type":"table","columns":[{"key":"name","label":"Name"}],"rows":[{"name":"x"}],"sortable":true}
{"type":"image","src":"/abs/a.png","alt":"A","pins":true}             // users can also drag a region to comment
{"type":"compare","before":"/abs/a.png","after":"/abs/b.png"}          // draggable divider
{"type":"diff","diffFile":"/abs/change.diff"}   {"type":"code","codeFile":"/abs/app.js"}   {"type":"markdown","mdFile":"/abs/PLAN.md"}
{"type":"mermaid","code":"graph TD; A-->B","editable":true}              // edits come back in blockEdits
{"type":"a2ui","title":"Checks","express":"$/runs = [{title: \"Build\", trailing: \"ok\", tone: \"ok\"}]\nroot = Card(\"Checks\", [List($/runs), Button(\"Retry\", action=Event(\"retry\", {}))])"}   // buttons and live status: use a2ui, not html
{"id":"signoff","type":"checklist","label":"Sign off each area","options":["login","billing"]}   // pass/fail/N-A per item: one checklist, not many yes/no
{"id":"rank","type":"rank","label":"Priorities","options":["speed","a11y"]}   {"id":"split","type":"allocate","label":"Budget","total":100,"options":["type","space"]}
{"id":"c","type":"single","label":"Scheme?","options":[{"value":"warm","label":"Warm","blocks":[{"type":"html","html":"<!doctype html><html><body style='background:#c2674b'>Warm</body></html>","isolated":true,"height":140}]}]}
{"id":"hero","type":"pick","label":"Shortlist two","max":2,"items":[{"id":"a","title":"Warm","image":"/abs/a.png","caption":"Terracotta"},{"id":"b","title":"Demo","video":"https://example.com/b.mp4"},{"id":"c","title":"Ref","url":"https://example.com/c"}]}   // media tiles; answer {picks:[{id,note?}],overall?}; max 1 = single, min/max bound a multi
{"id":"s","type":"scale","label":"Rate","min":1,"max":5}   {"id":"col","type":"color","label":"Brand color"}   {"id":"ship","type":"yesno","label":"Ship?"}
```
Buttons inside a2ui do not replace a question. Their clicks return in `blockEdits`.

## Two execution patterns

**1. Blocking (simplest).** The command blocks until the user submits, then
prints the result JSON:

```sh
rly ask --file spec.json --timeout 86400   # one day; 0 = no Relay deadline
```

**2. Detached (recommended when your shell tool has an execution time limit).**
Returns immediately with the board URL; collect later:

```sh
rly ask --file spec.json --detach     # → {"status":"open","boardId":"b-…","url":"…"}
rly wait b-xxxxx --timeout 86400      # default: one day; pass 0 for no deadline
rly result b-xxxxx                    # non-blocking peek; while open it includes
                                      # the live autosaved draft of the user's answers
```

Answers **autosave in real time** as the user fills the board — a page reload
restores them, and a draft survives timeouts/cancellation (included in those
results), so partial input is never lost.

## Same-Wi-Fi sharing

Browser boards are local-owner only by default. A same-Wi-Fi phone/tablet/other
laptop gets a locked page until sharing is explicitly activated. The owner can
click the topbar **Share** icon, or you can manage the same links for the user:

```sh
rly share b-xxxxx                         # list active share roles
rly share b-xxxxx --role review           # reviewer: answer/comment + submit a side review
rly share b-xxxxx --role collab           # collaborator: edit/comment/final-submit as owner-authorized
rly share b-xxxxx --role read             # read-only viewer: no answers/comments/submit
rly share b-xxxxx --role review --revoke  # revoke one role
rly share b-xxxxx --revoke --all          # revoke all active links
```

Use `review` for independent feedback: each browser gets an isolated review
draft and may answer, comment, and submit, but the submission is stored as a
**reference-only side review**. It does not finish the board, wake the agent, or
complete `rly wait`; the owner (or an owner-authorized collaborator) must still
submit the final answer. `rly result <id>` exposes current side-review drafts and
submissions on demand under `sideReviews`, clearly marked `referenceOnly:true`.
Use `read` when the other device should only view the board and existing
feedback. Read-only viewers cannot answer, comment, edit blocks, open local file
links, or submit. Collaborators retain owner-authorized edit/comment/final-submit
permission. Active links keep the same token across a same-port
`rly reopen`/`rly rescue` until revoked.

## A private URL for other devices

A board listens on this machine. To open it from a phone or another computer
without Wi-Fi sharing, give it a link setting. `rly ask`, `rly show`, `rly view`
and `rly diff` accept:

```sh
rly ask --file spec.json --detach --public-url 'https://boards.example.com:{port}'
rly ask --file spec.json --detach --link-command 'my-link-tool {port}'
rly config link command:'my-link-tool {port}'      # make it the default (also: off, or a URL)
```

- `--public-url` takes any https URL that reaches the board's port, such as a
  reverse proxy you run. `{port}` becomes the board port. Loopback hosts are
  refused. `RLY_PUBLIC_URL` and `RLY_LINK` set the same from the environment.
- `--link-command CMD` (or `RLY_LINK_COMMAND`) runs any command that takes the
  board's port ({port} in the command, or appended) and prints an https URL,
  either as plain text or as JSON with a `url` field. `RLY_LINK_RELEASE_COMMAND`
  runs when the board closes, so the provider can remove its route.
- Precedence: `--link-command`, `--public-url`, `RLY_LINK_COMMAND`,
  `RLY_PUBLIC_URL`, `RLY_LINK`, `rly config link`, then off.
- Answers return as usual: `rly wait <id>` and `rly result <id>`.

Report the printed URL to the user and never a `localhost`, `127.0.0.1` or
`0.0.0.0` address. Whoever can reach the link can reach the board, so the token
in the URL and the network behind the link are the access control. Use
`rly share <id> --revoke --all` to cut access.

## Inline mode: relay as an MCP App (Claude and Codex apps)

Everything outside this section is the CLI surface: you run `rly` and read JSON from stdout. Relay is also an MCP App server (SEP-1865). A host that registers `rly mcp` (see `rly mcp config` and `rly mcp install --target claude|codex`) renders the board inline in the conversation instead of a browser tab.

Tools:
- `relay_board`: takes the spec this guide describes. A spec with `questions` collects answers; one without is display-only. The result is a short summary with the `boardId`, never the spec.
- `relay_result {boardId, wait_seconds}`: the answers, notes, comment, annotations and blockEdits, or the draft while the person is still filling the board in. `wait_seconds` blocks until they submit, up to 50, which stays under the roughly 60-second tool timeout of MCP clients. A status of `open` is not an answer: call it again.
- `relay_help {topic}` or `relay_help {schema}`: a part of this guide, or the exact fields of one block or question type.
- `relay_ask` and `relay_show`: the old names, kept as aliases for one more minor version. Use `relay_board`.

Call `relay_board` and point the person to the board. Use the returned `next` call to wait for Submit, then repeat it while `relay_result` returns `status: "open"`. Read the submitted `answers`, `notes`, `comment`, `annotations` and `blockEdits` in `structuredContent`. The text result carries the same JSON for older clients. A display-only board has no `next` call.

If a tool already generated a spec, pass its file and add questions in the same call.

```json
{
  "specFile": "/path/to/relay-spec.json",
  "title": "Hero direction",
  "questions": [{"id":"avoid","type":"textarea","label":"What should we avoid?"}]
}
```

Relay displays the file's blocks and questions first, then appends any inline ones. Inline fields such as `title` override the file's values. Adding inline questions opens a display-only file for feedback. `specFile` must be an absolute path on the server, inside an allowed file root. Relative asset paths resolve beside that file. For files on a different machine, send the spec inline with HTTPS or data URLs for its assets.

`rly mcp` speaks stdio to a local desktop host. `rly mcp --http [--port N] [--token-file PATH] [--allow-origin ORIGIN]` serves Streamable HTTP at `/mcp` for hosts that connect over a network. The bearer token comes from `--token-file`, `RLY_MCP_TOKEN` or `--token`; the flag shows in `ps`, so prefer the file or the variable. Boards are stored in the relay home of the machine that runs the server, so `codeFile` and local images resolve there and nowhere else, and only under the server's file roots: none over HTTP unless the operator passes `--root PATH` (repeatable) or `RLY_FILE_ROOTS`, the working directory over stdio (but not when it is `/` or the home directory, where desktop hosts often start it). `--retention-days N` (or `RLY_RETENTION_DAYS`, `off` to keep every board) sets how long unchanged boards stay in the relay home; the default is 30. A host that draws A2UI can show the whole board natively instead of the iframe. It declares the board catalog, `https://github.com/khanglvm/relay/a2ui/catalog/board/v1`, under `extensions.a2ui["1.0"].supportedCatalogIds` when it connects, or per call in `_meta.a2ui`; the call wins over the connection. `relay_view` then returns the board as A2UI messages (`application/a2ui+json`, `application/json+a2ui` is accepted when declared) and the host sends button events to `a2ui_action` with the surface's data model. The catalog is `src/a2ui/board-catalog.json`; `toA2ui(spec)` and `fromA2ui(dataModel, spec)` from `@khanglvm/relay/a2ui-board` convert in both directions, and the result matches what the web board stores. Hosts that did not declare it keep the iframe.

To add the tools to a server you already run, call `registerRelay(server, {store, assetUrl, linkUrl, mediaUrl})` from `@khanglvm/relay/mcp`. `mediaUrl(boardId, blockId)` names a URL the host serves a local video or pdf block from; answer it with `serveBoardMedia(req, res, {boardId, blockId})`, which streams the stored file with Range support.

If the host streams the tool call, inline boards preview blocks and questions as they arrive. File-backed boards load after the server resolves the file.

Inline boards match the browser board. The server inlines `codeFile`, `htmlFile`, `diffFile` and local images (as data URIs) while it normalizes the spec, so the sandboxed board needs no file access. Element comments work on chart points, diagram nodes, table cells, images and text selections, and come back in `annotations`. The board adopts the host's theme, fonts, colors and full-screen control. Two gaps remain: local video and pdf files play only on a host that passes `mediaUrl` (`rly mcp` does not; use a YouTube, Vimeo or https URL there), and comments on elements inside a custom HTML mockup are not collected.

## Creating boards

From a JSON spec file (`--file spec.json`), stdin (`--file -`), or quick
inline questions:

```sh
rly ask -q "Deploy to prod now?::yesno" -q "!Environment::single::dev,staging,prod"
#         label::type::comma,separated,options          leading "!" = required
```

Visualization-only, with acknowledgement/feedback:

```sh
rly show --html-file prototype.html --title "Dashboard concept" --height 600
```

Display-only (the agent continues immediately; no note, comments, or
Submit/Acknowledge action):

```sh
rly show --file spec.json --display-only
# equivalent spec field: {"responseRequired": false, "blocks": [...]}
```

`--display-only` automatically detaches the browser board. In MCP App mode,
`relay_board` with no `questions` is display-only; set `responseRequired:true` only
when the user really needs to acknowledge or leave feedback.

Read a markdown file (no questions; library-free renderer; submit reads "Done"):

```sh
rly view PLAN.md                      # one file
rly view README.md CHANGELOG.md       # several, each under a filename heading
rly view data.csv                     # .csv/.tsv/.json → a sortable, filterable table
rly view report.pdf                   # .pdf → inline PDF viewer
```

Show a git diff in one step (sugar — runs git diff, opens a diff board):

```sh
rly diff --detach                     # working-tree diff (git args pass through:
rly diff --staged --split             #   --staged, HEAD~1, -- path, …); --split = side-by-side
```

Pick/cherry-pick commits or resolve conflicts on a board:

```sh
rly git pick --limit 20               # checklist: pick/cherry-pick/drop + rank order
rly git cherry-pick main..feature     # checklist: cherry-pick/skip/hold + rank order
rly git cherry-pick --code main..feature # adds split code review with Apply/Skip/Hold per hunk
rly git conflict                      # auto-detect unmerged files with conflict markers
rly git conflict src/app.js           # resolve a specific conflicted file
```

For authored boards, use a `git-conflict` block. It accepts inline conflict
marker content or a local file path, auto-detects each hunk, and returns user
choices plus the full resolved file in `result.blockEdits[blockId]`:

```jsonc
{ "type": "git-conflict", "file": "src/app.js" }
{ "type": "git-conflict", "filename": "app.js", "content": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n" }
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
  "responseRequired": true,         // false = display-only; no feedback/action, agent continues
  "submitLabel": "Submit",
  "questions": [
    { "id": "approach", "type": "single", "label": "Which approach?", "required": true,
      "options": [
        { "value": "a", "label": "Approach A", "description": "fast, less flexible" },
        "Approach B"                                    // plain strings work too
      ],
      "other": false },                                 // single: "Other" (free-text textarea) is ON by default — set false to remove it
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
| `color`    | color string (e.g. `"#c2674b"`, `"rgb(...)"`, a name) — native picker + hex field; optional `presets:["#…"]` small swatches, or a `palette:[…]` of labeled swatch CARDS (click = answer, each card commentable, any CSS color system) |
| `rank`     | `["b","a","c"]` — ordered option values, highest priority first |
| `checklist`| `{ "login":"pass", "checkout":"fail" }` — per-item status map |
| `allocate` | `{ "eng":50, "design":30, "ops":20 }` — budget distributed across options |
| `pick`     | `{ "picks":[{"id":"a","note":"why"}], "overall":"…" }` — tiles in the order picked |

`rank` renders the `options` as a reorderable list (drag or ↑/↓ buttons); the
user prioritizes them and the answer is the ordered array of values. Needs ≥2
options, takes no "Other", and **always returns a value** (an untouched rank
submits the authored order), so it never appears in `skipped`. Reach for it on
roadmap / feature-prioritization questions instead of forcing a single pick.

`checklist` gives each `option` a status control (default Pass / Fail / N·A;
override with `"statuses"`); answer is `{optionValue: statusValue}`. `allocate`
distributes a budget (`"total"`, default 100) across the options with sliders +
a live total bar; answer is `{optionValue: number}`. Both take per-option
`description`/`blocks` like single/multi.

`pick` shows media tiles to choose from. `items` are tiles: a string, or
`{id, title, caption?, image?, video?, url?}`, where `image` is a path or an
https URL, `video` plays as a muted preview when it is a file and opens as a
link otherwise, and `url` opens the page. `max` caps the picks (1 makes it a
single choice), `min` above 0 makes it required, and `itemNote:false` or
`overall:false` hide the per-tile and overall notes. Unknown ids are dropped
and the list is cut to `max`. Up to 60 tiles.

Aliases accepted: radio/choice/select→single, checkbox→multi,
boolean/bool/yn→yesno, input→text, longtext→textarea, rating/likert→scale,
colour/swatch→color, ranking/order/ordering/prioritize/sort→rank,
signoff/qa→checklist, budget/distribute/points→allocate, tiles/gallery/shortlist→pick.

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

`notes` (a `{ questionId: "text" }` map) is **always present** in a result —
`{}` when empty — so you can never miss that the channel exists; iterate it
even when you only expected `answers`. Questions with `"note": true` show a
small optional free-text field, and only **non-empty** notes appear as keys.
**`single` (radio) questions show this note by default** so the user can
qualify or override their pick — set `"note": false` to hide it. A note like
`notes.approach = "actually B, not A"` is the user's real intent and outranks
the `answers.approach` radio value — always check `notes` before acting.

On `timeout`/`cancelled`, a `draft` field carries the autosaved partial
answers, notes, and any annotations written so far.

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
- Put a live prototype in `options[].blocks` with
  `{"type":"html","html":"<!doctype html>...","isolated":true,"height":480}`.
  Send the complete document. Inline CSS and JavaScript. Use data URLs for
  local assets or absolute HTTPS URLs the host allows.
- Set the preview height to suit the content. Click the option label to select
  it. Controls inside the preview belong to the embedded page.
- Use this whenever the choice has visual/example context; skip it for plainly
  textual options. It beats one big side-by-side comparison block because the
  selected visual is unambiguous.

### All block shapes

```jsonc
// Markdown — built-in mini renderer, no library. Headings, lists, code, quotes,
// links, images, and GFM pipe tables all render. For real tabular DATA use a
// `table` block instead (sortable + per-cell comments); markdown tables are display-only.
{ "type": "markdown", "md": "## Heading\nAny **CommonMark** prose." }
// Load the body from a local .md file instead of inlining it (README, plan, report).
// Quick view of whole file(s) with no questions: `rly view file.md [more.md …]`.
{ "type": "markdown", "mdFile": "README.md" }

// Mermaid diagram — vendored, lazy-loaded; natural height, max 800 px + scroll (set height: to override)
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

// Table — sortable, with individually annotatable cells. Prefer this over a
// markdown pipe table whenever you're showing structured data (option matrices,
// comparisons, workstream/effort grids): users can sort it and comment per cell.
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

// Code — syntax-highlighted + line-numbered. Inline "code" or load a local
// file with "codeFile" (lang then defaults from the extension). "filename"
// shows a header label. Highlighted langs: js ts py go rust java c cpp csharp
// ruby php swift kotlin sql yaml json sh css html (+ aliases) — others plain.
{ "type": "code", "lang": "js", "code": "const x = 1 + 2;", "filename": "demo.js" }
{ "type": "code", "codeFile": "src/server.js" }

// Diff — a unified diff (git diff / `diff -u` output) rendered as a colored,
// line-numbered comparison: +added / −removed / context, file & hunk headers.
// No git needed — just write/paste the diff text. "lang" tints each code line;
// "diffFile" loads it from a local file. "view":"split" starts side-by-side
// (old vs new); the viewer has a live Unified⇄Split toggle either way.
{
  "type": "diff", "lang": "js", "filename": "src/auth.js", "view": "split",
  "diff": "@@ -1,3 +1,3 @@\n function login(u) {\n-  return check(u)\n+  return check(u.trim())\n }"
}

// Video — a YouTube/Vimeo URL embeds a player; an http(s) media URL or a local
// video file (mp4/webm/ogv/mov/mkv/m4v) plays inline. Local files STREAM from
// the server (Range-enabled, seekable) and are never embedded in the payload.
{ "type": "video", "src": "https://youtu.be/dQw4w9WgXcQ", "title": "Demo walkthrough" }
{ "type": "video", "src": "recordings/demo.mp4", "title": "Local capture", "height": 360 }

// PDF — an http(s) PDF URL or a local .pdf file rendered inline. Local PDFs
// stream from the server and are never embedded in the page payload.
{ "type": "pdf", "src": "reports/quote.pdf", "title": "Quote", "height": 900 }

// HTML — sandboxed iframe; default height 360
{ "type": "html", "html": "<h1>Hello</h1>", "height": 360 }
{ "type": "html", "htmlFile": "viz.html",   "height": 400 }

// Image — local file path (embedded at spec time, works offline), http(s) URL,
// or data URI. "height" sets only the COMPACT inline preview — every image keeps
// a full-screen + zoom (⌘/Ctrl+wheel or −/+, up to 8× native) + drag-to-pan
// viewer, so a small height never hides detail. Local images embed up to 8 MB;
// for a huge / high-resolution image pass an http(s) URL (streamed, no size cap).
{ "type": "image", "src": "screenshots/variant-a.png", "alt": "Variant A", "height": 220 }
{ "type": "image", "src": "https://example.com/mock.png" }

// palette — color palettes as swatch cards (hover reveals hex, click copies).
// Mark one {"featured": true} to render it larger as a spotlight; the rest tile
// into a responsive grid. Pairs with a "color" question to let the user pick.
{ "type": "palette", "title": "Trending palettes", "palettes": [
  { "name": "Mocha Mousse", "sub": "Pantone 2025 · warm", "tag": "Pantone", "tagTone": "warm",
    "featured": true, "colors": ["#C4956A","#A67B52","#8B6240","#D4AB89","#EDD9C4"] },
  { "name": "Digital Lavender", "mood": "soft tech", "tag": "Cool", "tagTone": "cool",
    "colors": ["#C9BAF5","#A08EE8","#7B66CC","#5849A8"] } ] }
{ "type": "palette", "name": "Brand", "colors": ["#c2674b", "#1c1b19", "#fcfbf9"] }  // single-palette shorthand
// tagTone (optional pill color): warm | cool | neutral | nature | bold | digital
```

### Local file links — preview in a board modal

Write `[source](/absolute/path/app.js:98)` in the intro or a markdown block.
Bare/backtick paths, `./`, `../`, `~/`, and `file://` URLs also work. Encode spaces
in file URLs (`file:///tmp/My%20Report.md`). The browser board previews supported
files in a modal and restores focus/scroll when closed. `:line`, `:line:column`,
and `#Lstart-Lend` select source lines; columns are accepted but not highlighted.

UTF-8 source/config/log files show numbered source. Markdown renders as a
document, CSV/TSV as a table, and HTML as a static sandboxed page; these have a
Source toggle. Images, PDFs, and browser-compatible audio/video render directly.
HTML scripts, forms, and external resources are disabled. Text previews are
limited to 1 MiB and 20,000 lines. Unsupported/binary/oversized files and
folders offer an explicit **Open in app** action; missing files show an error.

Preview/open access is restricted to paths explicitly referenced on the board,
for owner/collaborator browser sessions only. A preview’s nested links do not
extend the allowlist. These are live disk views without annotations; use content
blocks for snapshots or feedback. For inline MCP or reviewer/read-only shares,
embed the file content using `mdFile`, `codeFile`, or media blocks instead.
Running boards retain their old UI/server snapshot after upgrade; reconnect the
same board using the upgraded CLI to activate the viewer.

### When to use which block

**Reach for the most specific component — never default to prose.** relay has a
purpose-built block/question type for most content; falling back to a `markdown`
block (or terminal text) when a dedicated one fits is the #1 way agents
under-use relay. A metric → `kpi`, a before/after → `compare`, a priority call →
a `rank` question. When unsure what exists, consult this table, `rly schema`, and
the question-types section above.

**By domain** (serve the reader the right shape):
- **Business / PM / exec** — `kpi` + `chart` + `table` for numbers; `rank`
  (prioritize), `allocate` (split a budget), `checklist` (sign-off), `scale` (confidence).
- **Designer** — `image` (+`pins`), `compare` (before/after), `palette`, `typography`;
  a visual inside each option.
- **Engineer** — `diff` (`rly diff`), `code` (line-comments), `mermaid`/`graphviz`
  (architecture; editable mermaid to co-design).
- **Data / analyst** — `table` with `rowsFile`/`filterable`/`exportable`
  (`rly view data.csv`), `chart`.

| Block | Best for |
|---|---|
| `mermaid` | flows, state machines, architecture overviews, sequence diagrams |
| `graphviz` | precise dependency graphs, call graphs, state machines when Mermaid's auto-layout falls short; individually annotatable nodes and edges |
| `plantuml` | UML diagrams (sequence, class, component) via server rendering; great for detailed interface contracts |
| `chart` | numbers, trends, comparisons, metrics |
| `table` | structured comparisons, option matrices, data grids — **use this for any tabular data**: it's sortable and every cell is commentable, unlike a markdown pipe table |
| `markdown` | prose context, background, instructions, section headings (renders GFM pipe tables + images too, but reach for a `table` block for real data); load a whole `.md` file with `mdFile` — or `rly view file.md` for a quick read-only board |
| `code` | code snippets, config examples, command output — syntax-highlighted + line-numbered; load from a file with `codeFile` |
| `diff` | proposed code changes / before-after — a unified diff rendered as a colored git-style comparison (no git needed) |
| `video` | demos, screen recordings, walkthroughs — YouTube/Vimeo embeds, a media URL, or a local video file (streamed) |
| `pdf` | quotes, reports, exports, forms — local `.pdf` files or PDF URLs rendered inline; local files stream from the board server |
| `image` | screenshots, mockup exports, photos — local files embed and work offline; drag to comment on exact pixels |
| `palette` | color palettes / themes — swatch cards with hover-hex + click-to-copy; pair with a `color` question to let the user pick |
| `kpi` | big-number metric cards (`items:[{label,value,delta?,dir?,sub?}]`) with up/down/flat-tinted deltas — at-a-glance numbers without a chart |
| `typography` | type specimens (`specimens:[{label?,size?,weight?,font?,text?}]`) — react to type choices like a palette |
| `compare` | before/after images with a draggable divider (`before`/`after` = url/path/`{src,label}`); area comments preserve which side was selected |
| `a2ui` | a small live widget: status list, numbers, progress, quick-action buttons, a short form. Written in A2UI Express; the clicks and input values come back in `result.blockEdits[blockId]`. Full grammar and examples: `rly a2ui` (docs/A2UI.md) |
| `html` | anything else — pixel-perfect mockups, custom widgets, embeds |

Two cross-block fields work on **any** block: `"ref":"name"` makes it openable in
a modal via a markdown `[label](#ref:name)` link (point a question at a visual
shown earlier — no scrolling); `image` blocks also take `"pins":true` for
click-to-drop coordinate pin-comments. `table` blocks take `"rowsFile"` (load
rows from .csv/.tsv/.json), `"filterable"`, and `"exportable"` (CSV download).

Every interactive `image` and `compare` block also supports area feedback:
primary drag draws a rectangle directly; the viewer's **Area** control remains a
discoverable one-shot lock for the same gesture. On images, Space-drag or the
middle mouse button pans. In comparisons, only dragging the divider handle moves
the split. The provisional rectangle remains visible while the comment is
composed; a saved zone shows a comment icon plus count and reopens for
add/edit/delete. Removing its final comment removes the zone. Relay saves a pixel
crop beside the board record and returns its local path with the annotation, so
the agent can open the exact pixels instead of inferring from a whole-image
comment. In a comparison, the visible side where drawing began is recorded as
`before` or `after` and the crop comes from that source image. Remote images that
prevent browser canvas access still return coordinates and a `cropUnavailable`
marker.

### Height rules

- `markdown`, `code`: natural flow (no fixed height).
- `mermaid`: natural flow, max-height 1200 px with internal scroll. Override with `"height"`.
- `chart`: default 320 px. Override with `"height"`.
- `html`: default 360 px. Override with `"height"`.
- `image`: natural size (never upscaled), max-height 1200 px with scroll. `"height"` caps the **inline preview only** — full-screen + zoom (up to 8× native) always reach full detail. Local images embed up to 8 MB; use an http(s) URL for larger.
- `table`: natural flow.
- All heights clamp to 100–2400 px.
- Inside OPTION cards, always set a compact `"height"` (~140–260) on
  chart/html/image blocks — the per-scope defaults are tuned for full-width use.

## Custom HTML sizing contract

- Relay renders HTML in a sandboxed iframe. It allows scripts, forms, popups,
  and modals. The frame has its own origin. Inline your CSS, JavaScript, and
  local assets so the page can load inside an MCP host.
- **Width: always 100% of the content column — up to ~820 px on desktop, as
  narrow as ~300 px on phones. Design responsively; don't assume fixed width.**
- **Height: fixed per block via `height` (px, 100–2400). Default 360.**
  Content taller than that scrolls inside the iframe.
- Set `"isolated": true` to embed the HTML as supplied. Relay skips its theme
  wrapper and element-comment script. Changing the board theme leaves the preview
  running. Comments on the whole block are still available.
- Other HTML blocks can follow the board theme. Relay wraps fragments in a
  themed document. On the browser board, complete documents can read the
  `?theme=light|dark` query parameter.

### Custom HTML is hover-commentable automatically

On the browser board, hover over an element in a themed HTML block to leave a
comment. Relay returns it in `result.annotations` with
`target.kind = "html-element"`, a stable `target.ref`, and a `target.label`
derived from the element.

Reach for the controls below only when you want to **scope or label** what's
annotatable — typically for an interactive prototype where blanket hover targets
would get in the way:

**Declarative signal (preferred)** — mark the elements you want commented. Any
signal present switches the auto-pick off, so only your marked elements are
annotatable:

```html
<button data-relay-annotate="Primary CTA" data-relay-detail="checkout flow">Buy now</button>
<section data-relay-annotate="Pricing table">…</section>
```

**Imperative** — same effect from script (needs `/kit.js`, which relay also
auto-loads):

```html
<script src="/kit.js"></script>
<script>
  relayKit.commentable(document.getElementById('chart'), 'Revenue chart', 'Q1 2026');
</script>
```

**Opt out** of element annotation for a block with `data-relay-annotate="off"`
on `<html>` or `<body>`.

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
| `html-element` | `ref`, `label`, `detail?` | hovering any element in a custom-HTML block (auto), or a `data-relay-annotate` / `relayKit.commentable()` element |
| `image` | `label` | clicking a PlantUML diagram or an image block |
| `image-point` | `x`, `y`, `label` | clicking an image authored with `pins:true` |
| `image-region` | `x`, `y`, `w`, `h`, `label`, optional `side`, `crop` | holding then dragging on an image or comparison; `crop.path` is the local image artifact in browser mode |

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
rly wait b-xxxxx --timeout 86400 --while-active --idle-grace 3600
```

`--while-active` keeps extending the wait as long as the user is demonstrably
active (page visible/focused and interaction within `--idle-grace` seconds,
default 180); once the deadline is reached and they are idle it returns the
normal `wait-timeout` JSON, with `presence` attached. Relay now defaults both a
board and `rly wait` to 86,400 seconds (one day); pass `--timeout 0` for no Relay
deadline when the host can safely own a long-running waiter.

### A `timeout` on a detached board is NOT the end

For a **detached** board, the `timeout` deadline is *soft*: it hands you a
`timeout` result (with the autosaved draft) so you regain control, but the
server stays up and the board stays fully usable — the user can keep
commenting and still hit Submit. It stays on the same port until Submit or an
explicit `rly stop`, so don't reopen just because your wait timed out. The page
tells them you stopped waiting and to prompt you afterward. So if you got a
`timeout` and the user might still be working: re-check later with `rly result
<id>` (its status flips to `submitted` once they finish), or pass `--on-result`
so a late submit push-wakes you. A blocking `rly ask` (no `--detach`) still ends
hard on timeout, since there's no separate waiter to hand back to.

## Waiting and push-wake across agent clients

```sh
rly ask --file spec.json --detach --on-result 'curl -s -X POST localhost:9999/wake -d @-'
rly wait b-xxxxx --notify-cmd 'touch /tmp/board-done'
```

`--on-result` (on ask/show/reopen/reuse) runs your shell command the moment
the board reaches a terminal status — submitted, acknowledged, timeout, or
cancelled — with the full result JSON piped to stdin and `RLY_BOARD_ID`,
`RLY_STATUS`, `RLY_URL` in the environment. `--notify-cmd` does the same from
a `wait` that obtains a terminal result. Write a file your harness watches,
hit a webhook — whatever wakes you. This is passive only when that client or
harness has an actual inbound wake mechanism; Relay does not pretend that a
file write alone starts a new model turn.

| Client/surface | Recommended Relay return path |
|---|---|
| MCP App (`relay_board` with questions) | No CLI wait. Keep a `relay_result` wait open; on submit it returns the answers. With no wait open, the board posts a one-line message instead. |
| MCP App (`relay_board`, display-only) | Present it and continue immediately; no acknowledgement is requested. |
| Claude Code | Run `rly wait <id> --timeout 0` as a [background Bash task](https://docs.anthropic.com/en/docs/claude-code/interactive-mode#background-bash-commands); retain its task id/output rather than opening a second board. |
| Gemini CLI | Run the waiter in the background and set [`tools.shell.backgroundCompletionBehavior` to `"inject"`](https://geminicli.com/docs/reference/configuration/) so completion is returned to the agent; `"notify"` only informs the chat UI. |
| Codex | Keep one foreground waiter. Codex background terminals use explicit `write_stdin` polling (the [poll window defaults to five minutes](https://developers.openai.com/codex/config-reference)); the process can outlive each poll, but no portable browser-submit API wakes a stopped turn. |
| OpenCode | Core Bash is foreground. Its [ecosystem](https://opencode.ai/docs/ecosystem/) lists background-PTY extensions; use one only when installed, otherwise keep the waiter foreground. |
| Pi | Core intentionally has [no background Bash](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md); keep the waiter foreground or use an explicitly installed background-task extension. |

### Codex browser-board pattern

Codex does not have a normal, user-facing "wake this agent turn from a browser
submit" command. If the Codex turn stops waiting, a later board submit can leave
the user needing to prompt manually. So when an agent is running in Codex and
uses the browser board path, keep the waiter in the foreground until the user
submits:

```sh
rly ask --file spec.json --detach
rly wait b-xxxxx --timeout 86400 --while-active --idle-grace 3600
```

If `rly wait` exits with `wait-timeout`, immediately run `rly result <boardId>`.
If it is still open and the user may continue, run `rly wait` again. Do not use
`--on-result` as the primary Codex return path; it can write files or hit
webhooks, but normal Codex CLI sessions do not expose a portable inbound API
that wakes the current agent turn.

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
Detached boards are durable: they keep serving past timeout, `reopen`/`rescue`
prefer the last port, and active same-Wi-Fi share links keep the same token until
revoked. Storage lives in `~/.relay` (override with `RLY_HOME`). A board unchanged for 30 days is
deleted when the next board is created, unless its server is still running; set `RLY_RETENTION_DAYS`
(a number of days, or `off`) to change that.

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

The new spec reads local files only under the roots the board was created with;
`--root` is refused on update, so start a new board with `rly ask --root PATH` to read elsewhere.

**Caution:** the page reloads for the user. Batch your changes into one `rly update`
call rather than calling it repeatedly in a loop.

## Tips for agents

- Prefer `--detach` + `rly wait` if your shell tool kills long commands.
- Don't pass `--no-open` for real users — the browser tab opening *is* the
  notification. Use it only in tests. Under T3 Code or Sushi, Relay already
  skips the tab, because the person reads the board from another device.
  Give them the printed URL.
- Quote JSON carefully; prefer writing a spec file or piping via `--file -`.
- Use stable `id`s on questions so your follow-up logic reads clean keys.
- `rly result <id>` while a board is open returns the live draft — useful to
  check whether the user has started answering.
- In the board `intro`, tell users they can hover chart points / select text to
  leave inline comments — they won't discover it otherwise.
- Check `result.notes` AND `result.annotations` before generating your next
  output — not just `answers`. A per-question note (e.g. `notes.scope = "docs can
  wait"`) or a comment on a specific data point / quoted sentence often qualifies
  or overrides the checkbox answer. `notes` is always present (`{}` when empty),
  so iterate it every time.
- Use `rly reopen <id> --replies replies.json` to answer the user's element
  comments and reopen the board as a conversation thread.
- Use `rly update <id>` to push spec changes to a running board — the page
  reloads and answers survive via draft autosave. Batch updates; do not spam.
- When the user asks to *see* code changes — "show me the diff", "show me git
  diff", "review these changes" — capture `git diff` (or `git show <sha>`) and
  render it in a `diff` block instead of printing it to the terminal; for a
  brand-new file use a `code` block. Point them at a file to inspect with a
  clickable local path in markdown.
- For sensitive PlantUML diagrams, set `"server": "https://your-server"` to avoid
  sending source to the public plantuml.com server.
- Bundled universal skill (Claude Code, Codex, any SKILL.md-aware agent):
  `rly skill install` — or `npx skills add khanglvm/relay --skill relay --all`.
  `rly upgrade` refreshes the CLI **and** the skill (via npx skills, falling back
  to the bundled copy) in one step.
