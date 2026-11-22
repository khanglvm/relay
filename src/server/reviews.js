// Share-link state and the per-reviewer side review sessions.
import crypto from 'node:crypto';

export const SHARE_STATE_VERSION = 2;
const REVIEW_SESSION_COOKIE = 'relay_review_session';

export function reviewSessionId(req) {
  if (req._relayReviewSessionId) return req._relayReviewSessionId;
  const explicit = String(req.headers['x-relay-review-session'] || '');
  const cookies = String(req.headers.cookie || '').split(';').map((s) => s.trim());
  const cookie = cookies.find((s) => s.startsWith(REVIEW_SESSION_COOKIE + '='));
  let value = explicit || (cookie ? decodeURIComponent(cookie.slice(REVIEW_SESSION_COOKIE.length + 1)) : '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) value = 'rv-' + crypto.randomBytes(12).toString('hex');
  req._relayReviewSessionId = value;
  return value;
}

export function reviewSessionCookie(sessionId) {
  return `${REVIEW_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
}

export function sideReviewState(record) {
  const drafts = record.reviewDrafts && typeof record.reviewDrafts === 'object' ? record.reviewDrafts : {};
  const submissions = Array.isArray(record.sideReviews) ? record.sideReviews : [];
  return {
    referenceOnly: true,
    note: 'Side reviews are reference only. Wait for the board owner (or owner-authorized collaborator) to submit the final answer.',
    submissions,
    drafts,
  };
}

export function pruneReviewDrafts(record, max = 50) {
  const drafts = record.reviewDrafts && typeof record.reviewDrafts === 'object' ? record.reviewDrafts : {};
  const entries = Object.entries(drafts).sort((a, b) => {
    const at = Date.parse(a[1] && a[1].updatedAt || '') || 0;
    const bt = Date.parse(b[1] && b[1].updatedAt || '') || 0;
    return bt - at;
  });
  record.reviewDrafts = Object.fromEntries(entries.slice(0, max));
}
