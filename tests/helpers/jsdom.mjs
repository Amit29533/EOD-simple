/**
 * Shared jsdom loader for the UI suites.
 *
 * jsdom is an *optional* dependency: the server never needs it and the API
 * suites run without it, so a checkout that simply does not have it skips the
 * DOM tests with an install hint. That is the only case that may skip.
 *
 * "Installed but cannot load" is a different situation and must not go green.
 * jsdom releases drop Node lines aggressively (30.x needs Node 22.22+, while
 * this project deploys on Node 20), and a release that does not support the
 * running Node throws from inside its dependency tree at import time. Treating
 * that as "not installed" once hid 80 tests — 15% of the suite — behind a
 * misleading skip message on the very runtime the app ships on. So when jsdom
 * is present but fails to import, this module throws: every UI suite then
 * fails at load with the real error and the fix, instead of silently passing.
 *
 * Usage in a test file:
 *   import { JSDOM, SKIP } from './helpers/jsdom.mjs';
 *   test('renders', { skip: SKIP }, () => { const dom = new JSDOM(...); });
 */
import { createRequire } from 'node:module';

export const INSTALL_HINT = 'jsdom not installed (npm install, or npm i --no-save jsdom)';

let loaded = null;
let skip = INSTALL_HINT;

const isMissingJsdom = (err) =>
  err?.code === 'ERR_MODULE_NOT_FOUND' && /['"]jsdom['"]/.test(String(err.message));

try {
  ({ JSDOM: loaded } = await import('jsdom'));
  skip = false;
} catch (err) {
  if (!isMissingJsdom(err)) {
    let installed = 'unknown version';
    let engines = '';
    try {
      const pkg = createRequire(import.meta.url)('jsdom/package.json');
      installed = pkg.version;
      engines = pkg.engines?.node ? ` (it declares node ${pkg.engines.node})` : '';
    } catch { /* package.json unreadable: report what we know */ }
    throw new Error(
      `jsdom ${installed} is installed but failed to load on Node ${process.version}${engines}: ` +
        `${err?.message || err}. Install a jsdom release that supports this Node version ` +
        '(see optionalDependencies in package.json), or remove jsdom to skip the UI suites.',
      { cause: err },
    );
  }
}

export const JSDOM = loaded;
export const SKIP = skip;
