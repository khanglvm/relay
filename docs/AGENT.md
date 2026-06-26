# relay (`rly`) — agent guide

Purpose: ask the human structured questions in a browser tab and/or show them
rich content blocks (markdown, charts, diagrams, tables, code, custom HTML),
then **wait for them to click Submit** and read the answers as JSON from stdout.
No "type 'done' in the terminal", no hand-rolled HTML+server.

**Use relay even in plan mode** — for any clarifying or decision question (Claude
Code / Codex), route it through a relay board, **not** the native
`AskUserQuestion` / ask-user tool: that tool is **not** a substitute, even though
plan-mode guidance suggests it. Do NOT ask in plain terminal text and do NOT
reach for the native ask tool for anything beyond one trivial yes/no — open a
board. Reserve the harness's `ExitPlanMode` strictly for the final plan-approval
gate (it's a mode transition, not a question).

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

## Inline mode — relay as an MCP App (Claude & Codex apps)

Everything above is the **CLI** surface (you run `rly` in a terminal and read
JSON from stdout). relay is **also** an MCP App (SEP-1865): when a host registers
`rly mcp` (see `rly mcp config` / `rly mcp install --target claude|codex`), you
get two tools that render the board **inline in the conversation** instead of a
browser tab. `rly mcp` speaks the MCP **stdio** transport, so it pairs with a
**local desktop** host — Claude Desktop and Codex today.

- **`relay_ask`** — collect decisions/feedback with real form controls.
- **`relay_show`** — present a plan, diagram, diff, table, or prototype.

**Web / mobile / remote hosts** can't reach a stdio subprocess, so for those run
the **Streamable HTTP** transport: `rly mcp --http [--port N]` serves the same
tools at `/mcp`. relay needs **only its own CLI** for this — no tunnel tool, no
extra infra. Because relay is **stateless** (answers go iframe→host→model, never
back to the server), **one deployed instance serves everyone**, so deploy it once
on any address the app can reach and register that URL as a custom connector:

- **Free MCP hosts** — the repo's `Dockerfile` runs relay with zero config on
  **mcpdeploy.dev**, **mcphosting.io**, **Render / Railway / Fly**, or **Glama**;
  the platform's `$PORT` is honored automatically. Set `RLY_MCP_TOKEN` for a
  bearer-protected endpoint.
- **Smithery** (largest MCP marketplace) — publish the deployed URL with
  `smithery mcp publish <url> -n @you/relay` for discovery + an OAuth gateway, or
  distribute relay as a stdio bundle clients run locally.
- **Tunnel (optional, dev only)** — `cloudflared`/`tailscale` is *only* for
  exposing a NAT'd laptop; it's never required and not a relay dependency.

A hosted instance can't see your local files (so `codeFile`/local-image blocks
won't resolve there — pass URLs or inline content); run it on your own machine if
you need local-file access.

Progressive rendering: if the host streams the tool call as you write it, the
board renders valid blocks/questions incrementally (a "Composing…" preview) and
finalizes when your call completes — so the user sees it build, not a blank wait.

Both take **the exact same board spec** documented below (the tool `inputSchema`
*is* this spec). Call the tool with your spec; the host shows the board, the user
fills it in, and their answers come back to you (answers, per-question notes,
comment) — read them just as you would the CLI's result JSON. There is **no
`--detach`/`rly wait` dance, no stdout parsing, and no timeout** in this mode; the
board stays live until the user submits and the host delivers the result.

**Near-full parity with the browser board.** Local `codeFile` / `htmlFile` /
`diffFile` and local **image** files work inline too — the server inlines them
(images as data URIs) while normalizing your spec, so the sandboxed board needs
no file access. **Element-level annotations work inline** — the user can comment
on chart points, diagram nodes, table cells, images and text selections, returned
in `annotations` just like the CLI. The board also adopts the host's **theme,
fonts and colors** and uses the host's **full-screen** control. The only
inline-mode gaps vs. the browser board: **local video files** (use a
YouTube/Vimeo/`https` URL instead — those play) and commenting on elements
*inside* a custom-HTML mockup (every other annotation target works). Everything
else — questions plus markdown/code/diff/table/chart/mermaid/graphviz/plantuml/
image/palette/html — renders identically.

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
| `color`    | hex string (e.g. `"#c2674b"`) — native picker + hex field; optional `presets:["#…"]` swatches |

Aliases accepted: radio/choice/select→single, checkbox→multi,
boolean/bool/yn→yesno, input→text, longtext→textarea, rating/likert→scale,
colour/swatch→color.

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
- Keep option visuals **compact** — `"height"` ~140–260. They render inside the
  option card, under the label/description.
- Interacting with the visual (zoom, annotate, chart hover) never toggles the
  option; the label row is what selects. Option visuals stay fully annotatable.
- Use this whenever the choice has visual/example context; skip it for plainly
  textual options. It beats one big side-by-side comparison block because the
  selected visual is unambiguous.

### All block shapes

```jsonc
// Markdown — built-in mini renderer, no library. Headings, lists, code, quotes,
// links, and GFM pipe tables all render. For real tabular DATA use a `table`
// block instead (sortable + per-cell comments); markdown tables are display-only.
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

### Local file links — clickable, open in the default app

Inside any **markdown** (the intro or a `markdown` block) just write a local
file path — `~/clip.mp4`, `./src/app.ts`, `/abs/report.pdf`, a `file://` URL,
or a backtick-wrapped path — and it renders as a click-to-open link. Clicking it
asks relay to open that file in the user's OS default app (video player, editor,
viewer, …); a `[label](~/path)` link works too. Only paths you actually wrote on
the board can be opened (same-origin + allowlist guarded), so prefer surfacing a
real path over telling the user to paste it into a terminal.

### When to use which block

| Block | Best for |
|---|---|
| `mermaid` | flows, state machines, architecture overviews, sequence diagrams |
| `graphviz` | precise dependency graphs, call graphs, state machines when Mermaid's auto-layout falls short; individually annotatable nodes and edges |
| `plantuml` | UML diagrams (sequence, class, component) via server rendering; great for detailed interface contracts |
| `chart` | numbers, trends, comparisons, metrics |
| `table` | structured comparisons, option matrices, data grids — **use this for any tabular data**: it's sortable and every cell is commentable, unlike a markdown pipe table |
| `markdown` | prose context, background, instructions, section headings (renders GFM pipe tables too, but reach for a `table` block for real data) |
| `code` | code snippets, config examples, command output — syntax-highlighted + line-numbered; load from a file with `codeFile` |
| `diff` | proposed code changes / before-after — a unified diff rendered as a colored git-style comparison (no git needed) |
| `video` | demos, screen recordings, walkthroughs — YouTube/Vimeo embeds, a media URL, or a local video file (streamed) |
| `image` | screenshots, mockup exports, photos — local files embed and work offline |
| `palette` | color palettes / themes — swatch cards with hover-hex + click-to-copy; pair with a `color` question to let the user pick |
| `html` | anything else — pixel-perfect mockups, custom widgets, embeds |

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

### Custom HTML is hover-commentable automatically

Every custom-HTML block is annotatable out of the box — relay injects a tiny
runtime that lets the user **hover any meaningful element** (headings,
paragraphs, list items, buttons, images, cards, table cells…) to get a comment
pin, exactly like the rest of the board. You don't have to do anything. Comments
come back in `result.annotations` with `target.kind = "html-element"`, a stable
`target.ref` (the element), and a `target.label` derived from the element.

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

### A `timeout` on a detached board is NOT the end

For a **detached** board, the `timeout` deadline is *soft*: it hands you a
`timeout` result (with the autosaved draft) so you regain control, but the
server stays up and the board stays fully usable — the user can keep
commenting and still hit Submit. The page tells them you stopped waiting and
to prompt you afterward. So if you got a `timeout` and the user might still be
working: re-check later with `rly result <id>` (its status flips to
`submitted` once they finish), or pass `--on-result` so a late submit
push-wakes you. A blocking `rly ask` (no `--detach`) still ends hard on
timeout, since there's no separate waiter to hand back to.

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
