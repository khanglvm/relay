// rly skill: install the bundled agent skill and warn when it is stale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from '../store.js';
import { CliError } from '../util.js';
import { PKG_ROOT, VERSION } from './context.js';
import { parseArgs } from './args.js';
import { printJson } from './io.js';

const SKILL_SRC = path.join(PKG_ROOT, 'skills', 'relay');

const KNOWN_SKILL_DIRS = () => ({
  claude: path.join(os.homedir(), '.claude', 'skills', 'relay'),
  codex: path.join(os.homedir(), '.codex', 'skills', 'relay'),
  // The cross-agent skills dir (npx-skills ecosystem). Some Codex/agent
  // setups load skills from here INSTEAD of ~/.codex/skills.
  agents: path.join(os.homedir(), '.agents', 'skills', 'relay'),
});

// Pre-rename skill dirs (quest-board). `skill install` removes these so a
// stale copy doesn't shadow the renamed one.
const LEGACY_SKILL_DIRS = () => [
  path.join(os.homedir(), '.claude', 'skills', 'quest-board'),
  path.join(os.homedir(), '.codex', 'skills', 'quest-board'),
];

// One-time stderr nudge so agents that only have the CLI discover the skill.
export function firstRunHint() {
  try {
    const marker = path.join(HOME, '.hinted');
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    const installed = Object.values(KNOWN_SKILL_DIRS()).some((p) => fs.existsSync(path.join(p, 'SKILL.md')));
    if (!installed) {
      process.stderr.write(
        'tip (AI agents): rly bundles a universal skill — install it with `rly skill install`; full guide: `rly agent`\n'
      );
    }
  } catch {
    // never let the hint break a real command
  }
}

// Installed skill copies are snapshots — warn when they lag the CLI.
export function skillFreshnessWarning() {
  try {
    for (const [agent, dir] of Object.entries(KNOWN_SKILL_DIRS())) {
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      let installedVersion = null;
      try {
        installedVersion = fs.readFileSync(path.join(dir, '.rly-version'), 'utf8').trim();
      } catch {
        // pre-rename install without a version marker
      }
      if (installedVersion !== VERSION) {
        process.stderr.write(
          `note: the relay skill installed for ${agent} is from rly ${installedVersion ?? '<0.2.0'}, you run ${VERSION} — refresh with \`rly skill install\`\n`
        );
      }
    }
  } catch {
    // best effort only
  }
}

function skillTargets(target) {
  const known = KNOWN_SKILL_DIRS();
  if (!target || target === true || target === 'auto') {
    const found = Object.values(known).filter((p) => fs.existsSync(path.dirname(path.dirname(p))));
    if (!found.length) {
      throw new CliError('no agent dirs found (~/.claude, ~/.codex, or ~/.agents). Use --target claude|codex|agents|all|<dir>.');
    }
    return found;
  }
  if (target === 'both' || target === 'all') return Object.values(known);
  if (known[target]) return [known[target]];
  return [path.join(path.resolve(target), 'relay')];
}

// Removes stale pre-rename quest-board skill dirs so the renamed skill is the
// only one an agent sees. Returns the dirs actually removed.
function removeLegacySkills() {
  const removed = [];
  for (const dir of LEGACY_SKILL_DIRS()) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      // best effort — a leftover dir we couldn't remove shouldn't fail install
    }
  }
  return removed;
}

// Stamps the current CLI version into every installed skill dir's .rly-version.
// `rly skill install` writes this itself, but an `npx skills add` refresh does
// not — so after any refresh we re-stamp the dirs that now have a SKILL.md,
// keeping skillFreshnessWarning() from nagging about a just-refreshed skill.
export function stampSkillVersion() {
  const stamped = [];
  for (const dir of Object.values(KNOWN_SKILL_DIRS())) {
    try {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        fs.writeFileSync(path.join(dir, '.rly-version'), VERSION);
        stamped.push(dir);
      }
    } catch {
      // best effort — a marker we couldn't write just re-triggers the nudge
    }
  }
  return stamped;
}

// Short instruction block for an agent's main instruction file (CLAUDE.md,
// AGENTS.md, …). A skill is only a tier-1 hint that agents can ignore; these
// rules, appended to the instructions the agent always reads, enforce usage.
// Printed to stdout so `rly skill rules >> CLAUDE.md` is the whole install.
export const SKILL_RULES = `## relay: visual boards and structured feedback

- Use Relay for files, visuals, plans, diffs and several related questions. Keep brief
  answers and progress updates in chat, and follow the authorization the user already gave.
- Show without feedback: \`rly show --file spec.json --display-only\` (no waiter).
  Collect input: \`rly ask --file spec.json --detach\`, then keep
  \`rly wait <boardId> --timeout 1800 --while-active --idle-grace 300\` in the foreground.
  A timeout is not an answer: read \`rly result <boardId>\` before continuing.
- Pick the most specific block: table, chart or kpi for data; image or compare for visuals;
  code or diff for source; mermaid for flows; markdown for prose. Buttons and live status
  are \`a2ui\`. Per-area sign-off is one \`checklist\` question. A visual choice puts
  its picture in \`options[].blocks\`.
- Exact fields on demand: \`rly schema chart\` (any block or question type), \`rly agent <topic>\`
  (questions, blocks, annotate, lifecycle, sharing, mcp, a2ui). \`rly view\`, \`rly diff\` and
  \`rly git\` are shortcuts.
- A reader on another device needs an https url: \`--public-url 'https://host:{port}'\` or
  \`--link-command CMD\` (a command that takes the port and prints the url); \`rly config link\`
  saves it. Give the person the printed url, never a localhost one.
- Browser file links such as \`[source](/absolute/app.js:98)\` open in a modal. For inline MCP
  boards and shared reviewers, embed file content as blocks instead.
- Reconnect a board by id with \`rly rescue\` or \`rly reopen\`, and change it with \`rly update\`.
- Read answers, notes, comment, annotations and blockEdits together. Use the returned
  resultFile when stdout is cut short.
- The full skill is at \`rly skill path\`.`;

export function cmdSkill(rest) {
  const sub = rest[0];
  if (sub === 'rules') {
    console.log(SKILL_RULES);
    return 0;
  }
  if (sub === 'path') {
    console.log(SKILL_SRC);
    process.stderr.write('(bundled skill source — copy into your agent with `rly skill install`)\n');
    return 0;
  }
  if (sub === 'install') {
    const args = parseArgs(rest.slice(1));
    const targets = skillTargets(args.target);
    const installed = [];
    for (const t of targets) {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      // Clear whatever is already there first. cpSync refuses to overwrite a
      // non-directory (a symlink or file at the target — e.g. a skill dir the
      // user symlinked elsewhere) with a directory, so a plain re-install would
      // crash. rmSync on a symlink removes the link itself, not its target.
      fs.rmSync(t, { recursive: true, force: true });
      fs.cpSync(SKILL_SRC, t, { recursive: true });
      fs.writeFileSync(path.join(t, '.rly-version'), VERSION);
      installed.push(t);
    }
    const removedLegacy = removeLegacySkills();
    printJson({ installed, removedLegacy, note: 'most agents pick new skills up immediately; if yours does not, re-list skills or restart the session' });
    return 0;
  }
  console.log(`relay ships a universal agent skill (Claude Code, Codex, and any SKILL.md-aware agent).

  bundled at:  ${SKILL_SRC}
  install it:  rly skill install            # auto-detects ~/.claude, ~/.codex, ~/.agents
               rly skill install --target claude|codex|both|<dir>
  from repo:   npx skills add khanglvm/relay --skill relay --all
  enforce it:  rly skill rules              # short always-read rules — paste into the file your
                                            # agent reads (CLAUDE.md, AGENTS.md, .cursor/rules, …);
                                            # a skill alone is an ignorable hint

The skill teaches your agent the board spec format (questions + rich blocks +
annotations), the blocking vs --detach patterns, and visualization sizing.
Full guide: \`rly agent\`.`);
  return 0;
}
