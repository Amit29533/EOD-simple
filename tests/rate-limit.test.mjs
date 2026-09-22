/**
 * Request budgets are per client, not per address.
 *
 * The self-hosted server used to allow 200 API requests a minute PER ADDRESS.
 * An exam room is many candidates behind one NAT address, and the hall's own
 * traffic — measured by driving the real exam screen: 4.25 API requests per
 * 30-second objective question (lock, refetch, a draft or two) — is 13–17
 * requests a minute per seat. The budget was full at 11–15 seats; past that,
 * every lock and draft from the whole room was refused for the rest of the
 * minute while the exam clocks kept running. A bearer token now draws on its
 * own budget; the address only carries the anonymous traffic and two high
 * ceilings that bound a runaway client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimiter, limitsFromEnv, bearerOf, PRODUCTION_LIMITS, DEVELOPMENT_LIMITS, WINDOW_MS,
} from '../src/api/rate-limit.mjs';

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
};
const ROOM_IP = '203.0.113.10';

test('a 40-seat room behind one address, each seat at exam pace, is never refused', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  const seats = Array.from({ length: 40 }, (_, i) => `session-token-${i}`);
  let refused = 0;
  // Each seat signs in (a public route: the address's anonymous budget,
  // whatever token it carries) and its token is accepted by the app.
  for (const token of seats) {
    if (rl.check({ ip: ROOM_IP, isApi: true, anonymous: true })) refused += 1;
    rl.accepted({ token });
  }
  // 17 API requests per seat per minute (a brisk MCQ pace with autosave),
  // spread over the minute, plus each seat's cold page load (17 static files).
  for (let n = 0; n < seats.length * 17; n += 1) if (rl.check({ ip: ROOM_IP, isApi: false })) refused += 1;
  for (let round = 0; round < 17; round += 1) {
    for (const token of seats) if (rl.check({ ip: ROOM_IP, isApi: true, token })) refused += 1;
    c.tick(3_500);
  }
  assert.equal(refused, 0, 'a room at exam pace must never see a 429');
});

test('the same room on the old per-address budget would have been refused (the regression this pins)', () => {
  // 40 seats × 17 API requests = 680 in a minute: 3.4× the old 200/address cap.
  const c = clock();
  const old = createRateLimiter({ limits: { ...PRODUCTION_LIMITS, addressApi: 200 }, now: c.now });
  let refused = 0;
  for (let round = 0; round < 17; round += 1) {
    for (let seat = 0; seat < 40; seat += 1) if (old.check({ ip: ROOM_IP, isApi: true, token: `t${seat}` })) refused += 1;
  }
  assert.ok(refused >= 480, `the old budget refused most of the room (${refused} of 680)`);
});

test('one session over its budget is refused, with the seconds left on its window, and no one else is', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  for (let i = 0; i < PRODUCTION_LIMITS.session; i += 1) assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'runaway' }), null);
  c.tick(20_000);
  const refused = rl.check({ ip: ROOM_IP, isApi: true, token: 'runaway' });
  assert.deepEqual(refused, { budget: 'session', retryAfter: 40 }, 'the 201st request in the minute is refused, 40 s left');
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'neighbour' }), null, 'the seat next to it is unaffected');
  assert.equal(rl.check({ ip: ROOM_IP, isApi: false }), null, 'and so is a static file');
  c.tick(40_000);
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'runaway' }), null, 'the window turned over');
});

test('anonymous API traffic is budgeted per address; a session on that address is not charged for it', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  rl.accepted({ token: 'seat-1' });
  for (let i = 0; i < PRODUCTION_LIMITS.anon; i += 1) assert.equal(rl.check({ ip: ROOM_IP, isApi: true }), null);
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true })?.budget, 'anon');
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'seat-1' }), null, 'a signed-in seat still works');
  assert.equal(rl.check({ ip: '198.51.100.7', isApi: true }), null, 'another address has its own anonymous budget');
});

test('the public routes draw on the anonymous budget whatever token they carry', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  let i = 0;
  let refused = null;
  // A sign-in flood that attaches a fresh made-up bearer token to every request.
  while (!refused && i < 10_000) { refused = rl.check({ ip: ROOM_IP, isApi: true, token: `bogus-${i}`, anonymous: true }); i += 1; }
  assert.equal(refused?.budget, 'anon');
  assert.equal(i, PRODUCTION_LIMITS.anon + 1, 'held to the anonymous budget, not to a budget per token');
  rl.accepted({ token: 'seat-1' });
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'seat-1' }), null, 'an accepted session on that address still works');
});

test('a token earns its own budget only once the app has accepted it; rejected tokens are anonymous traffic', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  rl.accepted({ token: 'real-seat' });
  // A flood on protected routes rotating made-up tokens: the app answers 401
  // to each, and each is charged to the address's anonymous budget.
  let admitted = 0;
  let refused = null;
  for (let i = 0; i < 10_000 && !refused; i += 1) {
    refused = rl.check({ ip: ROOM_IP, isApi: true, token: `bogus-${i}` });
    if (!refused) { admitted += 1; rl.rejected({ ip: ROOM_IP }); }
  }
  assert.equal(admitted, PRODUCTION_LIMITS.anon, 'no more unknown-token requests than anonymous ones');
  assert.equal(refused?.budget, 'anon');
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'real-seat' }), null, 'the accepted session on the same address is untouched');
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'new-seat' })?.budget, 'anon', 'a session not yet seen waits with the anonymous traffic');
  c.tick(WINDOW_MS);
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 'new-seat' }), null, 'until the window turns over');
  rl.accepted({ token: 'new-seat' });
  c.tick(11 * 60_000);
  rl.sweep();
  assert.equal(rl.size, 0, 'idle tokens are forgotten with the windows');
});

test('the address ceilings hold a client rotating made-up tokens, and a static-file flood', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  let i = 0;
  let refused = null;
  while (!refused && i < 10_000) { refused = rl.check({ ip: ROOM_IP, isApi: true, token: `bogus-${i}` }); i += 1; }
  assert.equal(refused?.budget, 'addressApi');
  assert.equal(i, PRODUCTION_LIMITS.addressApi + 1, 'a fresh token per request does not escape the per-address API ceiling');

  const rl2 = createRateLimiter({ limits: PRODUCTION_LIMITS, now: c.now });
  for (let k = 0; k < PRODUCTION_LIMITS.addressTotal; k += 1) assert.equal(rl2.check({ ip: ROOM_IP, isApi: false }), null);
  assert.equal(rl2.check({ ip: ROOM_IP, isApi: false })?.budget, 'addressTotal');
});

test('refused requests keep counting (retrying inside the window does not reset it) and sweep() forgets old windows', () => {
  const c = clock();
  const rl = createRateLimiter({ limits: { ...PRODUCTION_LIMITS, session: 3 }, now: c.now });
  for (let i = 0; i < 3; i += 1) rl.check({ ip: ROOM_IP, isApi: true, token: 't' });
  assert.ok(rl.check({ ip: ROOM_IP, isApi: true, token: 't' }));
  c.tick(WINDOW_MS - 1_000);
  assert.ok(rl.check({ ip: ROOM_IP, isApi: true, token: 't' }), 'still refused a second before the window ends');
  c.tick(2_000);
  assert.equal(rl.check({ ip: ROOM_IP, isApi: true, token: 't' }), null);
  assert.ok(rl.size > 0);
  c.tick(WINDOW_MS + 1);
  rl.sweep();
  assert.equal(rl.size, 0, 'expired windows are dropped');
});

test('limits come from the environment when set, and are sane by default', () => {
  assert.deepEqual(limitsFromEnv({}), PRODUCTION_LIMITS);
  assert.deepEqual(limitsFromEnv({ RATE_SESSION_PER_MIN: '50', RATE_ADDRESS_API_PER_MIN: '9000', RATE_ANON_PER_MIN: 'nope', RATE_ADDRESS_TOTAL_PER_MIN: '-1' }),
    { ...PRODUCTION_LIMITS, session: 50, addressApi: 9000 }, 'bad values fall back per key');
  assert.deepEqual(limitsFromEnv({}, DEVELOPMENT_LIMITS), DEVELOPMENT_LIMITS);
  // A single candidate flat out (a draft every 1.5 s through a two-minute open
  // answer, plus locks, refetches and integrity beacons) stays well inside one
  // session's budget, and a room of 140 inside the address ceiling.
  assert.ok(PRODUCTION_LIMITS.session >= 120);
  assert.ok(PRODUCTION_LIMITS.addressApi >= 140 * 17);
  assert.ok(PRODUCTION_LIMITS.addressTotal > PRODUCTION_LIMITS.addressApi);
});

test('bearerOf reads the token the app itself would use', () => {
  assert.equal(bearerOf({ authorization: 'Bearer abc.def' }), 'abc.def');
  assert.equal(bearerOf({ Authorization: 'bearer  xyz ' }), 'xyz');
  assert.equal(bearerOf({ authorization: 'Basic abc' }), '');
  assert.equal(bearerOf({}), '');
});
