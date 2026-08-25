/**
 * Anthroprime ECOD logo — the AP monogram whose crossbar is a handshake.
 *
 * Defined once here and reused by the sidebar, the sign-in screen and any
 * future surface. The artwork is monochrome: it paints in `currentColor`, so it
 * inherits the surrounding text colour and works on any background. The gaps
 * (the P counter and the outlines that separate the hands from the letters)
 * are punched with `--logo-cut`, which each context sets to whatever it sits
 * on — see .brand .mark / .auth-mark in styles.css.
 *
 * Static files for non-DOM contexts live in /public/brand:
 *   logo.svg  full-colour lockup on navy      icon.svg      rounded app tile
 *   logo.png  raster fallback / social card   favicon.svg   simplified for <32px
 */
export const LOGO_VIEWBOX = '0 0 320 220';

/** Inner SVG markup (no <svg> wrapper) — paints in currentColor. */
export const LOGO_INNER = `<g fill="currentColor"><path d="M8 196 L84 14 H112 L188 196 H150 L98 70 L46 196 Z"/><path d="M206 196 V14 H250 A47 47 0 0 1 250 108 H244 V196 Z"/></g>
  <path d="M244 40 A21 21 0 0 1 244 82 Z" fill="var(--logo-cut, #22314a)"/>
  <g transform="translate(26 154) rotate(-19) scale(0.95)">
    <path d="M-8 -14 H62 a15 15 0 0 1 0 30 H-8 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M212 -32 H150 a15 15 0 0 0 0 30 h62 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M52 -20 q36 -18 84 -16 a17 17 0 0 1 2 34 q-42 4 -84 14 a16 16 0 0 1 -2 -32 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M100 -32 q28 -6 48 -3 a7.5 7.5 0 0 1 -1 15 q-22 0 -47 6 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M62 4  q22 -9 37 -11 a6 6 0 0 1 3 12 q-18 3 -37 11 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M66 16 q21 -9 35 -11 a6 6 0 0 1 3 12 q-17 3 -35 11 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M71 28 q19 -9 32 -11 a6 6 0 0 1 3 12 q-15 3 -32 10 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/><path d="M77 39 q16 -8 27 -10 a5.5 5.5 0 0 1 3 11 q-13 3 -27 9 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="15" stroke-linejoin="round"/>
    <path d="M-8 -14 H62 a15 15 0 0 1 0 30 H-8 Z" fill="currentColor"/><path d="M212 -32 H150 a15 15 0 0 0 0 30 h62 Z" fill="currentColor"/><path d="M52 -20 q36 -18 84 -16 a17 17 0 0 1 2 34 q-42 4 -84 14 a16 16 0 0 1 -2 -32 Z" fill="currentColor"/><path d="M100 -32 q28 -6 48 -3 a7.5 7.5 0 0 1 -1 15 q-22 0 -47 6 Z" fill="currentColor"/><path d="M62 4  q22 -9 37 -11 a6 6 0 0 1 3 12 q-18 3 -37 11 Z" fill="currentColor"/><path d="M66 16 q21 -9 35 -11 a6 6 0 0 1 3 12 q-17 3 -35 11 Z" fill="currentColor"/><path d="M71 28 q19 -9 32 -11 a6 6 0 0 1 3 12 q-15 3 -32 10 Z" fill="currentColor"/><path d="M77 39 q16 -8 27 -10 a5.5 5.5 0 0 1 3 11 q-13 3 -27 9 Z" fill="currentColor"/>
    <path d="M62 4  q22 -9 37 -11 a6 6 0 0 1 3 12 q-18 3 -37 11 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="3.2" stroke-linejoin="round"/><path d="M66 16 q21 -9 35 -11 a6 6 0 0 1 3 12 q-17 3 -35 11 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="3.2" stroke-linejoin="round"/><path d="M71 28 q19 -9 32 -11 a6 6 0 0 1 3 12 q-15 3 -32 10 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="3.2" stroke-linejoin="round"/><path d="M77 39 q16 -8 27 -10 a5.5 5.5 0 0 1 3 11 q-13 3 -27 9 Z" fill="none" stroke="var(--logo-cut, #22314a)" stroke-width="3.2" stroke-linejoin="round"/>
  </g>`;

/**
 * A complete <svg> element for the mark.
 * @param {{ className?: string, title?: string }} [opts]
 */
export function logoSvg({ className = '', title = 'Anthroprime ECOD' } = {}) {
  return `<svg viewBox="${LOGO_VIEWBOX}" class="${className}" role="img" aria-label="${title}">${LOGO_INNER}</svg>`;
}
