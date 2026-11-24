# Changelog

### 0.23.2: no browser tab under T3 Code or Sushi

Changed
- A new board no longer opens this Mac's browser when an agent runs Relay inside T3 Code
  (`T3CODE_THREAD_ID` or `T3CODE_HOME` set) or Sushi (`SUSHI_BOT_ID` or `SUSHI_HOME` set). The person
  drives those agents from another device and reads the board there, so the tab only covered the Mac's
  screen. `RLY_OPEN=1` or `RLY_OPEN=0` sets the default either way, and `--open` or `--no-open` still
  decides for one board.

### 0.23.1: a bad retention setting no longer leaves a stray board, and a tighter file check on Linux

Security
- The 0.23.0 check confirmed the opened file by walking its path again. Someone who can write inside a file
  root could swap a parent folder for a symlink to an outside folder, and back, between those steps, and the
  read would leave the roots. On Linux, Relay now also asks the kernel which file the descriptor holds
  (`/proc/self/fd`) and refuses any file outside the checked path. Node has no such call on macOS or Windows,
  so the race stays open there for a writer inside a root. Roots should hold only files you trust.

Fixed
- With `RLY_RETENTION_DAYS` or `retentionDays` set to something that is not a number of days, creating a
  board wrote the board file and then failed, so every retry left one more unanswered board behind. The
  setting is now checked first, and the error comes before anything is written.

### 0.23.0: boards expire after 30 days, and file reads cannot be redirected

Security
- A spec's local file was checked against the file roots and then read by name. A symlink swapped in between
  the check and the read could send the read outside the roots. Relay now opens the file once, refuses a final
  component that became a symlink, and reads through that open descriptor only after the path still resolves to
  the same file (device and inode) inside the roots. This covers every reader: `codeFile`, `mdFile`,
  `htmlFile`, `diffFile`, `rowsFile`, images, and the pdf, video, preview and content routes of the live server.
- A refused path used to print where it resolved to, which showed symlink targets and folder layout, and the
  message differed for a missing file, a folder and a path outside the roots. Every refusal now reads the
  same, names the path as the caller wrote it, and tells nothing about whether the path exists.

Added
- Retention: a board that has not changed for 30 days is removed, with its result file and artifacts, when a
  new board is created. A board whose server is still running is never removed. Change the window with
  `RLY_RETENTION_DAYS`, `rly mcp --retention-days N`, or `registerRelay(server, { retentionDays })`; `0`,
  `false` or `off` keeps every board. Processes that share one `RLY_HOME` sweep one at a time, at most once an
  hour. A custom `store` passed to `registerRelay` handles its own cleanup.

Fixed
- A board, its result file, its running record and the saved theme are written to a temp file and renamed, so
  a crash in the middle of a save no longer leaves a half-written file.
- A board inside a chat host (the MCP App iframe) came back empty after a reload, and four seconds later it
  overwrote the saved draft with the empty one. It now restores the answers, notes, comment, annotations and
  edited diagrams. The browser board already restored its draft.
- Streaming an empty file from a board's pdf, video or content route threw instead of answering.

Changed
- The error text for an unreadable spec file no longer carries "(resolved: ...)". It still contains the phrases
  "cannot read", "not a regular file" and "outside allowed roots", and the same `--root` hint.

### 0.22.2: file roots cannot change after a board is created

Security
- The board server listens on every interface, and it treated any request with a `Host: localhost` header
  as the owner. A caller on the same network could write that header, read the share links, turn sharing on,
  and preview, stream or open the board's files. The owner must now also connect from a loopback address.
- `/api/update` stored the `fileRoots` it was sent, so a caller holding the board's control token could widen
  the roots and stream any file through a pdf or video block. The server now keeps the roots the board was
  created with and refuses an update that carries `fileRoots`.
- `/api/open` launches a file's app on the board's machine, which runs a script or an `.app` bundle. Only the
  owner on that machine may call it now. A collaborator on a share link can still preview and stream files.
- `rly mcp` over stdio no longer takes its working directory as a file root when that directory is `/` or the
  home directory, which is where desktop hosts often start it. It prints a notice on stderr; pass
  `--root PATH` to allow a folder.

Changed
- `rly update` reads the new spec's files under the roots the board was created with, and `rly update --root`
  fails. To read files somewhere else, start a new board with `rly ask --root PATH`.
- `rly reuse` of a board saved before 0.22.1 keeps that board's authoring folder as its root, not the current
  working directory.

Boards started by 0.22.1 keep the old behaviour until they stop; `rly reopen` serves them with the new rules.

### 0.22.1: a spec can only read files under the file roots

Security
- A spec could name any local path (`codeFile`, `mdFile`, `htmlFile`, `diffFile`, `rowsFile`, image and
  pick tile `image`, `pdf`, `video`, git-conflict `file`) and Relay read it with no check. Over
  `rly mcp --http`, or in a server that mounts `registerRelay` over HTTP, any client with the token could put
  `~/.ssh/id_ed25519` in a spec and read it back through `relay_view` or the board page. Every read now goes
  through one resolver (`src/file-access.js`). It follows symlinks with realpath, and a path is read only when
  it lands inside a configured root. Directories and device files are refused. A refused path fails with
  "path outside allowed roots" and says how to fix it. The live board server applies the same roots to the
  files its page opens, previews and streams.
- Default roots: `rly ask` and `rly show` allow the working directory and the spec file's folder;
  `rly mcp` over stdio allows the working directory; `rly mcp --http` and `registerRelay` allow nothing.

Added
- `--root PATH` (repeatable) and `RLY_FILE_ROOTS` (paths separated by `:`) add roots to `rly ask`, `rly show`,
  `rly view`, `rly update` and `rly mcp`. `registerRelay(server, { fileRoots })` and `normalizeSpec(spec, { fileRoots })`
  take a list. `rly view` and `rly git conflict` also allow the folders of the files you name.

Migration
- If you run `rly mcp --http`, or mount `registerRelay` over HTTP, and your clients relied on local files
  (`codeFile`, local images and so on), pass roots now: `rly mcp --http --root /srv/shared` or
  `registerRelay(server, { fileRoots: ['/srv/shared'] })`. Without roots those specs fail with a spec error.
- Boards saved by an earlier version open files under their authoring folder only.

### 0.22.0 — the pick question and the A2UI board catalog

Added
- `pick` question: a grid of media tiles (image, video preview or link) with a title and optional
  caption. Choose one or several with `min` and `max`, and add a note to each pick and one overall
  note. The answer is `{picks: [{id, note?}], overall?}`, in the order picked. It works in the web
  board and the MCP App page, at phone width and from the keyboard. `rly schema pick` prints the fields.
- A2UI board catalog (`src/a2ui/board-catalog.json`): a whole board as one A2UI surface.
  `toA2ui(spec)` builds the messages and `fromA2ui(dataModel, spec)` turns the surface's data
  into the same result the web board stores, both from `@khanglvm/relay/a2ui-board`.
- `relay_view` returns A2UI messages to a host that lists the board catalog under
  `extensions.a2ui["1.0"].supportedCatalogIds`, or in a call's `_meta.a2ui`. Other hosts keep the
  iframe. Buttons come back through `a2ui_action`.
- `rly mcp --http --token-file PATH` reads the bearer token from a file. `--token` still works but
  shows in `ps`, so prefer the file or `RLY_MCP_TOKEN`.

Fixed
- Two servers starting together on a fresh relay home could end with different keys in `mcp-key`.
  The first to finish now wins and the other reads its key.

Changed
- `relay_ask` and `relay_show` stay as aliases. 0.21 said they would go in 0.22; that is moved to a later release.

### 0.21.0 — MCP server rebuilt on the official SDK

Breaking
- Node 20 or newer. The MCP server runs on `@modelcontextprotocol/server`, which needs it.
- One model-visible tool, `relay_board`, replaces `relay_ask` and `relay_show`. A spec with
  `questions` collects answers; one without is display-only. `relay_ask` and `relay_show` stay
  as aliases for one more minor version and are removed in 0.22.
- A tool result is a summary plus `structuredContent {boardId, mode, title, questions}` under
  2 KB. It no longer carries the spec. Read answers with `relay_result {boardId, wait_seconds}`.
- The board no longer sends its full answers to the chat as a message. It stores them with
  `relay_submit` and posts one line naming the board; the agent reads them with `relay_result`.
  A host that refuses app tool calls still gets the full transcript as the message.
- The tool list shrank from a 36 KB schema to under 4 KB: the input schema names the spec's
  top-level fields, and `relay_help {topic}` or `relay_help {schema}` returns exact shapes.

Added
- `relay_result` returns the answers, or the draft while the person is still filling the board in.
- App-only tools for the board iframe: `relay_view`, `relay_draft`, `relay_submit`, `relay_asset`
  and `a2ui_action`. They are listed only to a client that declares the MCP Apps extension.
  Each takes the board's token, an HMAC of the board id under a key kept in the relay home.
- `relay_asset` serves the chart, mermaid and graphviz libraries in chunks of at most 768 KiB, so
  a host that refuses `resources/read` still draws them.
- A button click in an a2ui block reaches the agent as it happens, through `a2ui_action`.
- `rly mcp --http` is served by the SDK's Streamable HTTP handler.
- The skill and guide say when to leave a question or result to the host's own UI and when to use Relay.
- `registerRelay(server, {store, assetUrl, linkUrl})` from `@khanglvm/relay/mcp` adds the tools
  to a server you built, with your own board store.

Migrating
- Call `relay_board` where you called `relay_ask` or `relay_show`.
- Run `rly mcp` under Node 20 or newer, and `npm i -g @khanglvm/relay` again to pick up the dependencies.

### 0.20.3 — shapes in the skill, lookups on demand

Changed
- The skill, `docs/AGENT.md` and `rly skill rules` list the JSON shape of every
  common block and question type, with a trigger line for `a2ui` (buttons and live
  status) and `checklist` (per-area sign-off). In a measured run with Sonnet this cut
  input tokens by 29% and left no failed first board. Their link advice names no host:
  `--public-url` and `--link-command` cover it.
- The error for `responseRequired:false` with questions says which of the two to remove.
  Chart errors say which field is missing and point to `rly schema chart`.

Added
- `rly schema <type>` prints the fields of one block or question type.
- `rly agent <topic>` prints one part of the guide: `questions`, `blocks`, `annotate`,
  `lifecycle`, `sharing`, `mcp` or `a2ui`. `rly agent` alone still prints all of it.
- A chart takes its kind from `chartType`, `chart_type` or the block type itself
  (`{"type":"bar", ...}`), and its series from Chart.js's `datasets`. A block type may
  be `md`, `img`, `diagram`, `flowchart`, `metrics`, `stats`, `widget`, `patch` or
  `swatches`, and a question may list `choices` for `options`.

Fixed
- A mermaid check that fails inside its own sandbox now reports an internal error and says the
  diagram was not checked. Before, it said "invalid mermaid syntax".
- `package-lock.json` carries the package version again (it said 0.20.0).

### 0.20.2 — mermaid diagrams pass the check again

- Valid mermaid diagrams open again in `rly ask`, `relay_ask` and `relay_show`.
  Since the syntax check arrived in 0.13.7 it refused any flowchart with a node
  or edge label, and most other diagram types (class, state, gantt, pie,
  gitGraph and more), with errors such as `Ro.addHook is not a function` or
  `TextEncoder is not defined`. Sequence and ER diagrams, and flowcharts of
  bare links such as `A --> B`, got through. A diagram with a real syntax error is still refused
  with the parser's message.

### 0.20.1 — generic link provider

- `--link-command CMD` (or `RLY_LINK_COMMAND`, or `rly config link command:CMD`)
  publishes a board through any command that takes the board's port and prints
  an https URL, as plain text or JSON with `url`. `RLY_LINK_RELEASE_COMMAND` runs
  when the board closes. `--devlink` keeps working as a shortcut for one such
  provider.
- Project docs and help text name no particular host or network.

### 0.20.0 — files split by feature

- No behaviour change. `src/cli.js`, `src/server.js`, `src/spec.js` and the
  browser files `blocks.js`, `app.js`, `annotate.js` and `mcp-ui/board.js` are now
  folders of small files. The served pages are byte-identical, checked against a
  stored capture (`test/golden`, `npm test`).
- `src/ui/manifest.js` is the one list of browser files that both page
  builders use.
- Deep imports of the old files (`src/spec.js`, `src/cli.js`, `src/server.js`)
  no longer resolve. They were already outside the `exports` map; use
  `@khanglvm/relay/spec` for the spec module.
- Tests moved to `test/unit` and `test/e2e`.

### 0.19.0 — a standard package

- Import Relay as a library: `createBoard`, `normalizeSpec`, `validateSpec`
  (returns `{ ok, errors }` instead of throwing) and `compileA2ui`, with
  TypeScript declarations. Subpath imports: `@khanglvm/relay/spec`, `/a2ui`,
  `/mcp`, and `/schema.json`.
- `schema/spec.v1.json` is the JSON Schema for a board spec. A spec can now
  carry `version: 1` and `$schema`; both are optional, and a spec without them
  is read as version 1. They also appear in `rly schema` and in the MCP tool
  input schema.
- `package.json` now has an `exports` map, so imports of files under `src/`
  such as `@khanglvm/relay/src/spec.js` stop working. Use the subpaths above.
- CI runs the type check, lint, tests, `npm pack --dry-run` and an install
  smoke test from a temp project. Node 24 joins the test matrix.
- No change to the CLI, the web board or the MCP output.

### 0.18.0 — private links and A2UI widgets

- Open a board on a phone or another computer: `--devlink` publishes it through
  the `devlink` command and prints a private https URL, and `--public-url` takes
  any https URL that reaches the board, with `{port}` for the board port. Set a
  default with `rly config link devlink`, or with `RLY_LINK` or `RLY_PUBLIC_URL`.
  `auto` uses `devlink` when it is installed and keeps the board local when it
  is not. Relay never prints a localhost URL as the link in this mode, and it
  removes the devlink route when the board closes.
- New `a2ui` block: a small live widget (status list, numbers, progress bar,
  buttons, short form) written in A2UI Express, which the official A2UI agent
  SDK compiles against a Relay catalog. Button clicks and input values return in
  `result.blockEdits[blockId]` and autosave with the rest of the board.
  Express that reaches `__proto__`, `constructor` or `prototype`, too much input,
  unknown components and bad values are refused before the board opens.
  Text is drawn as text, and links and images must be https.
- New `rly a2ui` prints the grammar, every component and examples. `docs/A2UI.md`
  is generated from the catalog by `scripts/gen-a2ui-doc.mjs`, and a test fails
  when it is out of date. `scripts/vendor-a2ui.mjs` rebuilds the bundled SDK.
- The agent guide, `rly agent` and the Relay skill cover both features.

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
