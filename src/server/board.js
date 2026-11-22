// code-craft: allow-size runBoard is one closure over the live board state (rev, status, shares, presence); its route handlers read and write that state directly, so splitting them out would need a shared state object and change how it is passed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { filePreview, mediaType, splitFileReference } from '../file-preview.js';
import { resolveLink } from '../link.js';
import { openUrl } from '../open.js';
import { assertSpecReady, cleanAnswers } from '../spec/index.js';
import { loadBoard, removeRunning, saveBoard, saveBoardArtifact, savePref, saveRunning } from '../store.js';
import { SHARE_STATE_VERSION, pruneReviewDrafts, reviewSessionCookie, reviewSessionId, sideReviewState } from './reviews.js';
import { buildLockedPage, buildPage, shareHost } from './page.js';
import { isDirectLocalRequest, readBody, sameOrigin, sendDataImage, sendFromDir, sendHtml, sendJs, sendJson, wrapFragment } from './http.js';
import { UI_DIR, VENDOR_DIR } from './paths.js';
import { findBlock, findHtmlBlock, firstBoardHtml, firstQuestionHtml, sanitizeAnnotations, sanitizeBlockEdits } from './sanitize.js';
import { ARTIFACT_MAX_BYTES, ARTIFACT_MIMES, artifactBytesMatch, runOnResult } from './result.js';
import { buildOpenAllowlist, resolveLocalPath, streamFile } from './files.js';

// Serves one board on 127.0.0.1 and resolves `done` when it finishes
// (submitted / acknowledged / timeout / cancelled). The result is also
// persisted into the board record so `rly wait` / `rly result` can read it
// from another process.
export async function runBoard({ id, port = 0, open = true, timeoutSec = 86400, quiet = false, keepAliveOnTimeout = false, link = { mode: 'off' } }) {
  const record = loadBoard(id);
  if (!record) throw new Error(`board ${id} not found`);
  const spec = record.spec;

  // Reopening a finished board: seed the draft from its last submitted answers
  // (so the page prefills them), archive the old result, and go back to "open"
  // so wait/result reflect this run only.
  if (record.result) {
    if (record.result.answers) {
      record.draft = {
        answers: record.result.answers,
        comment: record.result.comment || '',
        notes: record.result.notes || {},
        annotations: record.result.annotations || [],
        blockEdits: record.result.blockEdits || {},
        updatedAt: new Date().toISOString(),
      };
    }
    // A soft-timeout result may predate side reviews submitted while the board
    // stayed live. Refresh that reference-only snapshot before archiving so a
    // later reopen does not discard late reviews/drafts from the historical run.
    const archivedResult = { ...record.result, sideReviews: sideReviewState(record) };
    record.pastResults = [...(record.pastResults || []), archivedResult].slice(-10);
    record.result = null;
    // Side reviews belong to the archived run. A reopened board starts a fresh
    // review round; carrying them forward would present stale reference input
    // as current and duplicate it into the next final result.
    record.sideReviews = [];
    record.reviewDrafts = {};
    saveBoard(record);
  }

  const startedAt = Date.now();
  // Mutation token: only `rly update` (which reads the running-file record)
  // can authenticate to POST /api/update. Never embedded in the page/boot.
  const token = crypto.randomBytes(16).toString('hex');
  const savedShares = record.share && typeof record.share === 'object' ? record.share : {};
  const savedShareVersion = Number(savedShares.version) || 1;
  const shareTokens = {
    collab: typeof savedShares.collab?.token === 'string' ? savedShares.collab.token : crypto.randomBytes(16).toString('hex'),
    // v1 reviewer links were comments-only. Rotate + deactivate them instead of
    // silently granting answer/side-submit permission after this upgrade.
    review: savedShareVersion >= SHARE_STATE_VERSION && typeof savedShares.review?.token === 'string'
      ? savedShares.review.token
      : crypto.randomBytes(16).toString('hex'),
    read: typeof savedShares.read?.token === 'string' ? savedShares.read.token : crypto.randomBytes(16).toString('hex'),
  };
  const activeShares = {
    collab: savedShares.collab?.active === true,
    review: savedShareVersion >= SHARE_STATE_VERSION && savedShares.review?.active === true,
    read: savedShares.read?.active === true,
  };
  let rev = 1;
  let draftRev = Number.isFinite(record.draftRev) ? record.draftRev : 0;
  let status = 'open';
  let finished = false;
  // Soft timeout: the board's time is up and a `timeout` result was handed back
  // to the waiting agent, but the server stays live so the user can keep
  // working and still submit. Surfaced via /api/status so the page can show a
  // calm "agent stopped waiting" note instead of disconnecting.
  let softTimedOut = false;
  // Presence that can lead to the terminal answer. Reviewer/read-only activity
  // must not keep an agent waiting for a submission those roles cannot finalize.
  const presenceByRole = { owner: null, collab: null, review: null, read: null };
  let actualPort = 0;
  let url = '';
  // The cross-device origin from a link setting (a link provider or a URL template), once resolved.
  let publicLink = null;
  const advertisedHost = shareHost();
  const accessFor = (req, reqUrl = null) => {
    if (isDirectLocalRequest(req) && (!publicLink || req.headers['x-relay-token'] === token)) {
      return {
        role: 'owner',
        canShare: true,
        canSubmit: true,
        canEditAnswers: true,
        canComment: true,
        canEditComments: true,
        canDeleteComments: true,
        canEditBlocks: true,
        canFinalize: true,
      };
    }
    const tokenValue = String(req.headers['x-relay-share-token'] || (reqUrl && reqUrl.searchParams.get('token')) || '');
    if (activeShares.collab && tokenValue === shareTokens.collab) {
      return {
        role: 'collab',
        token: shareTokens.collab,
        canShare: false,
        canSubmit: true,
        canEditAnswers: true,
        canComment: true,
        canEditComments: true,
        canDeleteComments: true,
        canEditBlocks: true,
        canFinalize: true,
      };
    }
    if (activeShares.review && tokenValue === shareTokens.review) {
      return {
        role: 'review',
        token: shareTokens.review,
        reviewSessionId: reviewSessionId(req),
        canShare: false,
        canSubmit: true,
        canEditAnswers: true,
        canComment: true,
        canEditComments: false,
        canDeleteComments: false,
        canEditBlocks: false,
        canFinalize: false,
      };
    }
    if (activeShares.read && tokenValue === shareTokens.read) {
      return {
        role: 'read',
        token: shareTokens.read,
        canShare: false,
        canSubmit: false,
        canEditAnswers: false,
        canComment: false,
        canEditComments: false,
        canDeleteComments: false,
        canEditBlocks: false,
        canFinalize: false,
      };
    }
    return {
      role: 'locked',
      canShare: false,
      canSubmit: false,
      canEditAnswers: false,
      canComment: false,
      canEditComments: false,
      canDeleteComments: false,
      canEditBlocks: false,
      canFinalize: false,
    };
  };
  const shareUrlFor = (role) => {
    const base = publicLink ? publicLink.origin : advertisedHost ? `http://${advertisedHost}:${actualPort}` : null;
    return base ? `${base}/?share=${role}&token=${shareTokens[role]}` : null;
  };
  const persistShareState = () => {
    record.share = {
      version: SHARE_STATE_VERSION,
      collab: { active: activeShares.collab === true, token: shareTokens.collab },
      review: { active: activeShares.review === true, token: shareTokens.review },
      read: { active: activeShares.read === true, token: shareTokens.read },
      updatedAt: new Date().toISOString(),
    };
    saveBoard(record);
  };
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const finalizerPresence = () => {
    const candidates = [presenceByRole.owner, presenceByRole.collab].filter(Boolean);
    return candidates.sort((a, b) => b.atMs - a.atMs)[0] || null;
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const pathname = reqUrl.pathname;
    const theme = reqUrl.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    try {
      if (req.method === 'GET' && pathname === '/') {
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') {
          sendHtml(res, buildLockedPage(record.spec.title));
        } else {
          const accessDraftRev = access.role === 'review'
            ? Number(record.reviewDrafts?.[access.reviewSessionId]?.draftRev) || 0
            : draftRev;
          const headers = access.role === 'review'
            ? { 'set-cookie': reviewSessionCookie(access.reviewSessionId) }
            : {};
          sendHtml(res, buildPage(record, rev, { access, draftRev: accessDraftRev }), headers);
        }
      } else if (req.method === 'GET' && pathname === '/api/board') {
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') return sendJson(res, 403, { error: 'share link is not active' });
        const sourceDraft = access.role === 'review'
          ? (record.reviewDrafts?.[access.reviewSessionId] || null)
          : record.draft;
        sendJson(res, 200, { id: record.id, spec: record.spec, draft: sourceDraft, result: record.result });
      } else if (req.method === 'GET' && pathname === '/api/status') {
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') return sendJson(res, 403, { error: 'share link is not active' });
        const accessDraftRev = access.role === 'review'
          ? Number(record.reviewDrafts?.[access.reviewSessionId]?.draftRev) || 0
          : draftRev;
        sendJson(res, 200, { status, rev, draftRev: accessDraftRev, softTimedOut });
      } else if (req.method === 'GET' && pathname === '/api/draft') {
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') return sendJson(res, 403, { error: 'share link is not active' });
        const sourceDraft = access.role === 'review'
          ? (record.reviewDrafts?.[access.reviewSessionId] || null)
          : record.draft;
        const accessDraftRev = access.role === 'review'
          ? Number(sourceDraft?.draftRev) || 0
          : draftRev;
        sendJson(res, 200, { draft: sourceDraft || null, draftRev: accessDraftRev });
      } else if (req.method === 'POST' && pathname === '/api/ping') {
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') return sendJson(res, 403, { error: 'share link is not active' });
        const body = JSON.parse((await readBody(req)) || '{}');
        // Validate body shape: visible/focused booleans, idleMs finite >= 0.
        if (
          typeof body.visible === 'boolean' &&
          typeof body.focused === 'boolean' &&
          Number.isFinite(body.idleMs) &&
          body.idleMs >= 0
        ) {
          presenceByRole[access.role] = { atMs: Date.now(), visible: body.visible, focused: body.focused, idleMs: body.idleMs };
        }
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'GET' && pathname === '/api/presence') {
        const presence = finalizerPresence();
        if (!presence) {
          sendJson(res, 200, { open: true, seen: false });
        } else {
          sendJson(res, 200, {
            open: true,
            seen: true,
            visible: presence.visible,
            focused: presence.focused,
            secondsSinceActivity: Math.round((Date.now() - presence.atMs + presence.idleMs) / 1000),
            secondsSincePing: Math.round((Date.now() - presence.atMs) / 1000),
          });
        }
      } else if (req.method === 'POST' && pathname === '/api/update') {
        if (req.headers['x-relay-token'] !== token) return sendJson(res, 403, { error: 'forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const next = body.spec;
        if (next === null || typeof next !== 'object' || Array.isArray(next) ||
            !Array.isArray(next.questions) || !Array.isArray(next.blocks)) {
          return sendJson(res, 400, { error: 'spec must be an object with questions[] and blocks[] arrays' });
        }
        try {
          await assertSpecReady(next);
        } catch (err) {
          return sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
        }
        record.spec = next;
        rev++;
        saveBoard(record);
        sendJson(res, 200, { ok: true, rev });
      } else if (req.method === 'GET' && pathname === '/kit.js') {
        if (!sendFromDir(res, UI_DIR, 'kit.js', 'application/javascript; charset=utf-8')) {
          sendJs(res, ''); // kit.js authored concurrently — empty fallback keeps iframes working
        }
      } else if (req.method === 'GET' && pathname.startsWith('/vendor/')) {
        const name = decodeURIComponent(pathname.slice('/vendor/'.length));
        if (!sendFromDir(res, VENDOR_DIR, name, 'application/javascript; charset=utf-8')) {
          sendJson(res, 404, { error: `no vendor file "${name}"` });
        }
      } else if (req.method === 'GET' && pathname.startsWith('/html/b/')) {
        const blockId = decodeURIComponent(pathname.slice('/html/b/'.length));
        const block = findHtmlBlock(record.spec, blockId);
        if (!block) return sendJson(res, 404, { error: `no html block "${blockId}"` });
        const access = accessFor(req, reqUrl);
        sendHtml(res, wrapFragment(block.html || '', theme, access.canComment === true && record.spec.responseRequired !== false));
      } else if (req.method === 'GET' && pathname.startsWith('/img/b/')) {
        // Embedded image bytes (image blocks authored from local files).
        const blockId = decodeURIComponent(pathname.slice('/img/b/'.length));
        const block = findBlock(record.spec, blockId, 'image');
        if (!sendDataImage(res, block?.src)) return sendJson(res, 404, { error: `no embedded image block "${blockId}"` });
      } else if (req.method === 'GET' && pathname.startsWith('/img/p/')) {
        // Embedded tile image bytes (pick questions authored from local files).
        const [questionId, itemId] = pathname.slice('/img/p/'.length).split('/').map(decodeURIComponent);
        const tile = record.spec.questions.find((q) => q.id === questionId && q.type === 'pick')?.items.find((t) => t.id === itemId);
        if (!sendDataImage(res, tile?.image)) return sendJson(res, 404, { error: `no embedded tile image "${questionId}/${itemId}"` });
      } else if (req.method === 'POST' && pathname === '/api/artifact') {
        if (record.spec.responseRequired === false) return sendJson(res, 409, { error: 'display-only boards do not collect feedback' });
        if (!sameOrigin(req, actualPort, [advertisedHost], [publicLink?.origin])) return sendJson(res, 403, { error: 'cross-origin artifact upload rejected' });
        const access = accessFor(req, reqUrl);
        if (!access.canComment) return sendJson(res, 403, { error: 'this share cannot add comments' });
        const body = JSON.parse((await readBody(req, 6 * 1024 * 1024)) || '{}');
        const blockId = typeof body.blockId === 'string' ? body.blockId : '';
        const block = findBlock(record.spec, blockId, 'image') || findBlock(record.spec, blockId, 'compare');
        if (!block) return sendJson(res, 404, { error: `no image or comparison block "${blockId}"` });
        const match = typeof body.dataUrl === 'string'
          ? body.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
          : null;
        if (!match || !ARTIFACT_MIMES[match[1]]) return sendJson(res, 400, { error: 'artifact must be a PNG, JPEG, or WebP data URL' });
        const bytes = Buffer.from(match[2], 'base64');
        if (bytes.length < 1 || bytes.length > ARTIFACT_MAX_BYTES) return sendJson(res, 400, { error: 'artifact image is empty or larger than 4 MB' });
        if (!artifactBytesMatch(match[1], bytes)) return sendJson(res, 400, { error: 'artifact bytes do not match the declared image type' });
        const target = saveBoardArtifact(record.id, bytes, ARTIFACT_MIMES[match[1]]);
        sendJson(res, 200, {
          ok: true,
          path: target,
          name: path.basename(target),
          mime: match[1],
          bytes: bytes.length,
          width: Math.max(1, Math.min(10000, Number.parseInt(body.width, 10) || 1)),
          height: Math.max(1, Math.min(10000, Number.parseInt(body.height, 10) || 1)),
        });
      } else if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/video/b/')) {
        // Local video bytes, Range-streamed so the <video> element can seek.
        const blockId = decodeURIComponent(pathname.slice('/video/b/'.length));
        const block = findBlock(record.spec, blockId, 'video');
        if (!block || typeof block.file !== 'string') return sendJson(res, 404, { error: `no local video block "${blockId}"` });
        streamFile(req, res, block.file, block.mime || 'application/octet-stream');
      } else if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/pdf/b/')) {
        // Local PDF bytes, Range-streamed for the browser's built-in PDF viewer.
        const blockId = decodeURIComponent(pathname.slice('/pdf/b/'.length));
        const block = findBlock(record.spec, blockId, 'pdf');
        if (!block || typeof block.file !== 'string') return sendJson(res, 404, { error: `no local pdf block "${blockId}"` });
        streamFile(req, res, block.file, block.mime || 'application/pdf');
      } else if (req.method === 'GET' && pathname === '/html/board') {
        // Legacy alias → the board's first html block.
        const block = firstBoardHtml(record.spec);
        const access = accessFor(req, reqUrl);
        sendHtml(res, wrapFragment((block && block.html) || '', theme, access.canComment === true && record.spec.responseRequired !== false));
      } else if (req.method === 'GET' && pathname.startsWith('/html/q/')) {
        const qid = decodeURIComponent(pathname.slice('/html/q/'.length));
        const q = record.spec.questions.find((q) => q.id === qid);
        if (!q) return sendJson(res, 404, { error: `no question "${qid}"` });
        const block = firstQuestionHtml(q);
        const access = accessFor(req, reqUrl);
        sendHtml(res, wrapFragment((block && block.html) || '', theme, access.canComment === true && record.spec.responseRequired !== false));
      } else if (req.method === 'POST' && pathname === '/api/pref') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (['auto', 'light', 'dark'].includes(body.theme)) savePref({ theme: body.theme });
        if (typeof body.fontScale === 'number' && body.fontScale >= 0.5 && body.fontScale <= 2) {
          savePref({ fontScale: body.fontScale });
        }
        sendJson(res, 200, { ok: true });
      } else if ((req.method === 'POST' && ['/api/open', '/api/file-preview'].includes(pathname)) ||
                 (['GET', 'HEAD'].includes(req.method) && pathname === '/api/file-content')) {
        // Preview, stream, or open only a board-referenced local file. All three
        // paths share the same origin, role, and reference allowlist checks.
        if (!sameOrigin(req, actualPort, [advertisedHost], [publicLink?.origin])) return sendJson(res, 403, { error: 'cross-origin requests cannot open files' });
        const access = accessFor(req, reqUrl);
        if (access.role !== 'owner' && access.role !== 'collab') return sendJson(res, 403, { error: 'this share cannot open local files' });
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : { path: reqUrl.searchParams.get('path') };
        const raw = typeof body.path === 'string' ? body.path : '';
        if (!raw.trim()) return sendJson(res, 400, { error: 'missing "path"' });
        const baseCwd = record.cwd || process.cwd();
        const target = resolveLocalPath(raw, baseCwd);
        if (!target) return sendJson(res, 400, { error: 'invalid path' });
        if (!buildOpenAllowlist(record.spec, baseCwd).has(target)) {
          return sendJson(res, 403, { error: 'this path is not referenced on the board' });
        }
        let stat = null;
        try {
          stat = fs.statSync(target);
        } catch {
          stat = null;
        }
        if (!stat) return sendJson(res, 404, { error: 'file not found', path: target });
        if (pathname === '/api/file-preview') {
          return sendJson(res, 200, { ok: true, ...filePreview(target, stat, splitFileReference(raw)) });
        }
        if (pathname === '/api/file-content') {
          const media = mediaType(target);
          if (!stat.isFile() || !media) return sendJson(res, 415, { error: 'this file type cannot be streamed' });
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          return streamFile(req, res, target, media[1]);
        }
        if (!openUrl(target)) return sendJson(res, 500, { error: 'could not open the file' });
        sendJson(res, 200, { ok: true, path: target, name: path.basename(target) });
      } else if (req.method === 'POST' && pathname === '/api/draft') {
        if (record.spec.responseRequired === false) return sendJson(res, 409, { error: 'display-only boards do not collect feedback' });
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') return sendJson(res, 403, { error: 'share link is not active' });
        if (!access.canEditAnswers && !access.canComment && !access.canEditBlocks) {
          return sendJson(res, 403, { error: 'this share is read only' });
        }
        const body = JSON.parse((await readBody(req)) || '{}');
        const draftAnswers = cleanAnswers(record.spec, body.answers && typeof body.answers === 'object' ? body.answers : {});
        if (access.role === 'review') {
          record.reviewDrafts = record.reviewDrafts && typeof record.reviewDrafts === 'object' ? record.reviewDrafts : {};
          const priorRev = Number(record.reviewDrafts[access.reviewSessionId]?.draftRev) || 0;
          record.reviewDrafts[access.reviewSessionId] = {
            answers: draftAnswers,
            comment: typeof body.comment === 'string' ? body.comment : '',
            notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
            annotations: sanitizeAnnotations(body.annotations, record.id),
            blockEdits: {},
            draftRev: priorRev + 1,
            updatedAt: new Date().toISOString(),
          };
          pruneReviewDrafts(record);
        } else {
          record.draft = {
            answers: draftAnswers,
            comment: typeof body.comment === 'string' ? body.comment : '',
            notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
            annotations: sanitizeAnnotations(body.annotations, record.id),
            blockEdits: sanitizeBlockEdits(body.blockEdits),
            updatedAt: new Date().toISOString(),
          };
        }
        if (access.role !== 'review') record.draftRev = ++draftRev;
        saveBoard(record);
        const accessDraftRev = access.role === 'review'
          ? Number(record.reviewDrafts?.[access.reviewSessionId]?.draftRev) || 0
          : draftRev;
        sendJson(res, 200, { ok: true, draftRev: accessDraftRev });
      } else if (req.method === 'POST' && pathname === '/api/submit') {
        if (record.spec.responseRequired === false) return sendJson(res, 409, { error: 'display-only boards do not accept submissions' });
        const access = accessFor(req, reqUrl);
        if (access.role === 'locked') return sendJson(res, 403, { error: 'share link is not active' });
        if (!access.canSubmit) return sendJson(res, 403, { error: 'this share is read only' });
        if (status !== 'open') return sendJson(res, 409, { error: 'board already finished' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const answers = cleanAnswers(record.spec, body.answers && typeof body.answers === 'object' ? body.answers : {});
        const skipped = record.spec.questions.filter((q) => !(q.id in answers)).map((q) => q.id);
        if (access.role === 'review') {
          const review = {
            id: 'sr-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
            status: 'side-review',
            final: false,
            referenceOnly: true,
            reviewSessionId: access.reviewSessionId,
            answers,
            skipped,
            comment: typeof body.comment === 'string' ? body.comment : '',
            notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
            annotations: sanitizeAnnotations(body.annotations, record.id),
            blockEdits: {},
            submittedAt: new Date().toISOString(),
          };
          record.sideReviews = [...(Array.isArray(record.sideReviews) ? record.sideReviews : []), review].slice(-50);
          if (record.reviewDrafts && typeof record.reviewDrafts === 'object') delete record.reviewDrafts[access.reviewSessionId];
          saveBoard(record);
          // Deliberately no finish(), record.result write, on-result hook, or
          // server close: a side review never wakes/completes the waiting agent.
          return sendJson(res, 200, {
            ok: true,
            sideReview: true,
            final: false,
            reviewId: review.id,
            message: 'Saved as a reference-only side review. The board still awaits the owner final answer.',
          });
        }
        sendJson(res, 200, { ok: true });
        finish({
          status: record.spec.questions.length ? 'submitted' : 'acknowledged',
          answers,
          skipped,
          comment: typeof body.comment === 'string' ? body.comment : '',
          notes: body.notes && typeof body.notes === 'object' ? body.notes : {},
          annotations: sanitizeAnnotations(body.annotations, record.id),
          blockEdits: sanitizeBlockEdits(body.blockEdits),
        });
      } else if (req.method === 'GET' && pathname === '/api/share') {
        if (accessFor(req, reqUrl).role !== 'owner') return sendJson(res, 403, { error: 'only the board owner can manage sharing' });
        const roles = {};
        for (const role of ['collab', 'review', 'read']) {
          roles[role] = {
            active: activeShares[role] === true,
            url: activeShares[role] === true ? shareUrlFor(role) : null,
          };
        }
        sendJson(res, 200, { ok: true, roles });
      } else if (req.method === 'POST' && pathname === '/api/share') {
        if (accessFor(req, reqUrl).role !== 'owner') return sendJson(res, 403, { error: 'only the board owner can activate sharing' });
        if (!advertisedHost) return sendJson(res, 400, { error: 'no LAN IPv4 address found for sharing' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const role = body.role === 'review' ? 'review' : body.role === 'collab' ? 'collab' : body.role === 'read' ? 'read' : null;
        if (!role) return sendJson(res, 400, { error: 'role must be "collab", "review", or "read"' });
        activeShares[role] = true;
        persistShareState();
        sendJson(res, 200, { ok: true, role, url: shareUrlFor(role) });
      } else if (req.method === 'DELETE' && pathname === '/api/share') {
        if (accessFor(req, reqUrl).role !== 'owner') return sendJson(res, 403, { error: 'only the board owner can manage sharing' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const role = body.role === 'review' ? 'review' : body.role === 'collab' ? 'collab' : body.role === 'read' ? 'read' : body.role === 'all' ? 'all' : null;
        if (!role) return sendJson(res, 400, { error: 'role must be "collab", "review", "read", or "all"' });
        if (role === 'all') {
          activeShares.collab = false;
          activeShares.review = false;
          activeShares.read = false;
        } else {
          activeShares[role] = false;
        }
        persistShareState();
        sendJson(res, 200, { ok: true, role, active: false });
      } else {
        sendJson(res, 404, { error: 'not found' });
      }
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
    }
  });

  // Bind the requested port (reopen/rescue reuse the board's last port so a
  // still-open tab reconnects). A board just stopped on that port holds its
  // listening socket through a short close grace, so a stop-then-reopen on the
  // same port can briefly hit EADDRINUSE — retry for ~2s to ride that out before
  // giving up. Only then fall back to a random free port rather than failing.
  await new Promise((/** @type {(value?: unknown) => void} */ resolve, reject) => {
    const RETRY_MS = 200;
    const MAX_RETRIES = 10; // ~2s — covers a prior server's ~600ms close grace
    let retries = 0;
    const bind = (p, allowFallback) => {
      const onErr = (e) => {
        if (allowFallback && e && e.code === 'EADDRINUSE' && p !== 0) {
          if (retries++ < MAX_RETRIES) {
            setTimeout(() => bind(p, true), RETRY_MS); // port freeing up — retry it
          } else {
            bind(0, false); // still busy after retries → random free port
          }
        } else {
          reject(e);
        }
      };
      server.once('error', onErr);
      server.listen(p, '0.0.0.0', () => {
        server.removeListener('error', onErr);
        resolve();
      });
    };
    bind(port, true);
  });
  actualPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const localUrl = `http://127.0.0.1:${actualPort}/`;
  url = localUrl;
  try {
    publicLink = await resolveLink(link, actualPort);
  } catch (err) {
    server.close();
    throw err;
  }
  if (publicLink) {
    // Requests through the link are never the owner; the collaborator token in
    // the URL is what lets the owner's browsers answer and submit.
    activeShares.collab = true;
    url = shareUrlFor('collab');
  }
  // Remember the port this board last bound, so `rly rescue <id>` can re-serve
  // on the SAME port — letting a still-open (but disconnected) browser tab
  // reconnect to its relative /api/* URLs without the user touching anything.
  if (record.lastPort !== actualPort) {
    record.lastPort = actualPort;
    saveBoard(record);
  }
  saveRunning({
    id: record.id,
    pid: process.pid,
    port: actualPort,
    url,
    localUrl,
    link: publicLink ? publicLink.kind : null,
    title: spec.title,
    token,
    startedAt: new Date().toISOString(),
  });

  let timer = null;
  // The detached server's timeout is SOFT (keepAliveOnTimeout): at the deadline
  // we hand a `timeout` result back to the waiting agent (so `rly wait` returns
  // with the autosaved draft) but keep the server listening, so the user can
  // keep working and still submit. A late submit overwrites the result with
  // `submitted` and re-fires the push-wake; the board only truly closes on
  // submit or an explicit stop. A BLOCKING `rly ask` has no separate waiter to
  // hand back to, so its timeout stays hard (close + resolve, exit 2).
  if (timeoutSec > 0) {
    timer = setTimeout(keepAliveOnTimeout ? softTimeout : () => finish({ status: 'timeout' }), timeoutSec * 1000);
  }
  const onSignal = () => finish({ status: 'cancelled' });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Build + persist a result object onto the record (read cross-process by
  // `rly wait` / `rly result`). Does NOT touch the server lifecycle.
  function persistResult(partial) {
    // blockEdits: from this submit, else fall back to the autosaved draft
    // (timeout/cancel). null when there are none.
    const editsRaw = partial.blockEdits ?? (record.draft?.blockEdits || {});
    const blockEdits = editsRaw && Object.keys(editsRaw).length ? editsRaw : null;
    const result = {
      status: partial.status,
      boardId: record.id,
      title: spec.title,
      url,
      answers: partial.answers ?? null,
      skipped: partial.skipped ?? null,
      comment: partial.comment ?? '',
      // Per-question notes are first-class feedback. Always emit the key (even
      // empty {}) so a consumer can SEE it exists and never silently misses a
      // note the user left under a question. Falls back to the autosaved draft
      // on timeout/cancel.
      notes: partial.notes ?? (record.draft?.notes || {}),
      annotations: partial.annotations ?? (record.draft?.annotations || []),
      blockEdits,
      sideReviews: sideReviewState(record),
      createdAt: record.createdAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    // Drafts autosave in real time, so even an abandoned board surfaces the
    // partial answers the user had typed.
    if ((partial.status === 'timeout' || partial.status === 'cancelled') && record.draft) {
      result.draft = record.draft;
    }
    record.result = result;
    saveBoard(record);
    return result;
  }

  // Tear the HTTP server down after a short grace (so the success page renders
  // and auto-closes first). The result is assumed already persisted.
  function closeServer(result) {
    removeRunning(record.id);
    if (publicLink) publicLink.release();
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        // best effort
      }
      server.close(() => resolveDone(result));
      setTimeout(() => resolveDone(result), 1500).unref();
    }, 600);
  }

  // Terminal finish (submit / acknowledge / explicit cancel): persist the
  // result, push-wake the agent for EVERY terminal status, and close the
  // server. A late submit after a soft timeout lands here and overwrites the
  // earlier `timeout` result with `submitted` (re-firing the push-wake).
  function finish(partial) {
    if (finished) return;
    finished = true;
    status = partial.status;
    const result = persistResult(partial);
    runOnResult(record.onResult, result, { quiet });
    closeServer(result);
  }

  // SOFT timeout — hand a `timeout` result to the agent but keep the board live
  // and submittable. The agent's `rly wait` returns now; the user can carry on.
  function softTimeout() {
    if (finished || softTimedOut) return;
    softTimedOut = true;
    const result = persistResult({ status: 'timeout' });
    runOnResult(record.onResult, result, { quiet });
  }

  if (open && !publicLink) openUrl(url);
  if (!quiet) {
    process.stderr.write(
      `[relay] ${record.id} open: ${url} (waiting for submit; timeout: ${timeoutSec > 0 ? `${timeoutSec}s` : 'none'})\n`
    );
  }
  return { url, port: actualPort, done };
}
