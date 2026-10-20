/**
 * Stylesheet invariants. No browser is needed for these, and they guard the three
 * theming rules that are easy to break by accident:
 *   1. every var(--token) resolves to a declared custom property,
 *   2. the dark palette only applies on screen, so print/PDF stays light,
 *   3. the light palette in :root still carries the Anthroprime surface values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

/** Custom properties set from JS or an inline style attribute, not in CSS. */
const RUNTIME_VARS = new Set(['--mx', '--my', '--tilt-x', '--tilt-y', '--w', '--stagger']);

test('every var(--token) used in styles.css is declared', () => {
  const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const unresolved = [...used].filter((v) => !declared.has(v) && !RUNTIME_VARS.has(v));
  assert.deepEqual(unresolved, [], `undeclared tokens: ${unresolved.join(', ')}`);
  assert.ok(declared.size > 90, `expected a full token set, found ${declared.size}`);
});

test('dark palette is screen-scoped so printed output falls back to light', () => {
  const screenAt = css.indexOf('@media screen {');
  const darkAt = css.indexOf('[data-theme="dark"] {');
  assert.ok(screenAt > -1, '@media screen block present');
  assert.ok(darkAt > screenAt, 'the dark token block sits inside @media screen');
  assert.equal(css.indexOf('[data-theme="dark"] {', darkAt + 1), -1, 'exactly one dark token block');

  const printBlock = css.slice(css.indexOf('@media print'));
  assert.match(printBlock, /color-scheme: light !important/, 'print cancels the inline dark color-scheme');
});

test('light palette keeps the Anthroprime surface values', () => {
  const rootStart = css.indexOf(':root {');
  const rootBlock = css.slice(rootStart, css.indexOf('@media screen {'));
  const token = (name) => {
    const m = rootBlock.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    assert.ok(m, `${name} declared in :root`);
    return m[1].trim();
  };
  assert.equal(token('--card-bg'), '#faf9f7');
  assert.equal(token('--topbar-bg'), 'rgba(250, 249, 247, .96)');
  assert.equal(token('--surface'), '#faf9f7');
  assert.equal(token('--brand'), '#2e4080');
  assert.equal(token('--line-soft'), '#e8e5de');
});
