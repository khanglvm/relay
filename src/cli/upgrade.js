// rly upgrade: update the global package and refresh what depends on it.
import { spawnSync } from 'node:child_process';
import { listRunning, loadRunning } from '../store.js';
import { CliError, pollFor } from '../util.js';
import { printJson } from './io.js';
import { PKG_NAME } from './context.js';
import { stampSkillVersion } from './skill.js';

// `rly upgrade` — install the latest CLI globally AND refresh the skill (via the
// npx-skills package manager, falling back to the bundled copy) in one shot.
// (`update` is taken by the live-mutate command, so this is
// `upgrade` / `self-update`.) Running boards are surfaced and handled: a global
// reinstall overwrites relay's files, but live detached servers snapshot their
// UI at first request and serve from memory, so they keep working on their own
// version. Flags: --stop (stop running boards first), --force (upgrade while
// they keep running), --cli-only / --skill-only (scope).
export async function cmdUpgrade(args) {
  const force = args.force === true;
  const doStop = args.stop === true;
  const wantCli = args.skillOnly !== true;
  const wantSkill = args.cliOnly !== true;

  const running = listRunning();

  // --dry-run: report the plan (incl. how running boards would be handled)
  // without installing anything or stopping anything.
  if (args.dryRun === true) {
    printJson({
      dryRun: true,
      wouldRun: [wantCli && `npm install -g ${PKG_NAME}@latest`, wantSkill && 'npx skills add khanglvm/relay --skill relay --all'].filter(Boolean),
      runningBoards: running.map((r) => r.id),
      runningHandling: running.length
        ? doStop
          ? 'stop them first'
          : force
            ? 'leave them running (snapshotted)'
            : 'BLOCKED — pass --stop or --force'
        : 'none running',
    });
    return 0;
  }

  if (running.length) {
    const ids = running.map((r) => r.id).join(', ');
    if (doStop) {
      process.stderr.write(`Stopping ${running.length} running board(s) before upgrading: ${ids}\n`);
      for (const r of running) {
        try { process.kill(r.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      for (const r of running) await pollFor(() => (loadRunning(r.id) ? null : true), 5000);
    } else if (!force) {
      // Default: don't silently overwrite under live boards — explain + let the
      // user choose. The boards themselves are safe; this is about clarity.
      process.stderr.write(
        `${running.length} board(s) still running: ${ids}\n` +
          'They keep serving their current version safely (each snapshots its UI in memory),\n' +
          'and stay readable via `rly result <id>` / `rly wait <id>`. Pick one:\n' +
          '  • rly stop --all       then re-run `rly upgrade`  (cleanest)\n' +
          '  • rly upgrade --stop   stop them as part of this upgrade\n' +
          '  • rly upgrade --force  upgrade now; leave them running on their snapshot\n'
      );
      printJson({ upgraded: false, reason: 'running-boards', running: running.map((r) => r.id) });
      return 0;
    } else {
      process.stderr.write(`--force: leaving ${running.length} board(s) running on their snapshotted version: ${ids}\n`);
    }
  }

  const did = {};

  if (wantCli) {
    process.stderr.write(`\nUpgrading ${PKG_NAME} → latest  (npm install -g ${PKG_NAME}@latest)\n`);
    // shell:true so Windows resolves `npm` → `npm.cmd` (same reason the skill /
    // version spawns below use it); the package name has no shell metacharacters.
    const r = spawnSync('npm', ['install', '-g', `${PKG_NAME}@latest`], { stdio: 'inherit', shell: true });
    if (r.error || r.status !== 0) {
      throw new CliError(
        `npm install failed${r.error ? ` (${r.error.message})` : ` (exit ${r.status})`}. ` +
          `Update manually: npm install -g ${PKG_NAME}@latest`,
        1
      );
    }
    did.cli = `${PKG_NAME}@latest`;
  }

  if (wantSkill) {
    // Refresh the skill through the npx-skills package manager — the same channel
    // the skill is normally managed by (skills-lock.json, ~/.agents, ~/.claude, …)
    // — so the global install stays in sync and pulls the freshest skill for
    // khanglvm/relay. `npx -y` so the one-off download needs no prompt.
    process.stderr.write('\nRefreshing the relay skill  (npx skills add khanglvm/relay --skill relay --all)\n');
    let r = spawnSync('npx', ['-y', 'skills', 'add', 'khanglvm/relay', '--skill', 'relay', '--all'], { stdio: 'inherit', shell: true });
    let how = 'npx-skills';
    if (r.error || r.status !== 0) {
      // Fallback: install the skill bundled with the CLI we just upgraded. Works
      // offline / when the skills CLI is unreachable, and matches this version.
      process.stderr.write('\nnpx skills unavailable — falling back to the bundled skill  (rly skill install)\n');
      r = spawnSync('rly', ['skill', 'install'], { stdio: 'inherit', shell: true });
      how = 'bundled';
    }
    if (r.error || r.status !== 0) {
      process.stderr.write(
        `Skill refresh did not complete${r.error ? ` (${r.error.message})` : ` (exit ${r.status})`} — ` +
          'run `npx skills add khanglvm/relay --skill relay --all` (or `rly skill install`) yourself.\n'
      );
    } else {
      // Keep the freshness marker accurate however the skill landed, so the next
      // `rly` run doesn't nag that the just-refreshed skill is stale.
      stampSkillVersion();
      did.skill = how;
    }
  }

  // Report the now-current global version (best-effort).
  let nowVersion = null;
  try {
    const v = spawnSync('rly', ['--version'], { encoding: 'utf8', shell: true });
    if (v.status === 0 && v.stdout) nowVersion = String(v.stdout).trim();
  } catch {
    // best effort
  }

  printJson({
    upgraded: true,
    ...did,
    version: nowVersion,
    note: 'most agents pick the new skill up immediately; if not, re-list skills or restart the session',
  });
  return 0;
}
