# Architecture

## Overview
An agent hands Relay a spec (JSON). `normalizeSpec` turns it into a stable shape, the store writes it to disk as a board, and one of three front ends shows it: the local web server, the MCP App page inside a chat host, or a file link. The user's answers return through the same path and are stored as the board's result, which the agent reads with `rly wait` or `rly result`.

```
agent -> rly ask / MCP relay_ask -> normalizeSpec -> store (RLY_HOME/boards)
                                       |-> server.js -> browser board -> /api/submit -> store
                                       |-> mcp.js    -> iframe board  -> ui/message  -> agent
agent <- rly wait / rly result <- store
```

## Modules
- `src/spec.js`: validates and normalizes a spec, reads `mdFile` and `rowsFile` sources, and holds `SPEC_SCHEMA`. `assertSpecReady` adds the checks that need async work (mermaid syntax, A2UI Express).
- `src/index.js`: the public library entry. It wraps `spec.js`, `store.js` and `a2ui/compile.js`.
- `src/cli.js`: parses arguments and runs each command. `bin/rly.js` calls it.
- `src/server.js`: serves a board on a local port, builds the page, handles `/api/*` (board, draft, submit, update, artifact, file open, file preview, share) and the share and access rules.
- `src/mcp.js`: JSON-RPC over stdio or Streamable HTTP. Declares the `ui://relay/board` resource and the `relay_ask` and `relay_show` tools.
- `src/store.js`: boards, results, running-server records and preferences under `RLY_HOME`.
- `src/link.js`: picks how a board gets a private https URL.
- `src/a2ui/`: the widget catalog, the compiler that checks widgets against it, and the vendored agent SDK.
- `src/ui/`, `src/mcp-ui/`: browser code. The server and `mcp.js` read these files as text and inline them into one page.
- `src/file-preview.js`, `src/open.js`, `src/util.js`: file previews, the OS opener and small helpers.

## Data flow
1. `rly ask` normalizes the spec, creates a board record, then starts a server (or detaches one) and prints or opens the URL.
2. The page autosaves a draft to `/api/draft`. Submit posts the result to `/api/submit`, and the server saves it as the board's result file.
3. `rly wait` polls the store for the result and prints it. In MCP mode the iframe sends the result back to the host as a user message.

## Boundaries
- Filesystem: `RLY_HOME` (default `~/.relay`) holds boards, results, running records and image artifacts.
- Network: the board server listens on all interfaces. Host checks and the owner and share rules in `server.js` decide who may use it. `devlink` or a public URL template gives a private link.
- Spec input is untrusted: sizes and key names are checked in `spec.js` and `a2ui/compile.js` before a board opens.
- npm: published by `.github/workflows/npm-publish.yml` with trusted publishing.

## Decisions
- 2026-11-22: stay in JavaScript with JSDoc and `tsc --noEmit`, because a TypeScript source would need a build step or Node 22.6 or later for every `rly` user.
- 2026-11-22: publish an `exports` map and a generated JSON Schema, so other tools can import Relay and validate specs without reading `src/`.
