# Relay

Relay gives your AI coding agent a browser board for showing work and asking
for feedback. Review a design, compare a diff, or answer several questions in
one place. Click an element to comment, then submit; the agent receives your
answers as JSON and continues working.

It works with agents such as Claude Code and Codex. Boards can also appear
inside chat apps that support MCP Apps.

![An agent opens a Relay board, the user reviews and submits, and the agent continues](https://raw.githubusercontent.com/khanglvm/relay/main/docs/assets/demo.gif)

## Install and try it

Requires Node.js 18.3 or newer.

```sh
npm i -g @khanglvm/relay
rly ask -q "Which layout?::single::Sidebar,Top navigation"
```

A board opens in your browser. Choose an option and submit to see the result
in your terminal.

You can also open local files or review changes from a Git repository:

```sh
rly view README.md
rly diff --staged
```

## What you can review

- Plans, documents, charts, and diagrams.
- Images and HTML prototypes, with comments on individual elements or areas.
- Source files and diffs, including commit choices and merge conflicts.
- Questions with choices, notes, and other form controls.

Answers and comments autosave. To stop a board, run `rly list` to find its
ID, then `rly stop <board-id>`.

## For AI agents

Install the skill so your agent knows how to create boards and read feedback:

```sh
npx skills add khanglvm/relay --skill relay --all
```

Give your agent this instruction:

```text
Use Relay to show work or collect visual feedback. Install the CLI with
`npm i -g @khanglvm/relay` if missing. Run `rly agent` for the board format.
Create with `rly ask --file spec.json --detach`, then use `rly wait <board-id>`
to collect answers. On timeout, check `rly result <board-id>` before continuing.
```

To make this a standing preference, `rly install --target codex` adds Relay
rules to Codex's instruction file. Run `rly install` to see other targets.

## More help

- [Setup and MCP Apps](docs/SETUP.md): agent configuration, in-chat boards, sharing, and updates.
- [Agent guide](docs/AGENT.md): board examples, block types, and JSON schemas; also available as `rly agent`.
- `rly help` lists commands. `rly upgrade` updates the CLI and skill.
- [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

For development, clone the repo and run `npm test`. The smoke tests use local
servers and do not require external services.
