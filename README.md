# relay

**The relay between AI agents and humans — browser boards instead of terminal walls.**

`rly` is a CLI that lets your AI agent ask questions and present work in a
local browser board — real forms, charts, diagrams, sortable tables, images,
and live prototypes instead of terminal text and ASCII art. You click, comment
on any element, and Submit; the agent gets your answers and comments back as
JSON and keeps working.

## See it

A real board from a real session — an agent presenting three animated UI
prototypes, asking which to build, expanding one full-screen, and getting the
answers on Submit:

![relay demo — animated prototypes, picking an option, full-screen, submit](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/demo.gif)

| Light theme | Dark theme |
|---|---|
| ![relay board light theme](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/board-light.png) | ![relay board dark theme](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/board-dark.png) |

| Annotation popover | Mobile |
|---|---|
| ![Annotation comment on a chart bar](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/annotations.png) | ![Mobile view at 375px](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/mobile.png) |

## Quick start

```sh
npm i -g @khanglvm/relay                  # the rly CLI
npx -y skills add khanglvm/relay -g -y    # the agent skill (Claude Code, Codex, Cursor, …)
rly skill rules >> ~/.claude/CLAUDE.md    # optional: skills are ignorable hints — this enforces usage (or >> AGENTS.md)
```

That's it. Next time your agent needs a decision or wants to show you a plan,
it opens a board like the ones above and waits for your Submit.

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

## Migration from quest-board

relay was formerly `@khanglvm/quest-board` (CLI: `qbd`) — that package is
deprecated. Storage moved from `~/.quest-board` to `~/.relay` (override with
`RLY_HOME`); legacy `"html"` / `"htmlFile"` spec fields keep working.

## License

[MIT](LICENSE) © Le Vu Minh Khang
