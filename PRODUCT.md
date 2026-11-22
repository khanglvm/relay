# Product

## Platform
cli, library (Node.js) and a local web app. An MCP App server runs over stdio or HTTP.

## Stack
JavaScript (ES modules) with JSDoc types on Node 18.3 or newer. No runtime dependencies; browser libraries are bundled under `vendor/`. Published to npm as `@khanglvm/relay`.

## Users
Developers who work with AI coding agents such as Claude Code and Codex. The agent calls Relay; the developer answers on the board. The agent also reads the skill and the agent guide that ship in the package.

## Product Purpose
An agent often needs more than a chat reply: a chart to review, a diff to approve, or several questions answered at once. Relay shows that content on a board and returns the user's answers and comments as structured JSON. Success is an agent that gets feedback pointing at the exact chart point, line of text or image area the user meant.

## Positioning
Chat replies cannot hold a chart, a diff and a form together, and they lose the target of a comment. Relay keeps the target with each comment and works in a browser or inline in an MCP App host.

## Operating Context
Runs on the developer's machine, or on a container host through `rly mcp --http`. A board can be opened on a phone through a private https URL from a public URL template or a link-provider command. The user interface is in English.

## Capabilities and Constraints
- Ten question types and eighteen block types, including markdown, charts, mermaid, diffs, images, HTML and A2UI widgets.
- Element-level annotations, autosave, local file links with previews, sharing and rescue of stopped boards.
- Hard limits: no runtime dependencies, and the CLI, the web board and the MCP output stay compatible with the agent skill.

## Product Principles
1. The agent decides what to show; the board never adds an approval step of its own.
2. A comment keeps its target.
3. Short answers stay in chat; a board is for content the user must inspect.
4. A spec written for an older version keeps working.

## Accessibility & Inclusion
Unknown: no accessibility target is recorded. The file preview modal is keyboard accessible (CHANGELOG 0.17.0).
