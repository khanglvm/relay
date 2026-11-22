// The git-conflict block: parses conflict markers and normalizes the block.
import path from 'node:path';
import { CliError } from '../../util.js';
import { asStr, clampInt, readAnyTextSource } from '../sources.js';
import { BLOCK_HEIGHT } from '../constants.js';

function joinConflictLines(lines) {
  return lines.join('\n');
}

function parseGitConflictContent(content, where) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const parts = [];
  const conflicts = [];
  let textBuf = [];
  const flushText = () => {
    if (!textBuf.length) return;
    parts.push({ type: 'text', text: joinConflictLines(textBuf) });
    textBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].match(/^<<<<<<<(?:\s+(.*))?$/);
    if (!start) {
      textBuf.push(lines[i]);
      continue;
    }

    flushText();
    const oursLabel = start[1] || 'ours';
    const ours = [];
    const base = [];
    const theirs = [];
    let baseLabel = '';
    let theirsLabel = 'theirs';
    let section = 'ours';
    let closed = false;

    for (i = i + 1; i < lines.length; i++) {
      const line = lines[i];
      const baseStart = line.match(/^\|\|\|\|\|\|\|(?:\s+(.*))?$/);
      if (baseStart && section === 'ours') {
        baseLabel = baseStart[1] || 'base';
        section = 'base';
        continue;
      }
      if (/^=======$/.test(line) && (section === 'ours' || section === 'base')) {
        section = 'theirs';
        continue;
      }
      const end = line.match(/^>>>>>>>(?:\s+(.*))?$/);
      if (end && section === 'theirs') {
        theirsLabel = end[1] || theirsLabel;
        closed = true;
        break;
      }
      if (section === 'ours') ours.push(line);
      else if (section === 'base') base.push(line);
      else theirs.push(line);
    }

    if (!closed) {
      throw new CliError(`${where}: conflict marker starting at line ${conflicts.length + 1} is missing a matching >>>>>>> marker.`);
    }
    const id = `c${conflicts.length + 1}`;
    conflicts.push({
      id,
      oursLabel,
      theirsLabel,
      ...(baseLabel ? { baseLabel } : {}),
      ours: joinConflictLines(ours),
      theirs: joinConflictLines(theirs),
      ...(baseLabel ? { base: joinConflictLines(base) } : {}),
    });
    parts.push({ type: 'conflict', conflictId: id });
  }

  flushText();
  return { conflicts, parts };
}

// Normalizes one git-conflict block. `id` is the already-assigned block id.
export function normalizeGitConflictBlock(rawBlock, id, cwd, where, hasHeight) {
  const src = readAnyTextSource(rawBlock, ['content', 'text'], ['file', 'path', 'src'], cwd, where, 'git conflict file');
  if (!src.text.trim()) {
    throw new CliError(`${where}: git-conflict block needs inline "content"/"text" or a readable local "file"/"path".`);
  }
  const parsed = parseGitConflictContent(src.text, where);
  if (!parsed.conflicts.length) {
    throw new CliError(`${where}: no git conflict markers found (expected <<<<<<<, =======, >>>>>>>).`);
  }
  const filename = asStr(rawBlock.filename ?? rawBlock.name ?? (src.file ? path.basename(src.file) : '')).trim();
  const block = {
    id,
    type: 'git-conflict',
    filename,
    conflicts: parsed.conflicts,
    parts: parsed.parts,
  };
  const lang = asStr(rawBlock.lang).trim() || (filename ? path.extname(filename).slice(1).toLowerCase() : '');
  if (lang) block.lang = lang;
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  if (src.file) block.file = src.file;
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  return block;
}
