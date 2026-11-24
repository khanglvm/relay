---
name: relay
description: "Show the user files, visuals, diffs, plans, charts or a set of related questions on a Relay board and collect their answers and comments. Use when a decision needs visuals or several linked questions; simple one-off questions stay in chat."
---

# Relay (`rly`)

Put content in front of the person and read what they decide. Keep short answers and progress updates in chat. A board adds no approval step of its own; follow the authorization the user already gave.

If your host app has its own way to ask the user or show results (native question cards, forms, pickers), use that for those. Use Relay for what the host can't show: line comments on a diff, Mermaid or Graphviz diagrams, element comments on an HTML prototype, rich multi-block review boards.

## Workflow
1. Write a spec to a JSON file. Never pass big JSON in a shell argument.
2. `rly ask --file spec.json --detach` prints `{boardId,url}` at once. When no reply is needed: `rly show --file spec.json --display-only`.
3. Give the person the url. To get the result: `rly wait <boardId> --timeout 1800 --while-active --idle-grace 300` (blocks until submit) or `rly result <boardId>` (now). A timeout is not an answer: run `rly result` before you decide.
4. Read `answers`, `notes`, `comment`, `annotations` and `blockEdits` together; any of them can qualify an answer. When stdout is cut short, read the `resultFile` it names.

If Relay MCP tools are connected, call `relay_board` with the same spec (questions make it collect answers, none make it display-only) and the board renders inline. Then call `relay_result {boardId, wait_seconds: 50}` and repeat while it says `open`: answers collected that way need no chat message, which some hosts make the person confirm; `relay_help` gives exact fields. Embed file content with `mdFile`, `codeFile` or an image block, because inline boards cannot open local file links.

## Spec in one screen
```json
{
  "title": "Hero review",
  "intro": "Pick one. Click or drag on an image to comment.",
  "blocks": [
    {"type": "markdown", "md": "Short context."},
    {"type": "image", "src": "/abs/a.png", "alt": "A"}
  ],
  "questions": [
    {"id": "pick", "type": "single", "label": "Which one?", "required": true,
     "options": [{"value": "a", "label": "A", "description": "why"}, "B"]},
    {"id": "notes", "type": "textarea", "label": "Anything else?"}
  ]
}
```
- Question types: single multi yesno text textarea scale color rank checklist allocate pick.
- Blocks: markdown(md|mdFile) code(codeFile) diff(diffFile) image compare chart table kpi mermaid graphviz html palette video pdf a2ui. Local files: pass absolute paths.
- Blocks go at the board root, on a question, or on an option (visual choices).
- Every id is stable and unique. `required:true` only for answers you cannot continue without.
- A board with `questions` collects answers. One without is display-only.

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
{"id":"c","type":"single","label":"Scheme?","options":[{"value":"warm","label":"Warm","blocks":[{"type":"html","html":"<div style='height:100%;background:#c2674b'></div>","height":140}]}]}   // a visual per option
{"id":"hero","type":"pick","label":"Shortlist two","max":2,"items":[{"id":"a","title":"Warm","image":"/abs/a.png","caption":"Terracotta"},{"id":"b","title":"Demo","video":"https://example.com/b.mp4"},{"id":"c","title":"Ref","url":"https://example.com/c"}]}   // media tiles; answer {picks:[{id,note?}],overall?}; max 1 = single, min/max bound a multi
{"id":"s","type":"scale","label":"Rate","min":1,"max":5}   {"id":"col","type":"color","label":"Brand color"}   {"id":"ship","type":"yesno","label":"Ship?"}
```
Buttons inside a2ui do not replace a question. Their clicks return in `blockEdits`.

## Other operations
- Read a file or show a change: `rly view report.md --display-only`, `rly diff`. `rly git pick` and `rly git conflict` collect commit and hunk choices; apply only what the user chose.
- Continue a board: find it with `rly list` or `rly history`. `rly rescue <id>` reconnects a dropped tab, `rly reopen <id>` serves saved input again, `rly update <id> --file spec.json` changes a running board. Keep its id.
- A reader on a phone or another computer needs an https url. Pass `--public-url 'https://host:{port}'`, or `--link-command CMD` for any command that takes the port and prints an https URL. `rly config link` saves the choice. Give the person the printed url, never a localhost one.
- In a markdown block, `[label](/abs/path/file.js:98)` opens that file in a modal on the browser board.

## Need more? Load only the topic you need
`rly agent` lists topics: `questions`, `blocks`, `annotate`, `lifecycle`, `sharing`, `mcp`, `a2ui`. For example `rly agent blocks` before an unusual block. `rly schema chart` or `rly schema checklist` prints the exact fields of one block or question type, and `rly schema` prints them all.
