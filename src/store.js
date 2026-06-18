import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// All state lives under one dir so multiple boards/instances never collide.
// RLY_HOME override exists for tests and sandboxed agents.
export const HOME = process.env.RLY_HOME || path.join(os.homedir(), '.relay');
export const BOARDS_DIR = path.join(HOME, 'boards');
export const RUNNING_DIR = path.join(HOME, 'running');

export function ensureDirs() {
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  fs.mkdirSync(RUNNING_DIR, { recursive: true });
}

export function newId() {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 5);
  return `b-${t}${r}`;
}

const boardPath = (id) => path.join(BOARDS_DIR, `${id}.json`);
const runningPath = (id) => path.join(RUNNING_DIR, `${id}.json`);

export function createBoard(spec) {
  ensureDirs();
  const record = {
    id: newId(),
    createdAt: new Date().toISOString(),
    title: spec.title,
    // The directory the board was authored in. Relative file paths an agent
    // writes into the spec (markdown links, ~/… paths) resolve against this, so
    // the live server can open them in the user's default app (POST /api/open).
    cwd: process.cwd(),
    spec,
    draft: null,
    result: null,
  };
  saveBoard(record);
  return record;
}

export function saveBoard(record) {
  ensureDirs();
  fs.writeFileSync(boardPath(record.id), JSON.stringify(record, null, 2));
}

export function loadBoard(id) {
  try {
    return JSON.parse(fs.readFileSync(boardPath(id), 'utf8'));
  } catch {
    return null;
  }
}

export function deleteBoard(id) {
  try {
    fs.unlinkSync(boardPath(id));
    return true;
  } catch {
    return false;
  }
}

export function listBoards(limit = 20) {
  ensureDirs();
  const records = [];
  for (const f of fs.readdirSync(BOARDS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, f), 'utf8')));
    } catch {
      // ignore corrupt entries
    }
  }
  records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return limit > 0 ? records.slice(0, limit) : records;
}

export function saveRunning(info) {
  ensureDirs();
  fs.writeFileSync(runningPath(info.id), JSON.stringify(info, null, 2));
}

export function loadRunning(id) {
  try {
    return JSON.parse(fs.readFileSync(runningPath(id), 'utf8'));
  } catch {
    return null;
  }
}

export function removeRunning(id) {
  try {
    fs.unlinkSync(runningPath(id));
  } catch {
    // already gone
  }
}

// Cross-board UI preferences (e.g. theme). Boards run on random ports, so
// localStorage alone can't persist choices across boards — this file can.
const prefPath = () => path.join(HOME, 'ui-pref.json');

export function loadPref() {
  try {
    return JSON.parse(fs.readFileSync(prefPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function savePref(patch) {
  ensureDirs();
  fs.writeFileSync(prefPath(), JSON.stringify({ ...loadPref(), ...patch }, null, 2));
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listRunning() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(RUNNING_DIR)) {
    if (!f.endsWith('.json')) continue;
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(path.join(RUNNING_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (info && isAlive(info.pid)) {
      out.push(info);
    } else {
      // stale entry from a killed process
      try {
        fs.unlinkSync(path.join(RUNNING_DIR, f));
      } catch {
        // ignore
      }
    }
  }
  out.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
  return out;
}
