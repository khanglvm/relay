// Readers for text that a block takes inline or from a file next to the spec.
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../util.js';
import { TEXT_FILE_MAX_BYTES } from './constants.js';

export const asStr = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function readHtml(obj, cwd, where) {
  if (typeof obj.html === 'string' && obj.html.trim()) return obj.html;
  if (typeof obj.htmlFile === 'string' && obj.htmlFile.trim()) {
    const p = path.resolve(cwd, obj.htmlFile);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      throw new CliError(`${where}: cannot read htmlFile "${obj.htmlFile}" (resolved: ${p})`);
    }
  }
  return '';
}

// Reads an html-block body from either an inline string or a file path.
export function readBlockHtml(block, cwd, where) {
  if (typeof block.html === 'string' && block.html) return block.html;
  if (typeof block.htmlFile === 'string' && block.htmlFile.trim()) {
    const p = path.resolve(cwd, block.htmlFile);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      throw new CliError(`${where}: cannot read htmlFile "${block.htmlFile}" (resolved: ${p})`);
    }
  }
  return '';
}

// Reads a code/diff block body from an inline string field or a local file.
// `inlineKey` is the inline field (e.g. "code"/"diff"); `fileKey` its file
// twin (e.g. "codeFile"/"diffFile"). Returns '' when neither is present.
export function readTextSource(block, inlineKey, fileKey, cwd, where) {
  if (typeof block[inlineKey] === 'string' && block[inlineKey] !== '') return block[inlineKey];
  if (typeof block[fileKey] === 'string' && block[fileKey].trim()) {
    const p = path.resolve(cwd, block[fileKey]);
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch {
      throw new CliError(`${where}: cannot read ${fileKey} "${block[fileKey]}" (resolved: ${p})`);
    }
    if (buf.length > TEXT_FILE_MAX_BYTES) {
      throw new CliError(`${where}: ${fileKey} "${block[fileKey]}" is ${(buf.length / 1024).toFixed(0)}KB — max ${TEXT_FILE_MAX_BYTES / 1024}KB.`);
    }
    return buf.toString('utf8');
  }
  return '';
}

export function readAnyTextSource(block, inlineKeys, fileKeys, cwd, where, label) {
  for (const key of inlineKeys) {
    if (typeof block[key] === 'string' && block[key] !== '') return { text: block[key], sourceKey: key };
  }
  for (const key of fileKeys) {
    if (typeof block[key] === 'string' && block[key].trim()) {
      const p = path.resolve(cwd, block[key]);
      let buf;
      try {
        buf = fs.readFileSync(p);
      } catch {
        throw new CliError(`${where}: cannot read ${label} "${block[key]}" (resolved: ${p})`);
      }
      if (buf.length > TEXT_FILE_MAX_BYTES) {
        throw new CliError(`${where}: ${label} "${block[key]}" is ${(buf.length / 1024).toFixed(0)}KB — max ${TEXT_FILE_MAX_BYTES / 1024}KB.`);
      }
      return { text: buf.toString('utf8'), sourceKey: key, file: p };
    }
  }
  return { text: '', sourceKey: '' };
}
