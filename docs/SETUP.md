# Relay setup

[Back to the README](../README.md)

## Agent instructions

Install the CLI and bundled skill:

```sh
npm i -g @khanglvm/relay
npx skills add khanglvm/relay --skill relay --all
```

To add Relay usage rules to an agent's instruction file:

```sh
rly install --target codex
```

Run `rly install` to list supported targets and paths. Use `--all` for all
detected agents, `--scope project` for project instructions, or `--print`
to inspect the rules first.

`rly upgrade` updates the CLI and refreshes the skill, leaving open boards
running. It supports `--dry-run`, `--cli-only`, and `--skill-only`.

## Boards inside a chat app

Relay can serve boards through MCP Apps. A host that supports MCP Apps can
render the board inside the conversation. Register the server for your client:

```sh
claude mcp add relay -- rly mcp
rly mcp install --target claude
rly mcp install --target codex
```

The first command configures Claude Code; the others write Claude Desktop
and Codex config respectively. Use `rly mcp config` to print config snippets.
The server exposes `relay_ask` for feedback and `relay_show` for display.

For remote clients, `rly mcp --http` serves Streamable HTTP. Run `rly help`
for host, port, token, and origin flags. The repo includes a `Dockerfile`.
See the [agent guide](AGENT.md) for board schemas, transport details,
and host requirements.

## More commands

| Command | Use it to |
| --- | --- |
| `rly view <file.md>` | Read local Markdown, tables, or PDFs in a board |
| `rly diff --staged` | Review a staged Git diff |
| `rly git pick` / `rly git cherry-pick` | Choose commits and their order; add `--code` for per-hunk review |
| `rly git conflict [files…]` | Review conflict hunks and return resolved text |
| `rly share <board-id>` | Manage links for collaborators or reviewers on the same Wi-Fi |
| `rly show --file spec.json --display-only` | Display a board without requiring feedback |
| `rly rescue <board-id>` | Restore a disconnected board on its original port |
| `rly agent` | Read the full guide to blocks, annotations, and agent workflows |
| `rly schema` | Print the board JSON Schema |

Boards autosave answers and comments. Detached boards keep serving after
a wait times out, until submission or `rly stop <board-id>`. Multiple boards
can run at once.

Relay has no npm runtime dependencies. It bundles the browser libraries for
charts and diagrams and loads them only when a board needs them. Local
file links open referenced paths in the default app; `RLY_OPEN_CMD` overrides
the opener.

## Migration from quest-board

relay was formerly `@khanglvm/quest-board` (CLI: `qbd`) — that package is
deprecated. Storage moved from `~/.quest-board` to `~/.relay` (override with
`RLY_HOME`); legacy `"html"` / `"htmlFile"` spec fields keep working.
