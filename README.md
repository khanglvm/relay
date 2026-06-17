# relay

**The relay between AI agents and humans — browser boards instead of terminal walls.**

`rly` is a CLI that lets your AI agent ask questions and present work in a
local browser board — real forms, charts, diagrams, sortable tables, images,
and live prototypes instead of terminal text and ASCII art. You click, comment
on any element, and Submit; the agent gets your answers and comments back as
JSON and keeps working.

## See it

**The whole loop** — your agent asks in the terminal, a board opens in your
browser; you pick a style, expand the chart, comment on a data point, leave a
note, Submit — and the agent picks up your answers and keeps going:

![Full flow: Claude Code opens a relay board, the user answers, comments and submits, the agent continues](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/demo.gif)

## Quick start

```sh
# the rly CLI
npm i -g @khanglvm/relay

# the agent skill → every detected agent (Claude Code, Codex, Cursor, …)
npx skills add khanglvm/relay --skill relay --all

# enforce it (recommended) — a skill alone is an ignorable hint. `rly install`
# writes relay's short usage rules into the right file for each agent (details below):
rly install --all          # every agent detected on this machine
```

That's it. Next time your agent needs a decision or wants to show you a plan,
it opens a board like the ones above and waits for your Submit.

Keep relay current with **`rly upgrade`** — it installs the latest CLI and
refreshes the skill in one step, leaving any boards you have open untouched.

### Tell your agent to actually use it

A skill is just an ignorable hint — relay's short usage rules in the file your
agent *always* reads are what make it reach for relay. **`rly install` writes
those rules into the right file for each agent**, cross-platform (macOS / Linux /
Windows):

```sh
rly install --all                # every agent detected on this machine
rly install --target claude      # → ~/.claude/CLAUDE.md
rly install --target cursor      # → .cursor/rules/relay.mdc (with frontmatter)
rly install --target copilot     # → .github/copilot-instructions.md (+ JetBrains global)
rly install                      # no target: print the agent → file map for your OS
```

Supported targets: `claude`, `codex`, `cursor`, `copilot` (VS Code / Visual Studio /
JetBrains), `kiro`, `windsurf`, `cline`, `gemini`, `opencode`, `droid` (Factory), and
the generic `agents` (`AGENTS.md`). Flags: `--scope global|project` (where the rules
land), `--print` (emit the text + resolved path for manual copy/paste), `--list`.
relay's block is marker-delimited and idempotent — re-running updates only that block
and leaves the rest of your file alone.

Using an agent that isn't listed? `rly skill rules` prints the block to paste into
whatever file or settings panel it reads — e.g. Cursor's *Settings → Rules → User
Rules* or Copilot's custom instructions (their *user-level* rules aren't file-based).

## What it improves

| Without relay | With relay |
|---|---|
| Six questions asked one at a time in the terminal | One board, all questions, real form controls, optional "Other" + notes |
| "Option B is the one with caching (see my last message)" | Each answer option carries its own image / chart / diagram — pick by looking |
| ASCII architecture art | Mermaid, Graphviz, PlantUML — zoomable, full-screen, even user-editable |
| Numbers buried in prose | Charts and sortable tables; screenshots and HTML prototypes in a sandbox |
| "Type *done* when finished reviewing" | A Submit button; answers, notes, and inline comments returned as JSON |
| Feedback = another wall of text | Click any chart point, diagram node, table cell, or sentence to comment — the agent replies and the thread grows on the board |

Everything autosaves in real time (drafts survive timeouts), multiple boards
run at once, and the package has **zero runtime dependencies** — plain
Node ≥ 18; Chart.js / Mermaid / Graphviz are vendored and lazy-loaded offline.

## Learn more

| | |
|---|---|
| `rly help` | every command at a glance |
| `rly install --target <agent>` | write relay's rules into an agent's instruction file — `claude` `codex` `cursor` `copilot` `kiro` `windsurf` `cline` `gemini` `opencode` `droid` `agents`; `--all`, `--scope`, `--print`, `--list` |
| `rly upgrade` | update the CLI **and** refresh the skill in one step (safe around open boards; `--dry-run`, `--cli-only`, `--skill-only`) |
| `rly agent` | the full agent guide — spec format, all block types, annotations, patterns ([docs/AGENT.md](docs/AGENT.md)) |
| `rly schema` | board spec JSON Schema |
| [skills/relay/SKILL.md](skills/relay/SKILL.md) | the bundled skill |

## Development

```sh
npm test     # zero-dep smoke tests (spawns real servers, fake-submits)
```

## Changelog

### 0.8.0 — install into any agent
- **`rly install --target <agent>`** writes relay's usage rules into the right
  file for Claude Code, Codex, Cursor, GitHub Copilot (VS Code / Visual Studio /
  JetBrains), Kiro, Windsurf, Cline, Gemini, OpenCode, Droid (Factory), or the
  generic `AGENTS.md` — cross-platform (macOS / Linux / Windows), idempotent,
  with `--all`, `--scope`, and `--print`.
- Fixed `rly skill install` crashing when the target skill dir was a symlink.

### 0.7.0 — sturdier boards, self-update
- **Markdown blocks render GFM tables**; element comments moved to an
  Outline-style right sidebar with inline highlights on commented text.
- **Seamless timeouts** — a detached board that runs past its deadline keeps
  serving so you can still submit (it lands as `submitted`); the page shows a
  calm note instead of disconnecting.
- **`rly upgrade`** — install the latest CLI and refresh the skill in one step.
- Per-question notes are multi-line textboxes.

### 0.6.0 — comment on anything
- **Comment on any part of a custom-HTML mockup.** Hover any element — a heading,
  a button, a card, the price — and a pin appears to leave an inline note. No
  setup needed; the agent writes zero annotation code. Want to scope it? Mark
  specific elements with `data-relay-annotate="label"`.
- **Radio questions can carry a note.** Pick an option *and* say why, in one
  optional field — now shown by default (set `"note": false` to hide it).
- **Edge-to-edge fullscreen** for charts and HTML mockups, with the toolbar
  pinned to the top while you scroll.
- The board **title and intro are commentable** too.

### 0.5.0
- Visual answer options, image blocks, viewer redesign, adoption rules.

## Migration from quest-board

relay was formerly `@khanglvm/quest-board` (CLI: `qbd`) — that package is
deprecated. Storage moved from `~/.quest-board` to `~/.relay` (override with
`RLY_HOME`); legacy `"html"` / `"htmlFile"` spec fields keep working.

## License

[MIT](LICENSE) © Le Vu Minh Khang
