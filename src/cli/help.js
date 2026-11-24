// The rly help text.
import { VERSION } from './context.js';

export function printHelp() {
  console.log(`rly ${VERSION} — relay: browser question boards, rich blocks & annotations for AI agents

USAGE
  rly ask --file spec.json            create board, open browser, BLOCK until submit, print answers JSON
  rly ask --file - < spec.json        spec from stdin
  rly ask -q "Deploy?::yesno" -q "!Env::single::dev,staging,prod"
                                      quick inline questions ("!" = required, label::type::options)
  rly ask ... --detach                no blocking: prints {boardId,url} now; collect via \`rly wait <id>\`
  rly ask ... --on-result "<cmd>"     push-wake: run <cmd> when the board finishes (result JSON on stdin)
  rly show --html-file viz.html       visualization board (submit button = acknowledge)
  rly show --file spec.json --display-only
                                      present without comments/acknowledgement; returns immediately
  rly view <file.md> [more.md …]      quick read-only board rendering markdown file(s) (no lib)
                                      (.csv/.tsv/.json render as a filterable, sortable table;
                                       .pdf streams in an inline PDF viewer)
  rly diff [git args…]                run git diff and show it in a diff board (--split, --detach,
                                      --title; other args pass to git: rly diff --staged | HEAD~1 | -- path)
  rly git pick [range]                board for choosing pick/cherry-pick/drop actions plus commit order
  rly git cherry-pick [range]         board for choosing commits and cherry-pick order
                                      add --code for split code view with per-hunk Apply/Skip/Hold
  rly git conflict [files…]           board for resolving conflict-marker files; with no files, auto-detects
                                      unmerged git files and returns resolved content in result.blockEdits
  rly wait <id> [--timeout 86400]     block up to one day until the board finishes (0 = no deadline)
                                      --while-active [--idle-grace 180]: keep waiting past the deadline
                                        while the user is still viewing/focused & recently active
                                      --notify-cmd "<cmd>": run <cmd> on a terminal result (JSON on stdin)
                                      NB: also writes the FULL result to "resultFile" (first field) —
                                        read that file if your shell truncates stdout; never pipe to head/tail
  rly result <id>                     result/status now (includes live autosaved draft + presence while open)
  rly share <id>                      list active same-Wi-Fi share links for a running board
  rly share <id> --role review        reviewer: answer/comment/submit a reference-only side review
  rly share <id> --role collab        collaborator: edit/comment/final-submit as owner-authorized
  rly share <id> --role read          activate a read-only viewer link
  rly share <id> --role review --revoke
                                      revoke one share role; use --revoke --all to disable all roles
                                      active links survive same-port reopen/rescue until revoked
  rly ask ... --link-command <cmd>    serve the board at the https URL a link-provider command prints
                                      for its port ({port} in <cmd>, else appended); no local browser opens
  rly ask ... --devlink               same, through the optional devlink command
  rly ask ... --public-url <url>      same, through your own proxy or tunnel: https://relay.example.com:{port}
  rly config link <off|auto|devlink|url|command:CMD>
                                      save that choice for every board (auto = devlink when installed)
  rly list [--json]                   running boards
  rly open [id]                       re-open the browser tab of a running board
  rly reopen <id> [--replies f.json]  serve a saved board again, prefilled with saved answers
                                      (--replies [{annotationId,text}] = agent answers to element comments)
  rly rescue <id> [--open]            re-serve a board on its ORIGINAL port so a still-open but
                                      disconnected browser tab auto-reconnects & re-saves (no new tab
                                      unless --open). Use when a tab shows "connection lost".
  rly reuse <id> [--dump]             re-run a past board as a new board (--dump prints its spec)
  rly update <id> --file spec.json    live-mutate a RUNNING board (or --title/--intro/-q); page reloads;
                                      files are read under the roots the board was created with
  rly stop <id> | --all               stop running board(s) (status: cancelled, draft preserved)
  rly history [--limit n] [--json]    saved boards
  rly spec <id>                       print a saved board's spec JSON (edit, then ask --file again)
  rly rm <id> | --all                 delete saved board(s)
  rly schema                          JSON Schema of the board spec
  rly agent                           FULL GUIDE for AI agents (spec format, blocks, sizing, patterns)
  rly a2ui                            A2UI widget blocks: Express grammar, components, examples
  rly skill [install|rules|path]      bundled universal agent skill (Claude Code, Codex, …)
                                      \`rly skill rules >> CLAUDE.md\` adds always-read usage rules
  rly install --target <agent>        inject relay's rules into an agent's instruction file
                                      claude codex cursor copilot kiro windsurf cline gemini opencode droid agents
                                      --scope global|project · --print (copy/paste) · --all · --list (no flags)
  rly upgrade                         install the latest CLI globally + refresh the skill in one step
                                      --stop/--force handle running boards · --dry-run · --cli-only/--skill-only
  rly mcp                             run relay as an MCP App server (stdio) — boards render INLINE in
                                      a local desktop host (Claude Desktop, Codex) instead of a browser tab
  rly mcp --http [--port N]           serve over Streamable HTTP for web/mobile/remote hosts
                                      [--host H --token-file PATH --allow-origin ORIGIN]
                                      [--root PATH ...]   folders a spec may read local files from (none by default over HTTP; also $RLY_FILE_ROOTS)
                                      [--retention-days N|off]   delete boards unchanged for N days (default 30; also $RLY_RETENTION_DAYS)
                                      (token: --token-file, $RLY_MCP_TOKEN, or --token, which shows in the process list)
  rly mcp config | install --target   print host setup, or write it (claude | codex)

COMMON FLAGS
  --title <s> --intro <s> --html-file <f> --height <px> --submit-label <s>
  --timeout <sec> (default 86400; 0 = none) --port <n> --open | --no-open --detach --display-only
               no browser tab by default under T3 Code or Sushi; $RLY_OPEN=1|0 sets the default
  --devlink | --no-devlink | --public-url <url>   where the board link points (see rly config link)

EXIT CODES   0 submitted/acknowledged · 2 timeout · 3 cancelled · 4 usage · 5 not found

NOTES        detached boards keep serving after timeout until Submit or stop;
             answers & annotations autosave in real time (drafts survive timeout/cancel);
             submitting auto-closes the tab and unblocks the CLI.

AI AGENTS    run \`rly agent\` for the complete machine-oriented guide.
             a universal skill is bundled — install with \`rly skill install\`
             (or from the repo: npx skills add khanglvm/relay --skill relay --all)`);
  return 0;
}
