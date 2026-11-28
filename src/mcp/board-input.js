import path from 'node:path';
import { createFileAccess, readReadable } from '../file-access.js';
import { CliError } from '../util.js';

const MAX_SPEC_BYTES = 8 * 1024 * 1024;

/** Loads an MCP board file under the configured roots and appends inline board content. */
export function resolveBoardInput(args, fileRoots) {
  const { specFile, ...inline } = args;
  if (specFile === undefined) return { raw: inline };
  if (typeof specFile !== 'string' || !path.isAbsolute(specFile.trim())) {
    throw new CliError('specFile must be an absolute path on the Relay server. Send inline blocks and questions for a file on another machine.');
  }

  const files = createFileAccess({ roots: fileRoots });
  const { file, buf } = readReadable(files, specFile, 'board', 'specFile', { maxBytes: MAX_SPEC_BYTES });
  const base = parseBoardFile(specFile, buf);
  const raw = { ...base, ...inline };
  for (const key of ['blocks', 'questions']) {
    if (base[key] == null || inline[key] === undefined) continue;
    if (!Array.isArray(base[key]) || !Array.isArray(inline[key])) {
      throw new CliError(`"${key}" must be an array in the board file and in the tool call.`);
    }
    // Normalize after combining so duplicate question IDs and block references are checked together.
    raw[key] = [...base[key], ...inline[key]];
  }
  // Adding questions turns a display-only file into a board that collects answers.
  if (Array.isArray(inline.questions) && inline.questions.length && inline.responseRequired === undefined) {
    raw.responseRequired = true;
  }
  // Relative server roots keep the meaning they had before changing the board's working directory.
  return { raw, cwd: path.dirname(file), resolvedRoots: files.roots };
}

function parseBoardFile(specFile, buf) {
  let value;
  try {
    value = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new CliError(`specFile "${specFile}" must contain valid JSON.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`specFile "${specFile}" must contain a board JSON object.`);
  }
  return value;
}
