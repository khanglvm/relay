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

# enforce it (recommended) — a skill alone is an ignorable hint; `rly install`
# writes relay's usage rules into the file each agent reads (run `rly install`
# with no args to see every supported target and where it lands):
rly install --all          # every agent detected on this machine
```

That's it. Next time your agent needs a decision or wants to show you a plan,
it opens a board like the ones above and waits for your Submit.

Keep relay current with **`rly upgrade`** — it installs the latest CLI and
refreshes the skill (via `npx skills`, falling back to the bundled copy) in one
step, leaving any boards you have open untouched.

## Inside the Claude & Codex apps (MCP App)

relay also runs as an **MCP App** ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp))
— so the same board renders **inline, right in the conversation**, on Claude
desktop **and mobile** and in Codex, no browser tab. `rly mcp` is a
stdio MCP server with no npm runtime dependencies; register it once and the agent gets two tools,
`relay_ask` (collect decisions/feedback with real form controls) and
`relay_show` (present a plan, diagram, diff, table, or prototype):

```sh
# Claude Code
claude mcp add relay -- rly mcp

# Claude Desktop / Codex — write the host config for you
rly mcp install --target claude     # claude_desktop_config.json
rly mcp install --target codex      # ~/.codex/config.toml

# or print the snippet for any MCP host (incl. the raw JSON/TOML)
rly mcp config
```

When the agent calls a relay tool, the host renders relay's `ui://relay/board`
resource in a sandboxed iframe, hands it the board spec, and the user's answers
flow back to the agent as a `ui/message` user turn, with
`ui/update-model-context` used as a best-effort structured context sync —
markdown, code, diffs, tables, charts, mermaid/graphviz diagrams, images, and
forms, all in-chat. The classic browser board (`rly ask` / `rly show`) is
unchanged; pick whichever surface fits.

## What it improves

| Without relay | With relay |
|---|---|
| Six questions asked one at a time in the terminal | One board, all questions, real form controls, optional "Other" + notes |
| "Option B is the one with caching (see my last message)" | Each answer option carries its own image / chart / diagram — pick by looking |
| ASCII architecture art | Mermaid, Graphviz, PlantUML — zoomable, full-screen, even user-editable |
| Numbers buried in prose | Charts and sortable tables; screenshots and HTML prototypes in a sandbox |
| "Here's the diff — paste it in your editor" | Side-by-side **diff** blocks, syntax-highlighted **code**, **video** walkthroughs, and **file paths you click to open** in the default app |
| "Which commits should I pick? Resolve this conflict manually." | `rly git pick` / `rly git cherry-pick` boards and color-coded `git-conflict` resolvers with ours/theirs/custom hunk choices |
| "Type *done* when finished reviewing" | A Submit button; answers, notes, and inline comments returned as JSON |
| Feedback = another wall of text | Click any chart point, diagram node, table cell, or sentence to comment — the agent replies and the thread grows on the board |

Everything autosaves in real time, detached board links keep serving after
agent timeouts, multiple boards run at once, and the package has **zero npm
runtime dependencies** — plain Node ≥ 18. Browser-side Chart.js, Mermaid, and
Viz.js assets are vendored in the package and lazy-loaded offline when a board
actually needs them.

## Learn more

| | |
|---|---|
| `rly help` | every command at a glance |
| `rly git pick` / `rly git cherry-pick` | choose commit actions and rank the order directly on a board; add `--code` to cherry-pick with split code review and per-hunk Apply/Skip/Hold |
| `rly git conflict [files…]` | auto-detect unmerged conflict files, or open specific local paths, and return resolved content in `result.blockEdits` |
| `rly share <board-id>` | activate/list/revoke same-Wi-Fi reviewer or collaborator links for a running browser board |
| `rly view <file.md> …` | open a quick read-only board that renders local markdown file(s), data files, or PDFs — library-free; great for plans, READMEs, reports, quotes |
| `rly install --target <agent>` | write relay's rules into an agent's instruction file — `claude` `codex` `cursor` `copilot` `kiro` `windsurf` `cline` `gemini` `opencode` `droid` `agents`; `--all`, `--scope`, `--print`, `--list` |
| `rly upgrade` | update the CLI **and** refresh the skill in one step (safe around open boards; `--dry-run`, `--cli-only`, `--skill-only`) |
| `rly mcp` | run relay as an MCP App server so boards render **inline** in the chat — **stdio** for local desktop hosts (Claude Desktop, Codex), or `rly mcp --http` (Streamable HTTP) for web/mobile/remote; `rly mcp config` / `rly mcp install --target claude\|codex` to register it |
| `rly agent` | the full agent guide — spec format, all block types, annotations, patterns ([docs/AGENT.md](docs/AGENT.md)) |
| `rly schema` | board spec JSON Schema |
| [skills/relay/SKILL.md](skills/relay/SKILL.md) | the bundled skill |

## Development

```sh
npm test     # smoke tests with no external services (spawns real servers, fake-submits)
```

## Changelog

### 0.11.0 — render inline inside the Claude & Codex apps (MCP App)
- **`rly mcp` — relay as an MCP App** ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp),
  extension `io.modelcontextprotocol/ui`). A stdio MCP server with no npm runtime dependencies
  that declares a `ui://relay/board` resource (`text/html;profile=mcp-app`) and
  two tools, **`relay_ask`** and **`relay_show`**, linked to it via
  `_meta.ui.resourceUri` (plus `openai/outputTemplate` for ChatGPT/Codex). The
  host renders the board **inline in the conversation** — Claude desktop **and
  mobile**, Codex — instead of opening a browser tab.
- **Same board, postMessage transport.** The inline board reuses relay's block
  renderer (markdown, code, diff, table, chart, mermaid, graphviz, image, html)
  over the MCP Apps JSON-RPC bridge: the spec arrives as the tool result, the
  user's submit goes back via `ui/message` so the agent resumes, the structured
  payload is also offered through `ui/update-model-context`, the iframe
  auto-sizes via `ui/notifications/size-changed`, and vendored Chart.js /
  Mermaid / Viz.js load on demand through the host's `resources/read` (no
  `/vendor` route, no server in the sandbox).
- **One-command setup** — `rly mcp install --target claude|codex` writes the
  host config; `rly mcp config` prints the snippet for any MCP host. The classic
  browser board is untouched.
- **Streamable HTTP transport for web/mobile/remote** — `rly mcp --http
  [--port N --host H --token SECRET --allow-origin ORIGIN]` serves the same tools
  over MCP's Streamable HTTP transport (single `/mcp` endpoint, JSON responses,
  CORS, Origin validation, bearer auth, `Mcp-Session-Id`, `$PORT`-aware). relay is
  **stateless**, so one instance serves everyone — deploy it once with the repo
  **`Dockerfile`** on any free MCP host (mcpdeploy.dev, mcphosting.io,
  Render/Railway/Fly, Glama) or publish to **Smithery**, then add the URL as a
  custom connector. Only the relay CLI is required — no tunnel/tailscale. stdio
  stays the zero-setup path for local desktop.
- **Native look** — the inline board **color-blends** onto the host's SEP-1865
  style variables (surfaces, text, borders, primary button, fonts), pins
  `color-scheme` so `light-dark()` tokens resolve, and uses the host's **own
  full-screen** control (centering content to a readable column in fullscreen).
  After submit it collapses to a one-line confirmation so the iframe shrinks.
- **Progressive rendering** — when the host streams the tool call
  (`ui/notifications/tool-input-partial`), the board renders valid blocks as they
  arrive (a "Composing…" preview) instead of waiting for the whole spec.
- **`palette` block** — color palettes as swatch cards (hover reveals hex, click
  copies); mark one `featured` for a spotlight. **`color` question type** — native
  picker + hex field + optional `presets`, returns a hex string. Both work on the
  browser board and inline.
- **Element annotations inline** — comment on chart points, diagram nodes, table
  cells, images and text selections in the MCP board too, returned in
  `annotations` exactly like the CLI board.

### 0.10.0 — open files, richer code, diffs & video
- **Clickable local file-links.** Write a path in any markdown (`~/clip.mp4`,
  `./src/app.ts`, `/abs/report.pdf`, a `file://` URL, a backtick-wrapped path,
  or `[label](path)`) and it renders as a link that opens the file in the OS
  default app — guarded by a same-origin check + an allowlist of paths the
  board actually references. `RLY_OPEN_CMD` overrides the opener.
- **`code` blocks leveled up** — syntax highlighting for ~20 languages (js, ts,
  py, go, rust, java, c, cpp, csharp, ruby, php, swift, kotlin, sql, yaml, json,
  sh, css, html…), a line-number gutter, a filename/lang header, and `codeFile`
  to load source straight from a local file.
- **`diff` block** — render a unified git diff as a colored, line-numbered
  comparison with a live **Unified ⇄ Split (side-by-side)** toggle. No git
  required; the agent supplies the diff text (`diff`/`diffFile`, `view`).
- **`video` block** — YouTube/Vimeo embeds, a direct media URL, or a local
  video file streamed from the server with HTTP Range (seekable), never
  embedded in the payload.
- **`pdf` block** — render local `.pdf` files or PDF URLs inline. Local PDFs
  stream from the board server and are never embedded in the page payload.
- **Durable boards / rescue** — detached boards keep serving after timeout
  until Submit or `rly stop`; every autosave mirrors to `localStorage`; a board
  whose connection drops blocks further input instead of losing it, and
  `rly rescue <id>` re-serves on the same port so an open tab reconnects. Active
  same-Wi-Fi share links stay tied to the board and survive a same-port re-serve
  until revoked.
- Still **zero npm runtime dependencies**, offline, and cross-platform. Vendored
  browser libraries are loaded only for boards that need them.

### 0.9.1
- The board **intro renders as markdown** (bold/italic/code/links/lists).

### 0.9.0 — interactive visual annotations
- Drag/zoom/full-screen viewer, per-element **and** whole-block comments, chart
  data-point comment badges, and inline-SVG PlantUML rendering.

### 0.8.1
- `rly install` adds **OpenCode** (`~/.config/opencode/AGENTS.md`) and **Droid /
  Factory** (`~/.factory/AGENTS.md`) targets.
- README documents `rly install` and `rly upgrade`.

### 0.8.0 — install into any agent
- **`rly install --target <agent>`** writes relay's usage rules into the right
  file for Claude Code, Codex, Cursor, GitHub Copilot (VS Code / Visual Studio /
  JetBrains), Kiro, Windsurf, Cline, Gemini, or the generic `AGENTS.md` —
  cross-platform (macOS / Linux / Windows), idempotent, with `--all`, `--scope`,
  and `--print`.
- Fixed `rly skill install` crashing when the target skill dir was a symlink.

### 0.7.0 — sturdier boards, self-update
- **Markdown blocks render GFM tables**; element comments moved to an
  Outline-style right sidebar with inline highlights on commented text.
- **Seamless timeouts** — a detached board that runs past its deadline keeps
  serving until Submit or explicit stop, so you can still submit (it lands as
  `submitted`); the page shows a calm note instead of disconnecting.
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
