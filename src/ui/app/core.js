  const boot = JSON.parse(document.getElementById('boot').textContent);
  const spec = boot.spec;
  const responseRequired = spec.responseRequired !== false;
  const access = boot.access || {
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
  if (access.role) document.documentElement.dataset.accessRole = access.role;
  const QS = spec.questions || [];
  const app = document.getElementById('app');
  const banner = document.getElementById('banner');
  // Live-update baseline: the server's rev at page-build time. The heartbeat
  // compares /api/status.rev to this and reloads the board when it advances
  // (an agent ran `rly update`).
  const bootRev = typeof boot.rev === 'number' ? boot.rev : null;
  let seenDraftRev = typeof boot.draftRev === 'number' ? boot.draftRev : 0;

  function authHeaders(extra = {}) {
    const headers = access.token ? { ...extra, 'x-relay-share-token': access.token } : { ...extra };
    if (access.reviewSessionId) headers['x-relay-review-session'] = access.reviewSessionId;
    return headers;
  }
  const canPersistFeedback = responseRequired && Boolean(access.canEditAnswers || access.canComment || access.canEditBlocks);

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined) n.append(c.nodeType ? c : document.createTextNode(c));
    }
    return n;
  }

  // Small, self-dismissing toast pinned to the top-center of the viewport.
  // Used to flag a live `rly update` after the reload (accent-soft bg).
  function showToast(message) {
    const toast = el('div', { class: 'toast' }, message);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // True once the board has soft-timed-out (the agent stopped waiting) or the
  // live connection dropped — used to tailor the post-submit message. The board
  // stays fully usable either way; we never disable Submit.
  let handedBack = false;
  // Calm, persistent status notes (the #banner stack). tone 'info' is the
  // default neutral style; 'warn' is a softer amber, NOT the old red error.
  // Each message is shown at most once so the heartbeat can call it every tick.
  const notesShown = new Set();
  function showNotice(message, tone) {
    if (notesShown.has(message)) return;
    notesShown.add(message);
    if (banner.dataset.ready !== '1') {
      banner.replaceChildren();
      banner.dataset.ready = '1';
    }
    banner.className = 'banner-stack';
    banner.append(el('div', { class: 'banner-item ' + (tone === 'warn' ? 'warn' : 'info') }, message));
    banner.style.display = 'block';
  }

