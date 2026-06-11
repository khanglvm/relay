# quest-board (`qbd`) — agent guide

Purpose: ask the human structured questions in a browser tab and/or show them a
custom-HTML visualization (prototype, diagram, mockup), then **wait for them to
click Submit** and read the answers as JSON from stdout. No "type 'done' in the
terminal", no hand-rolled HTML+server.

Everything machine-relevant is on **stdout as JSON**; human-facing logs go to
stderr. Exit codes: `0` submitted/acknowledged · `2` timeout · `3` cancelled ·
`4` usage error · `5` not found.

## Two execution patterns

**1. Blocking (simplest).** The command blocks until the user submits, then
prints the result JSON:

```sh
qbd ask --file spec.json --timeout 1800
```

**2. Detached (recommended when your shell tool has an execution time limit).**
Returns immediately with the board URL; collect later:

```sh
qbd ask --file spec.json --detach     # → {"status":"open","boardId":"b-…","url":"…"}
qbd wait b-xxxxx --timeout 3500       # blocks until submit, prints result JSON
qbd result b-xxxxx                    # non-blocking peek; while open it includes
                                      # the live autosaved draft of the user's answers
```

Answers **autosave in real time** as the user fills the board — a page reload
restores them, and a draft survives timeouts/cancellation (included in those
results), so partial input is never lost.

## Creating boards

From a JSON spec file (`--file spec.json`), stdin (`--file -`), or quick
inline questions:

```sh
qbd ask -q "Deploy to prod now?::yesno" -q "!Environment::single::dev,staging,prod"
#          label::type::comma,separated,options          leading "!" = required
```

Visualization-only (no questions; submit button reads "Acknowledge"):

```sh
qbd show --html-file prototype.html --title "Dashboard concept" --height 600
```

## Board spec (JSON)

```jsonc
{
  "title": "Feature direction",
  "intro": "Pick what we build next. Lines are preserved.",
  "html": "<h1>…</h1>",            // optional board-level visualization (or "htmlFile": "viz.html")
  "htmlHeight": 400,                // iframe height px (100–2400)
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
      "html": "<div style='display:flex;gap:8px'>…two mockups…</div>", "htmlHeight": 300 }
  ]
}
```

`qbd schema` prints the full JSON Schema.

### Question types → answer shapes

| type       | answer value in result            |
|------------|-----------------------------------|
| `single`   | `"value"` (Other → its text verbatim) |
| `multi`    | `["a","b"]` (Other text appended) |
| `yesno`    | `"yes"` \| `"no"`                 |
| `text`     | `"string"`                        |
| `textarea` | `"string"`                        |
| `scale`    | number (`min`…`max`, default 1–5) |

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
  "finishedAt": "2026-06-11T03:00:00.000Z",
  "durationMs": 42000
}
```

Unanswered questions are absent from `answers` and listed in `skipped`.
Questions with `"note": true` show a small optional free-text field; non-empty
notes come back in `notes` keyed by question id (use it where users may want
to qualify a choice). On `timeout`/`cancelled`, a `draft` field carries the
autosaved partial answers.

## Custom HTML visualization — sizing contract

- Rendered in a **sandboxed iframe** (`allow-scripts allow-forms allow-popups
  allow-modals`, **no** same-origin/parent access). Ship a self-contained HTML
  document: inline your CSS/JS; external CDN resources do load, but offline-safe
  inline is better.
- **Width: always 100% of the content column — up to ~820 px on desktop, as
  narrow as ~300 px on phones. Design responsively; don't assume fixed width.**
- **Height: fixed per block via `htmlHeight` (px, 100–2400). Default 400 for the
  board block, 360 for per-question blocks.** Content taller than that scrolls
  inside the iframe.
- **Fragments** (no `<html>` tag) are auto-wrapped in a minimal document whose
  background/text match the user's current theme — easiest path. **Full
  documents** are served verbatim (white canvas by default); they receive a
  `?theme=light|dark` query param (re-loaded on theme toggle) if they want to
  match the theme themselves.

## Managing boards

```sh
qbd list [--json]        # running boards (id, url, pid)
qbd open [id]            # re-open the browser tab of a running board
qbd reopen <id>          # serve a SAVED board again, prefilled with its saved
                         #   answers/draft; user can edit and resubmit
qbd reuse <id>           # re-run a past board as a NEW board (blank answers)
qbd spec <id>            # print a saved spec — edit it, then `qbd ask --file`
qbd history [--json]     # saved boards with statuses
qbd stop <id> | --all    # stop running board(s) → status "cancelled", draft kept
qbd rm <id> | --all      # delete saved board(s)
```

Multiple boards can run at once (each gets its own port on 127.0.0.1).
Storage lives in `~/.quest-board` (override with `QUEST_BOARD_HOME`).

## Tips for agents

- Prefer `--detach` + `qbd wait` if your shell tool kills long commands.
- Don't pass `--no-open` for real users — the browser tab opening *is* the
  notification. Use it only in tests.
- Quote JSON carefully; prefer writing a spec file or piping via `--file -`.
- Use stable `id`s on questions so your follow-up logic reads clean keys.
- `qbd result <id>` while a board is open returns the live draft — useful to
  check whether the user has started answering.
- Bundled universal skill (Claude Code, Codex, any SKILL.md-aware agent):
  `qbd skill install` — or `npx skills add khanglvm/quest-board`.
