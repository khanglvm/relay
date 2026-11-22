  // ---------- theme (auto -> light -> dark) ----------
  // Server-side pref wins: boards run on random ports, so localStorage alone
  // can't carry the choice across boards. The server persists it globally.
  const THEME_KEY = 'qb-theme';
  const THEMES = ['auto', 'light', 'dark'];
  let theme = (boot.pref && boot.pref.theme) || localStorage.getItem(THEME_KEY);
  if (!THEMES.includes(theme)) theme = 'auto';
  function effectiveTheme() {
    if (theme !== 'auto') return theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme() {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    if (themeBtn) themeBtn.textContent = { auto: '◐ auto', light: '☀ light', dark: '☾ dark' }[theme];
    // Custom-HTML iframes get ?theme=light|dark so authors can match the theme.
    for (const f of document.querySelectorAll('iframe.viz')) {
      try {
        const u = new URL(f.src);
        if (u.searchParams.get('theme') !== effectiveTheme()) {
          u.searchParams.set('theme', effectiveTheme());
          f.src = u.toString();
        }
      } catch {
        // ignore malformed src
      }
    }
    // Re-theme native blocks (mermaid re-render, chart grid/tick restyle).
    if (window.RelayBlocks && typeof RelayBlocks.onThemeChange === 'function') {
      try {
        RelayBlocks.onThemeChange(effectiveTheme());
      } catch {
        // blocks may not be rendered yet
      }
    }
  }
  let themeBtn = null;

  // ---------- font scale (A− / A+) ----------
  // A page-zoom knob: scales the root font-size (every rem) so the whole board
  // grows/shrinks. Persists like the theme — server pref + localStorage mirror —
  // so the choice carries across the random-port boards.
  const FS_KEY = 'qb-fontscale';
  const FS_MIN = 0.85, FS_MAX = 1.5, FS_STEP = 0.1;
  let fontScale = Number((boot.pref && boot.pref.fontScale) || localStorage.getItem(FS_KEY));
  if (!Number.isFinite(fontScale) || fontScale <= 0) fontScale = 1;
  const clampFs = (n) => Math.min(FS_MAX, Math.max(FS_MIN, Math.round(n * 100) / 100));
  fontScale = clampFs(fontScale);
  function applyFontScale() {
    document.documentElement.style.setProperty('--fs', String(fontScale));
  }
  function setFontScale(next) {
    fontScale = clampFs(next);
    applyFontScale();
    try { localStorage.setItem(FS_KEY, String(fontScale)); } catch { /* private mode */ }
    fetch('/api/pref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fontScale }),
    }).catch(() => {});
  }
  applyFontScale();

