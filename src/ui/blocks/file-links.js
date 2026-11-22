  // ---------- file-link open behavior ----------
  let fileDialog = null;
  const fileAuthHeaders = () => {
    const token = new URLSearchParams(location.search).get('token');
    return token ? { 'x-relay-share-token': token } : {};
  };

  async function previewFilePath(a) {
    const p = a.dataset.rlyOpen;
    if (!p) return;
    if (fileDialog) fileDialog.close();
    const dialog = el('dialog', { class: 'rly-file-dialog', 'aria-label': 'File preview' });
    const title = el('h2', {}, p.split(/[\\/]/).pop());
    const pathLabel = el('div', { class: 'rly-file-location', title: p }, p);
    const close = el('button', { type: 'button', class: 'btn', autofocus: '', 'aria-label': 'Close file preview' }, 'Close');
    const open = el('button', { type: 'button', class: 'btn' }, 'Open in app');
    open.dataset.rlyOpen = p;
    open.addEventListener('click', () => openFilePath(open));
    const actions = el('div', { class: 'rly-file-actions' }, open, close);
    const body = el('div', { class: 'rly-file-body', tabindex: '0', 'aria-busy': 'true' });
    const status = el('p', { role: 'status' }, 'Loading preview…');
    body.append(status);
    dialog.append(el('header', { class: 'rly-file-header' }, el('div', { class: 'rly-file-heading' }, title, pathLabel), actions), body);
    const controller = new AbortController();
    const previousFocus = document.activeElement;
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      controller.abort();
      dialog.querySelectorAll('video,audio').forEach((media) => { media.pause(); media.removeAttribute('src'); media.load(); });
      dialog.remove();
      if (fileDialog === dialog) fileDialog = null;
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    });
    document.body.append(dialog);
    fileDialog = dialog;
    dialog.showModal();
    try {
      const response = await fetch('/api/file-preview', {
        method: 'POST', headers: { 'content-type': 'application/json', ...fileAuthHeaders() },
        body: JSON.stringify({ path: p }), signal: controller.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('File previews need a current Relay browser board. Reconnect this board with the updated CLI.'); }
      if (!response.ok || !data.ok) {
        if (response.status === 403) open.disabled = true;
        throw new Error(data.error || 'Preview unavailable. Reconnect this board with the updated CLI.');
      }
      if (!dialog.open) return;
      title.textContent = data.name;
      dialog.setAttribute('aria-label', 'File preview: ' + data.name);
      body.replaceChildren();
      const source = () => {
        body.replaceChildren();
        const lines = String(data.text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
        const list = el('div', { class: 'rly-file-source' });
        lines.forEach((line, i) => {
          const number = i + 1;
          const code = el('code');
          code.innerHTML = tintCode(line, data.lang) || ' ';
          const row = el('div', { class: 'rly-file-line', 'data-line': String(number) },
            el('span', { class: 'rly-file-line-number', 'aria-hidden': 'true' }, String(number)), code);
          if (data.line && number >= data.line && number <= data.endLine) row.classList.add('is-target');
          list.append(row);
        });
        if (data.line > lines.length) body.append(el('p', { role: 'status' }, 'Line ' + data.line + ' is beyond this file’s ' + lines.length + ' lines.'));
        body.append(list);
        requestAnimationFrame(() => {
          const target = list.querySelector('.is-target');
          if (!target || !dialog.open) return;
          body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2 + target.clientHeight / 2;
          body.scrollLeft = 0;
        });
      };
      const rendered = () => {
        body.replaceChildren();
        if (data.kind === 'markdown') {
          const md = el('div', { class: 'blk-markdown' });
          md.append(renderMarkdown(data.text));
          body.append(md);
        } else if (data.kind === 'table') {
          body.append(renderTable(data.block, { canComment: false }, 'file-preview'));
        } else if (data.kind === 'html') {
          // Empty sandbox prevents scripts, forms and same-origin access. CSP
          // also prevents authored markup from fetching local or remote URLs.
          const frame = el('iframe', { class: 'rly-file-frame', title: data.name, sandbox: '', referrerpolicy: 'no-referrer' });
          frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; font-src data:">' + data.text;
          body.append(frame);
        }
      };
      if (['markdown', 'html', 'table'].includes(data.kind)) {
        let viewingSource = !!data.line;
        const toggle = el('button', { type: 'button', class: 'btn' }, viewingSource ? 'Preview' : 'Source');
        toggle.addEventListener('click', () => {
          viewingSource = !viewingSource;
          toggle.textContent = viewingSource ? 'Preview' : 'Source';
          viewingSource ? source() : rendered();
        });
        actions.prepend(toggle);
        viewingSource ? source() : rendered();
      } else if (data.kind === 'code') source();
      else if (data.kind === 'unsupported') body.append(el('p', { role: 'status' }, data.reason));
      else {
        const params = new URLSearchParams({ path: p });
        const token = new URLSearchParams(location.search).get('token');
        if (token) params.set('token', token);
        const url = '/api/file-content?' + params;
        const tag = { image: 'img', pdf: 'iframe', video: 'video', audio: 'audio' }[data.kind];
        if (!tag) throw new Error('This file type cannot be previewed.');
        const media = el(tag, { class: 'rly-file-media rly-file-' + data.kind, src: url, title: data.name });
        if (tag === 'img') media.alt = data.name;
        if (tag === 'video' || tag === 'audio') { media.controls = true; media.preload = 'metadata'; }
        media.addEventListener('error', () => body.append(el('p', { role: 'status' }, 'Your browser could not display this file. Use Open in app.')), { once: true });
        body.append(media);
      }
    } catch (err) {
      if (err.name !== 'AbortError' && dialog.open) body.replaceChildren(el('p', { role: 'alert' }, err.message || 'Could not reach the board server.'));
    } finally { body.setAttribute('aria-busy', 'false'); }
  }

  // A small toast pinned top-center (reuses the .toast style from style.css).
  // tone 'err' adds .toast-err so failures read as a problem, not a success.
  function fileToast(message, tone) {
    const t = el('div', { class: 'toast' + (tone === 'err' ? ' toast-err' : '') }, message);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  // POST the clicked path to /api/open; the server opens it in the OS default
  // app. The link is disabled mid-flight so a double-click can't double-open.
  async function openFilePath(a) {
    const p = a.dataset.rlyOpen;
    if (!p || a.classList.contains('is-opening')) return;
    a.classList.add('is-opening');
    try {
      const r = await fetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...fileAuthHeaders() },
        body: JSON.stringify({ path: p }),
      });
      let data = {};
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      if (r.ok && data.ok) fileToast('Opened ' + (data.name || p));
      else fileToast((data.error || 'Could not open') + ' — ' + p, 'err');
    } catch {
      fileToast('Could not reach the server to open ' + p, 'err');
    } finally {
      a.classList.remove('is-opening');
    }
  }

  // Delegated once on the document so it catches file-links anywhere they are
  // rendered — the intro, any markdown block, or a markdown pipe-table cell.
  // Keyboard-activatable (Enter/Space) since the links are role="link" anchors
  // with no href (the open happens via fetch, not navigation).
  function initFileLinks() {
    if (window.__relayFileLinksReady) return;
    window.__relayFileLinksReady = true;
    const hit = (e) => (e.target.closest ? e.target.closest('a.rly-filelink') : null);
    document.addEventListener('click', (e) => {
      const a = hit(e);
      if (!a) return;
      e.preventDefault();
      previewFilePath(a);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const a = hit(e);
      if (!a) return;
      e.preventDefault();
      previewFilePath(a);
    });
  }
  initFileLinks();
  initRefLinks();

