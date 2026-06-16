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

# enforce it (recommended) — a skill alone is an ignorable hint; append relay's
# short usage rules to your agent's global instructions (per-agent commands below)
rly skill rules
```

That's it. Next time your agent needs a decision or wants to show you a plan,
it opens a board like the ones above and waits for your Submit.

### Tell your agent to actually use it

`rly skill rules` prints relay's short usage rules. A skill is just an ignorable
hint — these rules in the file your agent *always* reads are what make it reach for
relay. Append them to your agent's **global** instructions:

```sh
rly skill rules >> ~/.claude/CLAUDE.md          # Claude Code
rly skill rules >> ~/.codex/AGENTS.md           # Codex
rly skill rules >> ~/.gemini/GEMINI.md          # Gemini CLI
rly skill rules >> ~/.config/opencode/AGENTS.md # OpenCode
```

Cursor and GitHub Copilot keep global rules in a settings panel, not a file — run
`rly skill rules` and paste the output into Cursor's *Settings → Rules → User Rules*
or Copilot's custom-instructions.

<details>
<summary>More agents</summary>

```sh
rly skill rules >> ~/.codeium/windsurf/memories/global_rules.md # Windsurf
rly skill rules >> ~/.factory/AGENTS.md                         # Droid (Factory)
```

Any other agent: run `rly skill rules` and paste the block into whatever file or
settings panel it reads as global instructions.
</details>

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
| `rly agent` | the full agent guide — spec format, all block types, annotations, patterns ([docs/AGENT.md](docs/AGENT.md)) |
| `rly schema` | board spec JSON Schema |
| [skills/relay/SKILL.md](skills/relay/SKILL.md) | the bundled skill |

## Development

```sh
npm test     # zero-dep smoke tests (spawns real servers, fake-submits)
```

## Changelog

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
