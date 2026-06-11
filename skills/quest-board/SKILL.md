---
name: quest-board
description: Ask the user interactive questions in the browser (single/multi choice, yes-no, free text, scale) and/or present custom-HTML prototypes, then wait for Submit and read JSON answers. Use instead of built-in question tools when questions benefit from rich layout/visuals, when presenting a prototype or design idea for feedback, or when collecting several answers at once. Triggers - asking the user to choose between options or approaches, reviewing a UI mockup, gathering structured requirements, "show the user", "get feedback".
---

# quest-board (`qbd`)

CLI that opens a local web board for the user, blocks until they click
**Submit**, and prints their answers as JSON to stdout. Works for any agent
(Claude Code, Codex, …). Answers autosave in real time; the tab auto-closes
after submit.

If `qbd` is not installed: `npm i -g @khanglvm/quest-board` or invoke via
`npx -y @khanglvm/quest-board <command …>`.

**Full reference: run `qbd agent` (complete guide) and `qbd schema` (spec JSON
Schema).** The essentials are below.

## Choose a pattern

1. **Blocking** — simple, but your shell tool must tolerate waiting:

   ```sh
   qbd ask --file spec.json --timeout 1800   # prints result JSON when user submits
   ```

2. **Detached** — use when your shell tool has an execution time limit
   (e.g. run it, then wait in a separate call):

   ```sh
   qbd ask --file spec.json --detach    # → {"boardId":"b-…","url":…} immediately
   qbd wait b-xxxxx --timeout 3500      # blocks until submit, prints result JSON
   qbd result b-xxxxx                   # non-blocking peek (includes live draft)
   ```

Exit codes: 0 submitted · 2 timeout · 3 cancelled · 5 not found. On
timeout/cancel the result still contains the autosaved `draft` of partial
answers.

## Minimal spec

```json
{
  "title": "Pick the approach",
  "intro": "Context for the user.",
  "questions": [
    { "id": "approach", "type": "single", "label": "Which one?", "required": true,
      "options": [{ "value": "a", "label": "A", "description": "fast" }, "B"], "other": true },
    { "id": "parts", "type": "multi", "label": "Include?", "options": ["api", "ui"] },
    { "id": "ship", "type": "yesno", "label": "Ship now?" },
    { "id": "why", "type": "textarea", "label": "Reasoning?" },
    { "id": "conf", "type": "scale", "label": "Confidence", "min": 1, "max": 5 }
  ]
}
```

Types: `single`, `multi`, `yesno`, `text`, `textarea`, `scale`. Users may
submit with unanswered questions (returned in `skipped`) unless
`"allowPartial": false` or per-question `"required": true`.

Quick one-liners without a spec file:

```sh
qbd ask -q "Deploy now?::yesno" -q "!Env::single::dev,staging,prod"   # "!" = required
```

## Visualizing ideas (custom HTML)

- Board-level: `"html"` / `"htmlFile"` in the spec, or visualization-only:
  `qbd show --html-file proto.html --title "Concept" --height 600`
- Per-question: `"html"` / `"htmlFile"` on the question — e.g. show two mockups
  above a `single` choice.
- **Sizing contract:** sandboxed iframe; width = 100% of column
  (**~820 px max desktop, ~300 px min mobile — design responsively**);
  height fixed via `htmlHeight` px (100–2400; defaults 400 board / 360
  question). Self-contained HTML (inline CSS/JS). Fragments (no `<html>` tag)
  are auto-wrapped to match the user's theme; full documents are served
  verbatim and get a `?theme=light|dark` query param.

## Reuse & management

`qbd history` (saved boards) · `qbd spec <id>` (print spec to modify) ·
`qbd reuse <id>` (re-run blank) · `qbd reopen <id>` (re-open with saved
answers prefilled) · `qbd list` / `qbd open` / `qbd stop <id>` · `qbd rm <id>`.
Multiple boards can run concurrently.
