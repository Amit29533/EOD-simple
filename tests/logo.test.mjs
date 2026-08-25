/**
 * Brand mark tests: the AP-handshake logo must render as an accessible,
 * theme-agnostic SVG and be wired into both the sidebar and the sign-in screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');

const { logoSvg, LOGO_INNER, LOGO_VIEWBOX } = await import('../public/js/logo.js');

test('logo module renders an accessible, self-describing SVG', () => {
  const svg = logoSvg();
  assert.match(svg, /^<svg /, 'is an svg element');
  assert.match(svg, /viewBox="0 0 320 220"/);
  assert.equal(LOGO_VIEWBOX, '0 0 320 220');
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="Anthroprime ECOD"/, 'names the brand for screen readers');
  assert.ok(!/<svg[\s\S]*<svg/.test(svg), 'no nested svg');
});

test('logo accepts a class name and a custom title', () => {
  const svg = logoSvg({ className: 'mark-svg', title: 'Home' });
  assert.match(svg, /class="mark-svg"/);
  assert.match(svg, /aria-label="Home"/);
});

test('logo is monochrome: inherits currentColor, punches gaps with --logo-cut', () => {
  assert.match(LOGO_INNER, /fill="currentColor"/, 'paints in the inherited text colour');
  assert.match(LOGO_INNER, /var\(--logo-cut, #22314a\)/, 'gaps follow the surface it sits on');
  assert.ok(!/fill="#fff"/i.test(LOGO_INNER), 'no hard-coded white — it must work on any background');
});

test('the mark is used by the app shell and the sign-in screen', () => {
  const app = read('js/app.js');
  assert.match(app, /import \{ logoSvg \} from '\.\/logo\.js'/);
  assert.match(app, /logoSvg\(/, 'sidebar renders the mark');
  assert.ok(!/<span class="mark">A<\/span>/.test(app), 'the old letter-A placeholder is gone');

  const login = read('js/views/login.js');
  assert.match(login, /import \{ logoSvg \} from '\.\.\/logo\.js'/);
  assert.equal((login.match(/logoSvg\(/g) || []).length, 2, 'desktop + mobile lockups');
  assert.ok(!/mark-cut/.test(login), 'the old triangle mark is gone');
});

test('brand asset files exist and are valid SVG/PNG', () => {
  for (const f of ['brand/logo.svg', 'brand/logo-mono.svg', 'brand/icon.svg', 'brand/favicon.svg']) {
    const s = read(f);
    assert.match(s, /^<svg[\s\S]*<\/svg>\s*$/, `${f} is a complete svg`);
    assert.match(s, /viewBox=/, `${f} scales`);
  }
  for (const f of ['brand/logo.png', 'brand/icon-512.png', 'brand/icon-192.png']) {
    const buf = fs.readFileSync(path.join(PUBLIC, f));
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${f} is a real PNG`);
  }
});

test('index.html points at the brand favicon and social image', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/brand\/favicon\.svg"/);
  assert.match(html, /apple-touch-icon" href="\/brand\/icon-192\.png"/);
  assert.match(html, /og:image" content="\/brand\/logo\.png"/);
  assert.ok(!/data:image\/svg\+xml,%3Csvg/.test(html), 'the old inline data-URI icon is gone');
});

test('the logo tile colour is a token, fixed across themes', () => {
  const css = read('styles.css');
  assert.match(css, /--logo-navy: #22314a;/);
  assert.match(css, /\.brand \.logo \.mark[\s\S]{0,300}--logo-cut/, 'sidebar sets its own cut colour');
  assert.match(css, /\.auth-mark[^\n]*--logo-cut/, 'auth mark sets its own cut colour');
});
