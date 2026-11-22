# Architecture

## Overview
An agent hands Relay a spec (JSON). `normalizeSpec` turns it into a stable shape, the store writes it to disk as a board, and one of three front ends shows it: the local web server, the MCP App page inside a chat host, or a file link. The user's answers return through the same path and are stored as the board's result, which the agent reads with `rly wait` or `rly result`.

```
agent -> rly ask / MCP relay_board -> normalizeSpec -> store (RLY_HOME/boards)
                                       |-> server/ -> browser board -> /api/submit -> store
                                       |-> mcp/      -> iframe board  -> relay_submit -> store
agent <- rly wait / rly result / MCP relay_result <- store
```

## Modules
- `src/spec/`: `pick.js` reads and cleans the `pick` question (tiles, limits, answer); `normalize.js` turns a spec into its normalized form; `blocks/` has one file per block type; `sources.js` reads `mdFile` and `rowsFile` text; `schema.js` holds `SPEC_SCHEMA`; `lookup.js` cuts one block or question type out of it for `rly schema <type>`; `ready.js` has `assertSpecReady`, the checks that need async work (mermaid syntax, A2UI Express). `index.js` is the barrel.
- `src/index.js`: the public library entry. It wraps `spec/`, `store.js` and `a2ui/compile.js`.
- `src/cli/`: one file per command (`ask`, `wait`, `share`, `git`, `boards`, `skill`, `install`, `upgrade`, `mcp`, `config`) and `index.js`, the router. `bin/rly.js` calls it. `agent-topics.js` cuts `docs/AGENT.md` into the topics `rly agent <topic>` prints.
- `src/server/`: `board.js` serves a board on a local port and handles `/api/*` (board, draft, submit, update, artifact, file open, file preview, share) with the access rules; `page.js` builds the page; `sanitize.js` cleans posted data; `files.js` opens and streams local files; `http.js`, `reviews.js`, `result.js` and `paths.js` hold the helpers.
- `src/mcp/`: the MCP server, built on the official SDK. `tools.js` has `registerRelay`, which adds `relay_board`, `relay_help`, `relay_result`, the app-only tools the iframe calls (`relay_view`, `relay_draft`, `relay_submit`, `relay_asset`, `a2ui_action`) and the `ui://relay/board` resource to any server. `boards.js` holds what each tool does to a board, `store.js` the pluggable store (files under `RLY_HOME` by default), `token.js` the per-board HMAC token, `page.js` the board page and vendor chunks, `serve.js` stdio and Streamable HTTP. The SDK loads when a server starts, so the plain CLI stays light.
- `src/file-access.js`: the one resolver for every local file a spec names. It takes realpath, requires the result to sit inside the configured roots and refuses directories and devices. Roots come from the entry point: the CLI uses the working directory, the spec file's folder, `--root` and `RLY_FILE_ROOTS`; `rly mcp` over stdio uses the working directory; HTTP and `registerRelay` use none unless `fileRoots` is given. A board record keeps its `fileRoots` for the live server.
- `src/store.js`: boards, results, running-server records and preferences under `RLY_HOME`.
- `src/link.js`: picks how a board gets a private https URL.
- `src/a2ui/`: the widget catalog, the compiler that checks widgets against it, and the vendored agent SDK. The board catalog (`board-catalog.json`, `board-constants.js`) is a separate catalog that describes a whole board as one A2UI surface: `to-a2ui.js` builds the messages, `from-a2ui.js` turns the surface's data model back into the answers a web board would store, and `negotiate.js` decides from declared capabilities whether a caller gets A2UI or the iframe. Only `extensions` survives in the MCP SDK's client capabilities, so a host declares it there or per call in `_meta`.
- `src/ui/`, `src/mcp-ui/`: browser code, split by feature (`ui/blocks/`, `ui/app/`, `ui/annotate/`, `mcp-ui/board/`). `ui/manifest.js` lists the files of each bundle in order; the server and `mcp/page.js` read them as text and inline them into one page.
- `src/file-preview.js`, `src/open.js`, `src/util.js`: file previews, the OS opener and small helpers.

## Data flow
1. `rly ask` normalizes the spec, creates a board record, then starts a server (or detaches one) and prints or opens the URL.
2. The page autosaves a draft to `/api/draft`. Submit posts the result to `/api/submit`, and the server saves it as the board's result file.
3. `rly wait` polls the store for the result and prints it. In MCP mode the iframe stores the result with `relay_submit`, posts a one-line message to the host, and the agent reads the result with `relay_result`.

## Boundaries
- Filesystem: `RLY_HOME` (default `~/.relay`) holds boards, results, running records and image artifacts.
- Network: the board server listens on all interfaces. Host checks and the owner and share rules in `server/board.js` decide who may use it. A public URL template or a link-provider command (`link.js`) gives a private link; `devlink` is one provider.
- Spec input is untrusted, and so is every path in it: local reads go through `file-access.js`. Sizes and key names are checked in `spec/` and `a2ui/compile.js` before a board opens.
- npm: published by `.github/workflows/npm-publish.yml` with trusted publishing.

## Decisions
- 2026-11-22: stay in JavaScript with JSDoc and `tsc --noEmit`, because a TypeScript source would need a build step or Node 22.6 or later for every `rly` user.
- 2026-11-22: publish an `exports` map and a generated JSON Schema, so other tools can import Relay and validate specs without reading `src/`.
