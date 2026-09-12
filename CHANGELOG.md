# Changelog

### 0.16.1 — reliable area-comment zones

- Primary drag now draws a comment area directly on image and comparison views;
  **Area** remains as a visible one-shot lock. Image pan uses Space-drag or the
  middle button, while the comparison divider moves only from its handle.
- The selected rectangle remains visible while its comment is composed. Saved
  zones carry a comment icon plus count, reopen for add/edit/delete, and disappear
  automatically when their final comment is removed.

### 0.17.0 — file reference previews

- Local source references now resolve `:line[:column]` and `#Lstart-Lend` and
  open in a keyboard-accessible modal at the cited lines.
- Preview Markdown, source/config/logs, CSV/TSV, static sandboxed HTML, images,
  PDFs, and browser-compatible audio/video. Text is bounded to 1 MiB/20,000
  lines; unsupported files retain an explicit **Open in app** fallback.
- Shorter agent skill and installed instructions, with clear display-only,
  feedback, file-preview, and existing-board workflows.

### 0.16.0 — native viewer chrome, area comments, and durable agent waits

- Viewer toolbars now use browser-native sticky positioning instead of a
  scroll-event counter-translation; open comment composers re-anchor on scroll
  and preserve unsaved per-target drafts.
- Hold then drag on an image to comment on an exact rectangular area. Relay
  saves the crop beside the browser-board record and returns its path; comparison
  crops also identify and capture the selected Before/After source.
- Browser boards support `responseRequired:false` / `--display-only`; inline
  `relay_show` is display-only by default. Board and waiter deadlines now default
  to one day (`--timeout 0` removes Relay's deadline), with client-specific
  background/polling guidance in the agent docs.

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
  until revoked. Reviewer submissions are isolated, reference-only side reviews
  that never finish the owner's board; read-only links cannot mutate feedback.
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
