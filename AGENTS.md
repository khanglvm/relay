# Relay

Relay (`rly`, npm `@khanglvm/relay`) gives an AI coding agent a board for showing work and asking the user questions. The board opens in a local browser, or renders inline in a chat app as an MCP App. The user's answers, notes and element-level comments come back to the agent as JSON. The package has no runtime dependencies. It runs on Node 18.3 or newer.

## Commands
- Install: `npm ci` (dev tools only; the package itself has no runtime dependencies)
- Type check: `npm run check` (tsc with checkJs)
- Lint: `npm run lint` (biome)
- Test: `npm test` (the e2e smoke and golden tests plus the unit tests under `test/unit`; it spawns the real CLI against a temp `RLY_HOME`)
- Types for the package: `npm run build:types` (writes `types/`, which git ignores; `npm pack` runs it)
- Schema: `npm run gen:schema` after changing `SPEC_SCHEMA`; a test fails while `schema/spec.v1.json` is stale
- A2UI guide: `node scripts/gen-a2ui-doc.mjs --write` after changing the catalog or `src/a2ui/guide.md`
- Pack check: `npm run smoke:pack` installs the tarball into a temp project and imports it
- Release: bump `version` in `package.json` and add a CHANGELOG entry. Merging to `main` runs `.github/workflows/npm-publish.yml`, which checks, tests and publishes through npm trusted publishing. Confirm with `npm view @khanglvm/relay version`.

## Layout
- `bin/rly.js`: CLI entry.
- `src/index.js`: library entry (`createBoard`, `normalizeSpec`, `validateSpec`, `compileA2ui`) and the shared typedefs.
- `src/spec/`: spec normalization (one file per block type under `blocks/`), validation and `SPEC_SCHEMA`.
- `src/cli/`: every `rly` command, one file each, routed by `index.js`.
- `src/server/`: the local board server (`board.js`) and the page builder (`page.js`).
- `src/mcp.js`: the MCP App server (stdio and HTTP).
- `src/store.js`: boards and results on disk under `RLY_HOME` (default `~/.relay`).
- `src/link.js`: private links through `devlink` or a public URL template.
- `src/a2ui/`: A2UI widget catalog, compiler and the bundled agent SDK.
- `src/ui/`, `src/mcp-ui/`: browser code and CSS. They are sent as text to the page, not imported by Node; `src/ui/manifest.js` lists the files of each bundle in order. Pieces are cut at statement boundaries, so a bundle stays byte-identical.
- `vendor/`: bundled browser libraries (mermaid, chart, viz and others), refreshed by `scripts/update-vendor.mjs`.
- `skills/relay/`: the agent skill and its example specs. `docs/`: agent guide, setup, A2UI reference.
- `schema/`: generated JSON Schema. `types/`: generated `.d.ts`.

## Conventions
- Plain JavaScript with JSDoc types, checked by `tsc --noEmit`. No build step runs for `rly` users.
- Errors that the agent should read throw `CliError` with a message worded for that agent.
- `exports` in `package.json` is the public surface. Deep imports into `src/` are not supported.
- Browser code under `src/ui` and `src/mcp-ui` is excluded from lint and the type check.
- Biome runs lint only. The rules turned off in `biome.json` are intentional: control characters in the file previewer's binary check, and assignments inside conditions.
- Comments follow the repo's `code-craft` rules: say why, not what.

## Gotchas
- A change to the spec shape changes `rly agent`, the MCP tool schema and `schema/spec.v1.json` together.
- `test/e2e/smoke.test.mjs` sets `HOME` and `RLY_HOME` to a temp directory so tests never touch a real `~/.relay`, `~/.claude` or `~/.codex`.
- The publish workflow only publishes when `package.json` changes the version on `main`.
- Nothing about a release is done until `npm view @khanglvm/relay version` shows it and `npm i -g @khanglvm/relay` installs it.

## Docs
- Product: PRODUCT.md · Design: DESIGN.md · Architecture: ARCHITECTURE.md
- Keep these current: a change to commands, layout, scope, tokens or structure updates its file in the same commit.
