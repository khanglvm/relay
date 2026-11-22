// rly install: write the Relay instructions into each agent's rules file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../util.js';
import { SKILL_RULES } from './skill.js';
import { printJson } from './io.js';

// ===========================================================================
// `rly install` — inject relay's always-read rules into ANY agent's
// instruction file, cross-platform. `rly skill install` (above) handles the
// full SKILL.md for skill-aware agents; this covers the long tail (Cursor,
// Copilot, Kiro, Windsurf, Cline, Gemini, generic AGENTS.md, …) that read a
// rules/instructions/steering/context markdown file instead.
// ===========================================================================

const RELAY_BEGIN = '<!-- relay:begin (managed by `rly install` — your edits outside these markers are kept) -->';
const RELAY_END = '<!-- relay:end -->';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Resolve OS-specific base dirs from an injectable env/home/platform so the
// path logic is unit-testable for win32 / linux / darwin without running there.
function platformDirs({ platform, home, env }) {
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  // Copilot-in-JetBrains global instructions dir.
  const jetbrainsCopilot = platform === 'win32'
    ? path.join(localApp, 'github-copilot', 'intellij')
    : path.join(xdg, 'github-copilot', 'intellij');
  return { xdg, jetbrainsCopilot, documents: path.join(home, 'Documents') };
}

// The relay instruction registry. Each agent declares how to install relay's
// rules at `global` (user, machine-wide) and/or `project` (cwd) scope, in what
// `style`, and a `detect` dir whose existence means "you use this agent"
// (drives `--all`). Styles:
//   'shared'    — upsert a marked block into a possibly-shared file (CLAUDE.md,
//                 AGENTS.md, copilot-instructions.md, …); your other content is
//                 preserved, only relay's block is rewritten.
//   'dedicated' — relay owns the whole file (.kiro/steering, .windsurf/rules,
//                 .clinerules, …); safe to overwrite.
//   'mdc'       — dedicated, with Cursor `.mdc` YAML frontmatter.
export function agentRegistry({ platform = process.platform, home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const d = platformDirs({ platform, home, env });
  const j = path.join;
  return [
    { id: 'claude', label: 'Claude Code',
      detect: j(home, '.claude'),
      global: { file: j(home, '.claude', 'CLAUDE.md'), style: 'shared' },
      project: { file: j(cwd, 'CLAUDE.md'), style: 'shared' },
      note: 'full skill: `rly skill install`' },
    { id: 'codex', label: 'OpenAI Codex',
      detect: j(home, '.codex'),
      global: { file: j(home, '.codex', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
    { id: 'agents', label: 'AGENTS.md standard (Amp, Jules, Cline, …)',
      detect: j(home, '.agents'),
      global: { file: j(home, '.agents', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
    { id: 'cursor', label: 'Cursor',
      detect: j(home, '.cursor'),
      global: null, // user rules are set in Cursor Settings UI (not file-based)
      project: { file: j(cwd, '.cursor', 'rules', 'relay.mdc'), style: 'mdc' },
      note: 'global "User Rules" are set in Settings UI, not a file' },
    { id: 'copilot', label: 'GitHub Copilot (VS Code / Visual Studio / JetBrains)',
      detect: path.dirname(d.jetbrainsCopilot), // …/github-copilot
      global: { file: j(d.jetbrainsCopilot, 'global-copilot-instructions.md'), style: 'shared' },
      project: { file: j(cwd, '.github', 'copilot-instructions.md'), style: 'shared' },
      note: 'global file applies in JetBrains IDEs; project file applies everywhere' },
    { id: 'kiro', label: 'Kiro',
      detect: j(home, '.kiro'),
      global: { file: j(home, '.kiro', 'steering', 'relay.md'), style: 'dedicated' },
      project: { file: j(cwd, '.kiro', 'steering', 'relay.md'), style: 'dedicated' } },
    { id: 'windsurf', label: 'Windsurf',
      detect: j(home, '.codeium'),
      global: { file: j(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), style: 'shared' },
      project: { file: j(cwd, '.windsurf', 'rules', 'relay.md'), style: 'dedicated' } },
    { id: 'cline', label: 'Cline',
      detect: j(d.documents, 'Cline'),
      global: { file: j(d.documents, 'Cline', 'Rules', 'relay.md'), style: 'dedicated' },
      project: { file: j(cwd, '.clinerules', 'relay.md'), style: 'dedicated' } },
    { id: 'gemini', label: 'Gemini CLI',
      detect: j(home, '.gemini'),
      global: { file: j(home, '.gemini', 'GEMINI.md'), style: 'shared' },
      project: { file: j(cwd, 'GEMINI.md'), style: 'shared' } },
    { id: 'opencode', label: 'OpenCode',
      detect: j(d.xdg, 'opencode'),
      global: { file: j(d.xdg, 'opencode', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
    { id: 'droid', label: 'Droid (Factory)',
      detect: j(home, '.factory'),
      global: { file: j(home, '.factory', 'AGENTS.md'), style: 'shared' },
      project: { file: j(cwd, 'AGENTS.md'), style: 'shared' } },
  ];
}

// Render the relay rules in the style the target file expects.
function renderInstruction(style) {
  if (style === 'mdc') {
    return `---\ndescription: relay — collect decisions & show rich visuals in the browser, not the terminal\nalwaysApply: true\n---\n\n${SKILL_RULES}\n`;
  }
  return `${SKILL_RULES}\n`; // dedicated file — relay owns it
}

// Upsert relay's marked block into a (possibly shared / pre-existing) file,
// leaving everything outside the markers untouched. Returns 'added'|'updated'.
function upsertBlock(file, body) {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const wrapped = `${RELAY_BEGIN}\n${body}\n${RELAY_END}`;
  const re = new RegExp(escapeRegExp(RELAY_BEGIN) + '[\\s\\S]*?' + escapeRegExp(RELAY_END));
  const had = re.test(existing);
  const next = had
    ? existing.replace(re, wrapped)
    : (existing.trim() ? existing.replace(/\s*$/, '') + '\n\n' + wrapped + '\n' : wrapped + '\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return had ? 'updated' : 'added';
}

function writeInstruction(target) {
  if (target.style === 'shared') return upsertBlock(target.file, SKILL_RULES);
  const existed = fs.existsSync(target.file);
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, renderInstruction(target.style));
  return existed ? 'updated' : 'added';
}

export function cmdInstall(args) {
  const reg = agentRegistry();
  const byId = Object.fromEntries(reg.map((a) => [a.id, a]));
  const scope = args.scope === 'project' ? 'project' : args.scope === 'global' ? 'global' : null;

  // Pick the target for an agent: explicit --scope wins; else prefer global
  // (machine-wide), falling back to project when the agent has no global file.
  const pick = (a) => {
    if (scope === 'project') return a.project ? { scope: 'project', t: a.project } : null;
    if (scope === 'global') return a.global ? { scope: 'global', t: a.global } : null;
    if (a.global) return { scope: 'global', t: a.global };
    if (a.project) return { scope: 'project', t: a.project };
    return null;
  };

  const wantAll = args.all === true || String(args.target || '').toLowerCase() === 'all';

  // No target → show the matrix for THIS platform.
  if (!wantAll && (args.list === true || !args.target)) {
    printJson({
      platform: process.platform,
      agents: reg.map((a) => ({
        agent: a.id, label: a.label,
        global: a.global ? a.global.file : null,
        project: a.project ? a.project.file : null,
        note: a.note,
      })),
      usage: 'rly install --target <agent>[,<agent>] [--scope global|project] [--print] | rly install --all',
    });
    return 0;
  }

  // Resolve the set of {agent, scope, target} to act on.
  let chosen;
  if (wantAll) {
    chosen = reg
      .filter((a) => { try { return fs.existsSync(a.detect); } catch { return false; } })
      .map((a) => ({ a, ...(pick(a) || {}) }))
      .filter((x) => x.t);
    if (!chosen.length) {
      throw new CliError('no known agents detected on this machine (no ~/.claude, ~/.codex, ~/.cursor, ~/.kiro, …). Use --target <agent>.', 4);
    }
  } else {
    const ids = String(args.target).split(',').map((s) => s.trim()).filter(Boolean);
    chosen = [];
    for (const id of ids) {
      const a = byId[id];
      if (!a) throw new CliError(`unknown agent "${id}". Run \`rly install --list\` to see supported agents.`, 4);
      const p = pick(a);
      if (!p) throw new CliError(`${a.label} has no ${scope || 'installable'} instruction file${a.note ? ` — ${a.note}` : ''}. Try \`--scope project\`.`, 4);
      chosen.push({ a, ...p });
    }
  }

  // --print: emit content + resolved path for manual copy/paste; no writes.
  if (args.print === true) {
    for (const { a, t } of chosen) {
      const content = t.style === 'shared' ? `${RELAY_BEGIN}\n${SKILL_RULES}\n${RELAY_END}` : renderInstruction(t.style);
      process.stdout.write(`# ${a.label}\n# → ${t.file}\n\n${content}\n\n`);
    }
    return 0;
  }

  const installed = chosen.map(({ a, scope: sc, t }) => ({
    agent: a.id, scope: sc, file: t.file, action: writeInstruction(t),
  }));
  printJson({ installed, note: 'reload/re-open your agent (or re-list its rules) if it does not pick this up immediately' });
  return 0;
}
