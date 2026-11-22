// rly diff and rly git: boards built from git changes, commits and conflicts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertSpecReady, normalizeSpec } from '../spec/index.js';
import { createBoard } from '../store.js';
import { CliError } from '../util.js';
import { parseArgs } from './args.js';
import { printJson, runOrDetach } from './io.js';

// `rly diff [git args…]` — run `git diff` for the user and open the result as a
// diff-block board in one step (sugar like `rly view`). Everything that isn't a
// recognized rly flag is forwarded to git verbatim, so `rly diff --staged`,
// `rly diff HEAD~1`, `rly diff main -- src/` all work. rly flags: --detach,
// --no-open, --split (side-by-side), --title.
export async function cmdDiff(rest) {
  const RLY_FLAGS = new Set(['--detach', '--no-open', '--split', '--devlink', '--no-devlink']);
  const gitArgs = [];
  const rlyArgv = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--title' || t === '--public-url') { rlyArgv.push(t, rest[++i]); continue; }
    if (t.startsWith('--title=') || t.startsWith('--public-url=')) { rlyArgv.push(t); continue; }
    if (RLY_FLAGS.has(t)) { rlyArgv.push(t); continue; }
    gitArgs.push(t);
  }
  const args = parseArgs(rlyArgv);
  const res = spawnSync('git', ['--no-pager', 'diff', ...gitArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new CliError(`could not run git: ${res.error.message}. Is git installed and is this a repo?`);
  if (res.status !== 0 && res.stderr) throw new CliError(`git diff failed: ${res.stderr.trim()}`, res.status || 1);
  const diff = res.stdout || '';
  if (!diff.trim()) {
    printJson({ status: 'no-diff', hint: `git diff${gitArgs.length ? ' ' + gitArgs.join(' ') : ''} produced no output — nothing to show` });
    return 0;
  }
  const title = args.title || ('git diff' + (gitArgs.length ? ' ' + gitArgs.join(' ') : ''));
  const spec = normalizeSpec({ title, blocks: [{ type: 'diff', diff, view: args.split ? 'split' : 'unified' }] });
  await assertSpecReady(spec);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}

function runGit(args, message) {
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new CliError(`could not run git: ${res.error.message}. Is git installed and is this a repo?`);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new CliError(`${message}: ${detail || `git ${args.join(' ')} exited ${res.status}`}`, res.status || 1);
  }
  return res.stdout || '';
}

function gitConflictPaths(explicitPaths) {
  if (explicitPaths.length) return explicitPaths;
  const out = runGit(['diff', '--name-only', '--diff-filter=U'], 'git conflict detection failed');
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function gitCommitRows(range, limit) {
  const n = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 20));
  const args = ['log', `-n${n}`, '--date=short', '--pretty=format:%H%x09%h%x09%ad%x09%an%x09%s'];
  if (range) args.push(range);
  return runGit(args, 'git log failed')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, short, date, author, ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t');
      return { sha, short, date, author, subject };
    })
    .filter((r) => r.sha && r.short);
}

function gitCommitDiff(commit) {
  return runGit([
    '--no-pager',
    'show',
    '--format=',
    '--patch',
    '--find-renames',
    '--find-copies',
    '--no-ext-diff',
    commit,
  ], `git show ${commit} failed`).trimEnd();
}

export async function cmdGit(rest) {
  const args = parseArgs(rest);
  const modes = new Set(['pick', 'cherry-pick', 'cherrypick', 'conflict', 'conflicts', 'resolve']);
  let mode = 'pick';
  if (args._[0] && modes.has(args._[0])) mode = args._.shift();
  if (mode === 'cherrypick') mode = 'cherry-pick';
  if (mode === 'conflicts' || mode === 'resolve') mode = 'conflict';

  const blocks = [];
  const questions = [];
  let reviewDiffCount = 0;

  if (mode === 'pick' || mode === 'cherry-pick') {
    const range = args.range || args._[0] || '';
    const commits = gitCommitRows(range, args.limit);
    if (!commits.length) throw new CliError(`git log${range ? ` ${range}` : ''} produced no commits to show.`);
    const withCode = args.code === true || args.patch === true || args.diff === true;
    blocks.push({
      type: 'table',
      columns: ['short', 'date', 'author', 'subject'],
      rows: commits.map((c) => ({ short: c.short, date: c.date, author: c.author, subject: c.subject })),
      sortable: true,
      filterable: true,
      exportable: true,
    });
    const options = commits.map((c) => ({
      value: c.sha,
      label: `${c.short} ${c.subject}`,
      description: `${c.date} · ${c.author}`,
    }));
    questions.push({
      id: 'commit_actions',
      type: 'checklist',
      label: mode === 'cherry-pick' ? 'Choose cherry-pick actions' : 'Choose commit actions',
      description: 'Set only the commits you want the agent to act on.',
      options,
      statuses: mode === 'cherry-pick'
        ? [{ value: 'cherry-pick', label: 'Cherry-pick', tone: 'ok' }, { value: 'skip', label: 'Skip', tone: 'muted' }, { value: 'hold', label: 'Hold', tone: 'warn' }]
        : [{ value: 'pick', label: 'Pick', tone: 'ok' }, { value: 'cherry-pick', label: 'Cherry-pick', tone: 'warn' }, { value: 'drop', label: 'Drop', tone: 'bad' }],
    });
    if (options.length > 1) {
      questions.push({
        id: 'commit_order',
        type: 'rank',
        label: mode === 'cherry-pick' ? 'Cherry-pick order' : 'Preferred commit order',
        description: 'Drag or move commits into the order the agent should apply them.',
        options,
      });
    }
    if (withCode) {
      for (const c of commits) {
        const diff = gitCommitDiff(c.sha);
        if (!diff.trim()) continue;
        blocks.push({
          type: 'diff',
          title: `${c.short} ${c.subject}`,
          filename: `${c.short} ${c.subject}`,
          commit: c.sha,
          reviewKind: mode,
          review: true,
          view: 'split',
          diff,
        });
        reviewDiffCount++;
      }
    }
  }

  const paths = mode === 'conflict' ? gitConflictPaths(args._) : gitConflictPaths([]);
  for (const p of paths) {
    let text = '';
    try { text = fs.readFileSync(path.resolve(p), 'utf8'); } catch { /* normalizeSpec will report unreadable explicit files below */ }
    if (!text || /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/.test(text)) {
      blocks.push({ type: 'git-conflict', path: p, filename: p });
    }
  }

  if (mode === 'conflict' && !blocks.some((b) => b.type === 'git-conflict')) {
    throw new CliError(args._.length
      ? 'no conflict markers found in the provided file(s).'
      : 'no unmerged git files with conflict markers were detected.');
  }

  const conflictCount = blocks.filter((b) => b.type === 'git-conflict').length;
  const title = args.title || (mode === 'conflict'
    ? `Resolve ${conflictCount} git conflict${conflictCount === 1 ? '' : 's'}`
    : mode === 'cherry-pick' ? 'Cherry-pick commits' : 'Pick commits');
  const intro = args.intro || (conflictCount
    ? 'Resolve each conflict on the board. The submitted result includes result.blockEdits with per-hunk choices and a full resolved file preview for every conflict block.'
    : reviewDiffCount
      ? 'Review commit code hunks on the board. Apply, skip, or hold each hunk; submit returns commit actions plus diff-review hunk choices as JSON.'
      : 'Pick commit actions and order on the board. Submit returns the selected actions and rank order as JSON.');
  const spec = normalizeSpec({ title, intro, blocks, questions, submitLabel: 'Submit git choices' });
  await assertSpecReady(spec);
  const record = createBoard(spec);
  return runOrDetach(record, args);
}
