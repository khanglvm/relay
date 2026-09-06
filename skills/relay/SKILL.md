---
name: relay
description: "Present files, visuals, plans, diffs, and structured user decisions in a Relay browser or inline MCP board. Use for visual review, rich reports, or multiple related questions; use native chat for simple answers and single confirmations."
---

# Relay (`rly`)

Choose the surface and component that lets the user understand or decide with
least effort. Use Relay for files, visuals, substantial plans, and related
questions. Keep ordinary progress updates and brief answers in chat. Follow the
user’s existing authorization; a board is not an extra approval requirement.

## Choose the operation

- **Show content without asking for feedback:** `rly show --file spec.json --display-only`.
  Returns immediately; no Submit button or waiter is needed.
- **Collect answers or comments:** `rly ask --file spec.json --detach`, then wait
  for that board’s result. Put related questions on one board.
- **Read a file:** `rly view report.md --display-only`; also accepts CSV/TSV/JSON
  tables and PDF. Use a `code` block with `codeFile` for source code.
- **Show changes:** `rly diff`; `rly git pick`, `rly git cherry-pick --code`, and
  `rly git conflict` collect commit/hunk choices. Apply only the user’s choices.
- **Continue an existing board:** identify it by URL/port/title with `rly list`
  or `rly history`. Use `rly rescue <id>` for a disconnected tab (same port),
  `rly reopen <id>` for a new tab with saved input, or `rly update <id> --file
  spec.json` to change its content. `rly reuse` deliberately starts a blank run.

If Relay MCP tools are available in the current host, `relay_ask` collects input
inline and `relay_show` is display-only by default. Use the actual exposed tool
schema; setup details are in `rly mcp config`. Local file-link previews require
the **browser board** server. For inline MCP, embed file content using `mdFile`,
`codeFile`, or an image block instead.

## Author a board

Write valid JSON to a file; avoid embedding large specs in shell arguments.
Use `rly schema` for exact fields and `rly agent` for detailed recipes, sharing,
HTML/annotation APIs, and less common components. Load those only as needed.

```json
{
  "title": "Implementation review",
  "blocks": [
    {"type": "markdown", "md": "Review the [source](/absolute/path/app.js:98)."},
    {"type": "code", "codeFile": "/absolute/path/app.js", "ref": "source"}
  ],
  "questions": [
    {"id": "approach", "type": "single", "label": "Which approach?",
     "options": [{"value": "small", "label": "Small change", "description": "Keep the current interface."},
                 {"value": "replace", "label": "Replace", "description": "Introduce the new interface."}]},
    {"id": "notes", "type": "textarea", "label": "What needs adjusting?", "required": false}
  ]
}
```

Use stable question IDs and descriptive option values. Questions and individual
options can carry their own `blocks`; put each design variant inside its option.
Use `required:true` only for answers necessary to continue.

| Content | Component |
|---|---|
| Prose / documents | `markdown` with `md` or `mdFile` |
| Source / changes | `code` with `codeFile`; `diff` with `diffFile`; `git-conflict` |
| Data / headline metrics | `table` with `rowsFile`, `chart`, `kpi` |
| Flows / dependencies / UML | `mermaid`, `graphviz`, `plantuml` |
| Mockups / before-after | `image`, `compare` |
| Media / reports | `video`, `pdf` |
| Design choices | `palette`, `typography` |
| Custom interactive content | sandboxed `html` |

| Answer shape | Question type |
|---|---|
| One / several choices | `single`, `multi` |
| Binary / rating / color | `yesno`, `scale`, `color` |
| Free text | `text`, `textarea` |
| Priorities / budget / sign-off | `rank`, `allocate`, `checklist` |

Any block can have `"ref":"source"`; `[View source](#ref:source)` opens its viewer
from another part of the board. `mermaid` with `editable:true` returns user edits
in `blockEdits`. For image feedback, primary drag selects a region/crop;
Space-drag or middle-drag pans. A compare divider moves only by its handle.
`pins:true` adds image point comments.

## File references that open in a modal

In the intro or a markdown block, use `[label](/absolute/path/file.js:98)`.
Absolute paths are most reliable across authoring directories. `./`, `../`,
`~/`, `file://` URLs, bare paths, and backtick paths are also recognized. Encode
spaces in file URLs, for example `[report](file:///tmp/My%20Report.md)`.

- `:line`, `:line:column`, and `#Lstart-Lend` select source lines. Columns are
  accepted; highlighting is by line.
- UTF-8 source/config/log files have numbered, highlighted source previews.
  Markdown renders as a document; CSV/TSV as a table; HTML as a sandboxed static
  page. These views also offer a Source button.
- Images, PDF, and browser-compatible audio/video render within the modal.
  Playback depends on the browser’s codec support.
- Text previews are limited to 1 MiB and 20,000 lines. Missing files show an
  error; binary/oversized files and directories offer **Open in app**.
- Only local paths explicitly referenced by the board are accessible. Links
  discovered inside a preview do not grant access to more files. References
  read the current disk content; use content blocks for a captured snapshot or
  for annotations. Preview modals do not collect annotations.
- Owner and collaborator browser sessions can preview/open local references.
  Read-only and reviewer shares cannot; embed needed content as blocks for them.

After a CLI upgrade, running boards retain their previous server/UI snapshot.
For a board that needs the new viewer, preserve its saved input and reconnect
that same board with the updated CLI; do not replace it with a new board ID.

## Wait and read feedback

For a response-bearing browser board, retain the returned board ID and keep a
foreground waiter running in Codex:

```sh
rly ask --file spec.json --detach
rly wait <boardId> --timeout 1800 --while-active --idle-grace 300
```

Keep the process/session handle if the shell tool yields. Resume that process
until it exits; use the host’s background-completion mechanism only when it is
available. If the wait times out, run `rly result <boardId>` before deciding
whether another wait is needed. A timeout is not an answer. Detached boards
remain available on the same port until submitted or explicitly stopped.
`--timeout 0` disables the Relay deadline; the default is one day.

Read **answers, notes, comment, annotations, and blockEdits** together. Notes and
annotations can qualify a selected answer. On timeout/cancel, these may be under
`draft`; treat them as unfinished feedback. Reviewer submissions are side
reviews and never finalize the owner’s board.

For large results, use the returned `resultFile` to read the complete JSON.
Avoid truncating stdout with `head`/`tail`; inspect every feedback channel before
acting. To reply to annotations, write
`[{"annotationId":"a1","text":"Updated the example."}]` to a file and run
`rly reopen <id> --replies replies.json`.

## Details on demand

- `rly agent`: full guide, HTML/diagram editing, sharing roles, annotations,
  result shapes, and lifecycle recipes.
- `rly schema`: authoritative board fields; `rly <command> --help` for CLI flags.
- `examples/`: ready-to-adapt board specs for visual options, diagrams, and color.
- `rly share <id> --role review|collab|read`: activate sharing only when requested;
  `--revoke` disables the selected role. Keep share tokens out of reports/logs.
- `rly upgrade --force`: update CLI/skill while running boards keep their snapshot.
