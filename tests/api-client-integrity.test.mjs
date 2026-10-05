import test from 'node:test';
import assert from 'node:assert/strict';
import { api, session, setUnauthorizedHandler, ApiError } from '../public/js/api.js';

test('API client preserves session identity and refuses unverified save acknowledgements', async (t) => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const values = new Map();
  globalThis.localStorage = {
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: k => values.delete(k),
  };
  let signouts = 0;
  setUnauthorizedHandler(() => { signouts++; });
  t.after(() => {
    Object.assign(globalThis, previous);
    setUnauthorizedHandler(() => {});
  });

  await t.test('a delayed 401 for an old token cannot sign out a newly signed-in account', async () => {
    session.token = 'old-session';
    let finish;
    globalThis.fetch = (_, options) => {
      assert.equal(options.headers.authorization, 'Bearer old-session');
      return new Promise(resolve => { finish = resolve; });
    };
    const pending = api('/auth/me');
    session.token = 'new-session';
    finish({ ok: false, status: 401, json: async () => ({ error: 'Expired' }) });
    await assert.rejects(pending, e => e.status === 401);
    assert.equal(session.token, 'new-session');
    assert.equal(signouts, 0);
  });

  await t.test('a failed anonymous sign-in cannot erase another tab’s signed-in session', async () => {
    session.token = null;
    let finish;
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = api('/auth/login', { method: 'POST', body: {} });
    session.token = 'other-tab-session';
    finish({ ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) });
    await assert.rejects(pending);
    assert.equal(session.token, 'other-tab-session');
    assert.equal(signouts, 0);
  });

  await t.test('401 for the current token still signs out', async () => {
    session.token = 'current-session';
    signouts = 0;
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Expired' }) });
    await assert.rejects(api('/auth/me'));
    assert.equal(session.token, null);
    assert.equal(signouts, 1);
  });

  await t.test('HTML or truncated JSON with HTTP 200 cannot acknowledge a save', async () => {
    session.token = 'live-session';
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Bad JSON'); } });
    await assert.rejects(api('/candidate/assessments/a/answers', { method: 'PUT', body: {} }),
      e => e instanceof ApiError && /invalid response/i.test(e.message));
    assert.equal(session.token, 'live-session');
  });

  await t.test('an intentionally empty HTTP 204 response remains supported', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('Empty'); } });
    assert.equal(await api('/auth/logout', { method: 'POST' }), null);
  });
});
