# quest-board

**Interactive question boards & HTML idea visualization for AI coding agents.**

`qbd` lets an AI agent (Claude Code, Codex, or anything that can run a CLI) ask
its user structured questions in a clean browser page — single/multi choice,
yes-no, free text, rating scales — and/or present a custom-HTML prototype, then
**block until the user clicks Submit** and read the answers as JSON. No more
"type *done* in the terminal", no more hand-rolled HTML + throwaway servers.

- ✅ Zero runtime dependencies — plain Node ≥ 18, vanilla HTML/CSS/JS UI
- ✅ Light/dark theme (auto + manual toggle), responsive, content-focused
- ✅ Real-time answer autosave (drafts survive timeout/cancel)
- ✅ Auto-closes the tab after submit and unblocks the CLI
- ✅ Custom HTML per board *and* per question (sandboxed iframes)
- ✅ Multiple boards at once, local history: reuse / modify / reopen / remove
- ✅ Agent-first: JSON on stdout, logs on stderr, `--detach` + `wait` for
  shell tools with execution time limits, built-in agent guide & skill

## Install

```sh
npm i -g @khanglvm/quest-board     # provides `qbd` (and `quest-board`)
# or per-invocation:
npx -y @khanglvm/quest-board help
```

## Quick start

```sh
# Quick inline questions ("!" = required, label::type::options)
qbd ask -q "Deploy to prod?::yesno" -q "!Environment::single::dev,staging,prod"

# Full board from a spec
qbd ask --file spec.json --timeout 1800

# Visualization-only (prototype/idea); submit button = "Acknowledge"
qbd show --html-file prototype.html --title "Dashboard concept" --height 600

# Non-blocking pattern (for agent tools with exec timeouts)
qbd ask --file spec.json --detach   # → {"boardId":"b-…","url":"http://127.0.0.1:…"}
qbd wait b-xxxxx                    # blocks until submit, prints result JSON
```

The browser opens automatically; the user answers and clicks **Submit**; the
CLI prints something like:

```json
{
  "status": "submitted",
  "boardId": "b-k3x9q2",
  "answers": { "q1": "yes", "q2": "staging" },
  "skipped": [],
  "comment": "ship it 🚀",
  "durationMs": 23000
}
```

## Board spec

```jsonc
{
  "title": "Feature direction",
  "intro": "Context shown under the title.",
  "html": "<h1>board-level visualization</h1>",   // or "htmlFile": "viz.html"
  "htmlHeight": 400,
  "allowPartial": true,        // user may submit with gaps (returned in "skipped")
  "note": true,                // optional free-text box → result "comment"
  "autoClose": true,           // tab closes itself after submit
  "questions": [
    { "id": "approach", "type": "single", "label": "Which approach?", "required": true,
      "options": [{ "value": "a", "label": "A", "description": "fast" }, "B"], "other": true },
    { "id": "scope",  "type": "multi",    "label": "Include?", "options": ["api", "ui", "docs"] },
    { "id": "ship",   "type": "yesno",    "label": "Ship this week?" },
    { "id": "name",   "type": "text",     "label": "Codename?", "placeholder": "falcon" },
    { "id": "notes",  "type": "textarea", "label": "Constraints?" },
    { "id": "conf",   "type": "scale",    "label": "Confidence?", "min": 1, "max": 5,
      "minLabel": "low", "maxLabel": "high",
      "html": "<p>per-question visualization works too</p>", "htmlHeight": 200 }
  ]
}
```

`qbd schema` prints the full JSON Schema; `qbd agent` prints the complete
agent-oriented guide (answer shapes, sizing contract, patterns).

### Custom HTML sizing contract

Custom HTML renders in a **sandboxed iframe** (`allow-scripts`, no parent
access): width is always **100% of the content column — ~820 px max on
desktop, ~300 px min on phones** (design responsively); height is fixed per
block via `htmlHeight` (100–2400 px, default 400 board / 360 question). The
iframe is loaded with `?theme=light|dark` so your HTML can match the theme.

## Commands

| Command | What it does |
|---|---|
| `qbd ask [--file spec.json \| --file - \| -q "…"]` | Create board, open browser, block until submit, print answers JSON |
| `qbd ask … --detach` | Don't block — print `{boardId,url}` immediately |
| `qbd show --html-file viz.html` | Visualization-only board (acknowledge) |
| `qbd wait <id> [--timeout s]` | Block until board finishes, print result |
| `qbd result <id>` | Result/status now — includes **live autosaved draft** while open |
| `qbd list [--json]` | Running boards |
| `qbd open [id]` | Re-open the browser tab of a running board |
| `qbd reopen <id>` | Serve a saved board again, **prefilled with saved answers** |
| `qbd reuse <id> [--dump]` | Re-run a past board as a new one (blank) |
| `qbd stop <id> \| --all` | Stop running board(s) — draft preserved |
| `qbd history [--limit n] [--json]` | Saved boards |
| `qbd spec <id>` | Print a saved spec (edit → `qbd ask --file`) |
| `qbd rm <id> \| --all` | Delete saved board(s) |
| `qbd schema` | JSON Schema of the spec |
| `qbd agent` | Full guide for AI agents |
| `qbd skill [install\|path]` | Bundled universal agent skill |

Common flags: `--title --intro --html-file --height --submit-label
--timeout <sec> --port <n> --no-open --detach`.

Exit codes: `0` submitted/acknowledged · `2` timeout · `3` cancelled ·
`4` usage · `5` not found.

Storage: `~/.quest-board` (override with `QUEST_BOARD_HOME`). Boards bind to
`127.0.0.1` only.

## Agent skill (Claude Code, Codex, …)

A universal [SKILL.md](skills/quest-board/SKILL.md) is bundled:

```sh
qbd skill install                  # auto-installs into ~/.claude/skills and ~/.codex/skills
qbd skill install --target claude  # or codex | both | <custom dir>
npx skills add khanglvm/quest-board  # via the skills installer, straight from this repo
```

`qbd help` and `qbd agent` also point agents at the skill, so an agent that
merely has the CLI installed can discover and self-install it.

## Development

```sh
npm test     # zero-dep smoke tests (spawns real servers, fake-submits)
```

## License

[MIT](LICENSE) © Le Vu Minh Khang
