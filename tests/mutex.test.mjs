import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLock } from '../src/api/mutex.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('holders of the same key run one at a time, in call order', async () => {
  const order = [];
  const job = (n) => withLock('a', async () => {
    order.push(`start-${n}`);
    await tick();
    order.push(`end-${n}`);
    return n;
  });
  const out = await Promise.all([job(1), job(2), job(3)]);
  assert.deepEqual(out, [1, 2, 3], 'results must resolve to each caller');
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3'],
    'same-key bodies must not interleave');
});

test('different keys run concurrently', async () => {
  let peak = 0;
  let live = 0;
  const job = (k) => withLock(k, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await tick();
    live -= 1;
  });
  await Promise.all([job('x'), job('y')]);
  assert.equal(peak, 2, 'distinct keys must not block each other');
});

test('a throwing holder does not jam the key, and the error reaches its caller', async () => {
  const boom = withLock('b', async () => { throw new Error('boom'); });
  await assert.rejects(boom, /boom/);
  const after = await withLock('b', async () => 'recovered');
  assert.equal(after, 'recovered', 'the chain must continue after a rejection');
});

test('return values (including falsy ones) pass through untouched', async () => {
  assert.equal(await withLock('c', async () => 0), 0);
  assert.equal(await withLock('c', async () => null), null);
  assert.deepEqual(await withLock('c', async () => ({ status: 200 })), { status: 200 });
});
