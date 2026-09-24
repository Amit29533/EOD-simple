/**
 * Automatic and manual allocation share one lock per candidate and track.
 *
 * Creating a candidate's portal login allocates their first paper
 * automatically, and an admin can also allocate one by hand. Both check for an
 * open paper, then insert one. The automatic path used to take no lock, so the
 * two could interleave: each saw no open paper, and the candidate held two
 * papers for the same track. These tests park one request inside its critical
 * section, at the question-bank read between that check and the insert, while
 * the other arrives. That makes the race deterministic instead of a matter of
 * timing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, USER_PASSWORD } from './helpers/world.mjs';

const OPEN = ['assigned', 'in_progress', 'submitted'];
// Longest time a request is given to show it is not waiting. Without the lock,
// the second request reaches its open-paper check within a few in-memory store
// calls.
const GRACE_MS = 250;

/**
 * Wraps the store so a test can park the next question-bank read, then wait on
 * named events: 'parked', 'check' (an open-paper check lists assessments), and
 * 'insert:<table>'.
 */
function instrument(store) {
  const real = { list: store.list, insert: store.insert };
  const events = [];
  const waiters = [];
  const log = (name) => {
    events.push(name);
    for (const w of waiters.filter((x) => x.name === name)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  let gate = null;
  store.list = async function list(table, ...rest) {
    if (gate && !gate.used && table === 'questions') {
      gate.used = true;
      log('parked');
      await gate.opened;
    }
    if (table === 'assessments') log('check');
    return real.list.call(this, table, ...rest);
  };
  store.insert = async function insert(table, ...rest) {
    const rec = await real.insert.call(this, table, ...rest);
    log(`insert:${table}`);
    return rec;
  };
  const next = (name) => new Promise((resolve) => waiters.push({ name, resolve }));
  return {
    events,
    next,
    /** Parks the next question-bank read; resolves once a request is parked there. */
    park() {
      let open;
      gate = { used: false, opened: new Promise((r) => { open = r; }) };
      gate.open = open;
      return next('parked');
    },
    release() { gate.open(); },
  };
}

const settlesWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms);
  const done = () => { clearTimeout(timer); resolve(true); };
  promise.then(done, done);
});

async function setup(t) {
  const w = await makeWorld({ t });
  const probe = instrument(w.store);
  const candidate = async (name) => w.expectOk(await w.call('POST', '/admin/candidates', {
    token: w.tok, body: { name, target_role_id: w.role.id },
  }), `candidate ${name}`);
  const createLogin = (cand, username) => w.call('POST', '/admin/users', {
    token: w.tok,
    body: {
      username, name: cand.name, role: 'candidate', password: USER_PASSWORD,
      candidate_id: cand.id, auto_allocate: true,
    },
  });
  const allocate = (cand) => w.call('POST', '/admin/assessments', {
    token: w.tok, body: { candidate_id: cand.id, role_id: w.role.id },
  });
  const openPapers = async (cand) => (await w.store.list('assessments', { candidate_id: cand.id }))
    .filter((a) => a.role_id === w.role.id && OPEN.includes(a.status));
  return { w, probe, candidate, createLogin, allocate, openPapers };
}

test('a manual allocation waits while an automatic one is mid-flight, then is refused', async (t) => {
  const { probe, candidate, createLogin, allocate, openPapers } = await setup(t);
  const cand = await candidate('Nisha Rao');

  const parked = probe.park();
  const loginP = createLogin(cand, 'nisha.rao');
  let manualP; let waited; let checkedEarly;
  try {
    await parked; // the automatic allocation has checked for a paper and is building one
    const mark = probe.events.length;
    manualP = allocate(cand);
    waited = !(await settlesWithin(manualP, GRACE_MS));
    checkedEarly = probe.events.slice(mark).includes('check');
  } finally {
    probe.release(); // before any assertion, so a failure never leaves a request parked
  }
  const [login, manual] = await Promise.all([loginP, manualP]);

  assert.equal(waited, true, 'the manual allocation must wait for the lock the automatic one holds');
  assert.equal(checkedEarly, false,
    'the manual allocation must not check for an open paper until the automatic one has inserted its paper');
  assert.equal(login.status, 201);
  assert.equal(login.body.auto_allocation.allocated, true);
  assert.equal(manual.status, 409);
  assert.equal(manual.body.error, 'This candidate already has an open assessment for that role.');

  const open = await openPapers(cand);
  assert.equal(open.length, 1, 'exactly one open paper for the track');
  assert.equal(open[0].id, login.body.auto_allocation.assessment_id);
});

test('an automatic allocation waits while a manual one is mid-flight, then reports the existing paper', async (t) => {
  const { probe, candidate, createLogin, allocate, openPapers } = await setup(t);
  const cand = await candidate('Kabir Shah');

  const parked = probe.park();
  const manualP = allocate(cand);
  let loginP; let waited; let checkedEarly;
  try {
    await parked; // the manual allocation has checked for a paper and is building one
    const mark = probe.events.length;
    const userSaved = probe.next('insert:users');
    loginP = createLogin(cand, 'kabir.shah');
    await userSaved; // past the password hash: the automatic allocation starts next
    waited = !(await settlesWithin(loginP, GRACE_MS));
    checkedEarly = probe.events.slice(mark).includes('check');
  } finally {
    probe.release();
  }
  const [manual, login] = await Promise.all([manualP, loginP]);

  assert.equal(waited, true, 'the automatic allocation must wait for the lock the manual one holds');
  assert.equal(checkedEarly, false,
    'the automatic allocation must not check for an open paper until the manual one has inserted its paper');
  assert.equal(manual.status, 201);
  assert.equal(login.status, 201, 'the login is still created');
  const auto = login.body.auto_allocation;
  assert.equal(auto.allocated, false);
  assert.match(auto.reason, /already has an open .+ assessment/);
  assert.equal(auto.assessment_id, manual.body.id, 'the refusal points at the paper that won');

  const open = await openPapers(cand);
  assert.equal(open.length, 1, 'exactly one open paper for the track');
  assert.equal(open[0].id, manual.body.id);
});

test('the lock is per candidate: another candidate is allocated while one is mid-flight', async (t) => {
  const { probe, candidate, createLogin, allocate, openPapers } = await setup(t);
  const first = await candidate('Meera Iyer');
  const second = await candidate('Dev Malhotra');

  const parked = probe.park();
  const loginP = createLogin(first, 'meera.iyer');
  let otherP; let otherDone;
  try {
    await parked;
    otherP = allocate(second);
    otherDone = await settlesWithin(otherP, 2000);
  } finally {
    probe.release();
  }
  const [login, other] = await Promise.all([loginP, otherP]);

  assert.equal(otherDone, true, 'a different candidate must not wait on this candidate’s allocation');
  assert.equal(other.status, 201);
  assert.equal(login.body.auto_allocation.allocated, true);
  assert.equal((await openPapers(first)).length, 1);
  assert.equal((await openPapers(second)).length, 1);
});
