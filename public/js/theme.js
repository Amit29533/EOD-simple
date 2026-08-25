/**
 * Colour-theme manager for the Anthroprime ECOD workspace.
 *
 * Preferences: 'auto' (follow the OS), 'light', 'dark'. The preference is
 * persisted in localStorage and mirrored onto <html> as data-theme / data-theme-pref
 * so CSS can key everything off a single attribute. The same minimal logic is
 * inlined in index.html so the first paint is already correct (no flash).
 */
const STORAGE_KEY = 'anthroprime-ecod-theme';
export const THEME_PREFS = ['auto', 'light', 'dark'];

const THEME_COLORS = { light: '#eef6f7', dark: '#060f17' };

const media = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function themePref() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEME_PREFS.includes(stored) ? stored : 'auto';
  } catch { return 'auto'; }
}

/** The theme actually in effect ('light' | 'dark'), resolving 'auto' against the OS. */
export function resolvedTheme(pref = themePref()) {
  if (pref === 'auto') return media()?.matches ? 'dark' : 'light';
  return pref === 'dark' ? 'dark' : 'light';
}

const listeners = new Set();

/** Apply a preference to the document. Pass { persist: true } to remember it. */
export function applyTheme(pref = themePref(), { persist = false } = {}) {
  const wanted = THEME_PREFS.includes(pref) ? pref : 'auto';
  const theme = resolvedTheme(wanted);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePref = wanted;
  try { root.style.colorScheme = theme; } catch { /* older engines */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  if (persist) { try { localStorage.setItem(STORAGE_KEY, wanted); } catch { /* private mode */ } }
  for (const fn of listeners) { try { fn({ theme, pref: wanted }); } catch { /* listener error */ } }
  return theme;
}

export function setThemePref(pref) { return applyTheme(pref, { persist: true }); }

/** Flip between the two explicit themes (used by the topbar switch). */
export function toggleTheme() { return setThemePref(resolvedTheme() === 'dark' ? 'light' : 'dark'); }

/** Cycle auto → light → dark (used by keyboard shortcuts / icon cycling). */
export function nextThemePref() {
  const i = THEME_PREFS.indexOf(themePref());
  return setThemePref(THEME_PREFS[(i + 1) % THEME_PREFS.length]);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply the stored preference and follow OS changes while in 'auto'. Call once. */
export function initTheme() {
  applyTheme();
  const m = media();
  m?.addEventListener?.('change', () => { if (themePref() === 'auto') applyTheme(); });
}
