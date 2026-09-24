/**
 * Shared in-process world for the point-of-view suites (pov-*.test.mjs).
 *
 * Each world is a fresh JSON store in a temp directory with the real app on
 * top: an admin, one track with two weighted competencies (60/40), a small
 * question bank (MCQs plus open questions), and helpers to create candidate
 * and assessor users and sign them in. Requests go through `createApp`, the
 * same entry point both transports use, so every route guard, lock, and
 * error-to-status mapping is exercised just as a browser would reach it.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../../src/storage/json-file.mjs';
import { createApp } from '../../src/api/app.mjs';
import { hashPassword } from '../../src/core/passwords.mjs';

export const ADMIN_PASSWORD = 'Admin-pass-123';
export const USER_PASSWORD = 'User-pass-123';

/**
 * @param {object} [opts]
 * @param {number} [opts.mcq=3]   objective questions on the track (4 points each)
 * @param {number} [opts.open=2]  open questions on the track (5 points each)
 * @param {import('node:test').TestContext} [opts.t]  removes the temp dir after the test
 */
export async function makeWorld({ mcq = 3, open = 2, t } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-pov-'));
  if (t) t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);

  const call = (method, p, { token, body, query, headers } = {}) => app({
    method, path: p, query: query || {},
    headers: { ...(headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const login = async (username, password = USER_PASSWORD) => {
    const r = await call('POST', '/auth/login', { body: { username, password } });
    if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  };

  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', password_hash: hashPassword(ADMIN_PASSWORD), active: true,
  });
  const tok = await login('admin', ADMIN_PASSWORD);
  const expectOk = (r, what) => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  const role = expectOk(await call('POST', '/admin/roles', {
    token: tok, body: { key: 'pov-track', name: 'POV Track', technology: 'Testing' },
  }), 'create role');
  const c1 = expectOk(await call('POST', '/admin/competencies', {
    token: tok, body: { role_id: role.id, name: 'Architecture', weight: 60, target_level: 4 },
  }), 'competency 1');
  const c2 = expectOk(await call('POST', '/admin/competencies', {
    token: tok, body: { role_id: role.id, name: 'Advisory', weight: 40, target_level: 3 },
  }), 'competency 2');

  const questions = [];
  for (let i = 0; i < mcq; i += 1) {
    questions.push(expectOk(await call('POST', '/admin/questions', {
      token: tok,
      body: {
        role_id: role.id, competency_id: i % 2 ? c2.id : c1.id, type: 'mcq_single',
        prompt: `Objective question number ${i + 1}: which option is correct?`,
        options: [{ id: 'a', label: 'Right' }, { id: 'b', label: 'Wrong' }], correct_option_ids: ['a'], points: 4,
      },
    }), `mcq ${i}`));
  }
  for (let i = 0; i < open; i += 1) {
    questions.push(expectOk(await call('POST', '/admin/questions', {
      token: tok,
      body: {
        role_id: role.id, competency_id: i % 2 ? c2.id : c1.id, type: 'text',
        prompt: `Open scenario number ${i + 1}: explain your approach.`, rubric: 'Names the trade-offs.', points: 5,
      },
    }), `open ${i}`));
  }

  /** An assessor account, signed in. */
  const assessorUser = async (username) => {
    const user = expectOk(await call('POST', '/admin/users', {
      token: tok, body: { username, name: `Assessor ${username}`, role: 'assessor', password: USER_PASSWORD },
    }), `assessor ${username}`);
    return { user, token: await login(username) };
  };

  /**
   * A candidate record plus its portal user, signed in. With `allocate`
   * (the default) the user is created with auto-allocation on, so the
   * candidate already holds a paper, as after a normal admin onboarding.
   */
  const candidateUser = async (username, { allocate = true, name } = {}) => {
    const cand = expectOk(await call('POST', '/admin/candidates', {
      token: tok, body: { name: name || `Candidate ${username}`, target_role_id: role.id },
    }), `candidate ${username}`);
    const made = expectOk(await call('POST', '/admin/users', {
      token: tok,
      body: {
        username, name: name || username, role: 'candidate', password: USER_PASSWORD,
        candidate_id: cand.id, auto_allocate: allocate,
      },
    }), `candidate user ${username}`);
    return {
      cand, user: made, token: await login(username),
      assessmentId: made.auto_allocation?.assessment_id || null,
    };
  };

  /** Answers every question on a paper (MCQs right, open ones typed) and submits it. */
  const walkAndSubmit = async (token, assessmentId, { mcqAnswer = 'a' } = {}) => {
    const open = await call('GET', `/candidate/assessments/${assessmentId}`, { token });
    if (open.status !== 200) throw new Error(`open exam: ${open.status} ${JSON.stringify(open.body)}`);
    for (;;) {
      const cur = await call('GET', `/candidate/assessments/${assessmentId}`, { token });
      const q = cur.body.current_question;
      if (!q || cur.body.exam.complete) break;
      const answer = q.type === 'text'
        ? { text: 'A considered answer naming trade-offs.', transcript: 'spoken words' }
        : mcqAnswer;
      const r = await call('POST', `/candidate/assessments/${assessmentId}/next`, { token, body: { answer, question_id: q.id } });
      if (r.status !== 200) throw new Error(`next: ${r.status} ${JSON.stringify(r.body)}`);
      if (r.body.complete) break;
    }
    const sub = await call('POST', `/candidate/assessments/${assessmentId}/submit`, { token, body: { answers: {} } });
    if (sub.status !== 200) throw new Error(`submit: ${sub.status} ${JSON.stringify(sub.body)}`);
    return sub.body;
  };

  /** Assigns an assessment to an assessor as the admin would. */
  const assign = async (assessmentId, assessorId) => expectOk(await call('PATCH', `/admin/assessments/${assessmentId}`, {
    token: tok, body: { assessor_id: assessorId },
  }), 'assign assessor');

  /** As the assessor: score every open answer `score`/5, then finalize. */
  const scoreAndFinalize = async (token, assessmentId, { score = 4, comment = 'Clear trade-offs.' } = {}) => {
    const d = expectOk(await call('GET', `/assessor/assessments/${assessmentId}`, { token }), 'assessor detail');
    const scores = d.questions.filter((q) => q.type === 'text').map((q) => ({ question_id: q.id, score, comment }));
    if (scores.length) {
      expectOk(await call('PUT', `/assessor/assessments/${assessmentId}/scores`, { token, body: { scores } }), 'save scores');
    }
    return expectOk(await call('POST', `/assessor/assessments/${assessmentId}/finalize`, { token }), 'finalize');
  };

  return {
    tmp, store, app, call, login, tok, role, c1, c2, questions,
    assessorUser, candidateUser, walkAndSubmit, assign, scoreAndFinalize, expectOk,
  };
}
