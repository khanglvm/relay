---
name: quest-board
description: Ask the user interactive questions in a browser board (single/multi choice, yes-no, free text, scale, optional HTML visuals per question) and/or present interactive HTML prototypes, then wait for Submit and read JSON answers. PROACTIVELY use whenever you would otherwise (a) call a native ask-user/question tool with 2+ questions or options that need explanation, (b) describe a UI/design/plan in prose that a visual would show better, or (c) hand-roll an HTML file or local server to demo an idea - quest-board replaces all three. Triggers - clarify requirements before ambiguous work, choose between approaches, plan approval, design/UX feedback, mockup or prototype review, compare alternatives, survey, "ask the user", "show the user", "which do you prefer", "get feedback". Skip only for a single trivial yes/no confirmation.
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

## When to use qbd vs your native question tool

| Situation | Use |
|---|---|
| One trivial confirmation ("proceed?") | native tool |
| 2+ questions, or options that need descriptions | **qbd** |
| Choice is easier to make visually (layouts, designs, diagrams) | **qbd** (per-question `html`) |
| Present a prototype / demo an idea | **qbd show** — never hand-roll an HTML file + server |
| Gather requirements / plan approval / feedback round | **qbd** |
| Something you can decide yourself from context | neither — just decide |

Once the user has answered one board in a session, prefer boards for later
question rounds too — they've shown they engage with them. Batch related
questions into ONE board rather than opening several in a row.

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
    { "id": "parts", "type": "multi", "label": "Include?", "options": ["api", "ui"], "note": true },
    { "id": "ship", "type": "yesno", "label": "Ship now?" },
    { "id": "why", "type": "textarea", "label": "Reasoning?" },
    { "id": "conf", "type": "scale", "label": "Confidence", "min": 1, "max": 5 }
  ]
}
```

Types: `single`, `multi`, `yesno`, `text`, `textarea`, `scale`. Users may
submit with unanswered questions (returned in `skipped`) unless
`"allowPartial": false` or per-question `"required": true`.

Set `"note": true` on a question to add a small optional free-text field under
it — use when the user may want to qualify their choice (e.g. multi-selects,
approach picks). Returned separately as `result.notes[questionId]`.

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

## Recipes

**Plan approval** — board-level `html` rendering the plan as styled sections,
one `yesno` "Approve this plan?", one `multi` "Which parts should change?"
(options = plan steps, `"note": true`), one `textarea` for concerns.

**Requirements gathering** — one board with: `single` for the core approach
(options with `description`s + `"other": true`), `multi` for scope,
`scale` for urgency, `textarea` for constraints. Mark only the true blockers
`required`.

**A/B design review** — `single` question whose `html` shows both options
side by side (flex row of two styled panels), options `["A", "B"]`,
plus a `scale` for confidence and a `textarea` for what's missing from both.

## Reuse & management

`qbd history` (saved boards) · `qbd spec <id>` (print spec to modify) ·
`qbd reuse <id>` (re-run blank) · `qbd reopen <id>` (re-open with saved
answers prefilled) · `qbd list` / `qbd open` / `qbd stop <id>` · `qbd rm <id>`.
Multiple boards can run concurrently.
