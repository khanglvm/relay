// The video block: embed detection for YouTube and Vimeo, local and direct media.
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../util.js';
import { asStr, clampInt } from '../sources.js';
import { BLOCK_HEIGHT, VIDEO_MAX_BYTES, VIDEO_MIMES } from '../constants.js';

// Recognizes a YouTube / Vimeo URL (or a bare YouTube id) and returns
// {provider, videoId, start} for an iframe embed, else null. Cross-platform —
// pure string parsing, no URL host assumptions beyond the known providers.
function parseVideoEmbed(src) {
  const s = String(src).trim();
  // bare 11-char YouTube id
  if (/^[\w-]{11}$/.test(s)) return { provider: 'youtube', videoId: s, start: 0 };
  let m;
  if ((m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{11})/i))) {
    const t = s.match(/[?&](?:t|start)=(\d+)/);
    return { provider: 'youtube', videoId: m[1], start: t ? Number(t[1]) : 0 };
  }
  if ((m = s.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) {
    return { provider: 'vimeo', videoId: m[1], start: 0 };
  }
  return null;
}

// Normalizes one video block. `id` is the already-assigned block id.
export function normalizeVideoBlock(rawBlock, id, cwd, where, hasHeight) {
  const src = asStr(rawBlock.src ?? rawBlock.file ?? rawBlock.url).trim();
  if (!src) throw new CliError(`${where}: video block needs a "src" (YouTube/Vimeo URL, http(s) media URL, or local file path).`);
  const block = { id, type: 'video' };
  if (rawBlock.title !== undefined) block.title = asStr(rawBlock.title);
  if (rawBlock.alt !== undefined) block.title = asStr(rawBlock.alt);
  if (hasHeight) block.height = clampInt(rawBlock.height, BLOCK_HEIGHT.min, BLOCK_HEIGHT.max, undefined);
  const embed = parseVideoEmbed(src);
  if (embed) {
    block.provider = embed.provider;
    block.videoId = embed.videoId;
    if (embed.start) block.start = embed.start;
    return block;
  }
  if (/^https?:/i.test(src)) {
    block.src = src;
    const ext = path.extname(src.split(/[?#]/)[0]).slice(1).toLowerCase();
    if (VIDEO_MIMES[ext]) block.mime = VIDEO_MIMES[ext];
    return block;
  }
  // local file — kept as an absolute path the server streams (never embedded
  // in the payload). The client only learns a flag + mime via /video/b/<id>.
  const p = path.resolve(cwd, src);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = VIDEO_MIMES[ext];
  if (!mime) {
    throw new CliError(`${where}: unsupported video extension ".${ext}" — use ${Object.keys(VIDEO_MIMES).join('/')}, a YouTube/Vimeo URL, or an http(s) media URL.`);
  }
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    throw new CliError(`${where}: cannot read video "${src}" (resolved: ${p})`);
  }
  if (stat.size > VIDEO_MAX_BYTES) {
    throw new CliError(`${where}: video "${src}" is ${(stat.size / 1024 / 1024).toFixed(0)}MB — max ${VIDEO_MAX_BYTES / 1024 / 1024}MB.`);
  }
  block.file = p;
  block.mime = mime;
  if (!block.title) block.title = path.basename(p);
  return block;
}
